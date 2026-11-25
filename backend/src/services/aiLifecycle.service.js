const axios = require('axios');

const config = require('../config/env');
const logger = require('../config/logger');
const { Camera, CameraGroup } = require('../models');
const { getAiEntitledUserIds } = require('./entitlements.service');
const { flag } = require('./aiFlags');
const { recordAiClock } = require('./aiClockSkew');
const nvrLoad = require('./nvrLoad.service');

const RECONCILE_INTERVAL_MS = Number(process.env.AI_LIFECYCLE_RECONCILE_MS || 15000);
// While someone replays or exports footage from an NVR, detection on that
// NVR's cameras pauses and resumes when they finish. A recorder's uplink is
// small (lab NVR, 2026-11-21: ~1-1.4 Mbit/s in total) and one AI main stream
// takes ~0.5 Mbit/s of it, leaving recorded playback at half real time.
// AI_YIELD_TO_PLAYBACK=0 keeps detection running through playback.
const YIELD_TO_PLAYBACK = process.env.AI_YIELD_TO_PLAYBACK !== '0';
const EVENT_DEBOUNCE_MS = 300;

let _timer = null;
let _running = false;
let _again = false;          // a reconcile was asked for while one was running
let _eventTimer = null;
const _paused = new Set();   // monitorIds we stopped for playback (for logging)

/**
 * The MASTER switch: is this camera used by AI at all?
 *
 * Every AI feature is gated on this -- face recognition, head count, activity
 * monitoring and zone-guard. It is deliberately NOT the face-recognition test;
 * see faceRecognitionOn below.
 */
function isAiEnabled(camera) {
  const ai = camera.settings?.ai || {};
  // `flag` rather than `=== true`, so what absent means lives in ONE table
  // (aiFlags.js) instead of being restated by each reader. Identical for every
  // stored value -- see that file's docblock and its tests. `mode` stays a
  // separate test: it is not a boolean, and 'off' is a third state.
  return flag(ai, 'enabled') && ai.mode !== 'off';
}

/**
 * Is FACE RECOGNITION wanted on this camera?
 *
 * One feature under the master, alongside head count and the rest. ABSENT MEANS
 * ON: every camera created before this flag existed carries no key and must go
 * on recognising faces exactly as it did, with no migration.
 *
 * Switching it off while the master stays on is the anonymous-counting case --
 * heads are counted, no face is matched. Before the split that was impossible,
 * because the only way to stop the face pipeline was to switch the master off,
 * which stopped the counting with it.
 */
function faceRecognitionOn(camera) {
  return flag(camera.settings?.ai, 'faceRecognition');
}

/**
 * ON MEANS ON: the `settings.ai` a camera needs for ONE feature to actually
 * run, and for nothing else to start.
 *
 * Every feature is gated on the master switch. But the switch an operator is
 * given for a feature is the feature's own toggle -- the tick on the Head
 * Count page (`settings.headcount.enabled`), the tick on the activity page
 * (`settings.ai.activityMonitoring`) -- and those toggles used to write their
 * own flag and nothing else. So a camera could be ticked for a feature and
 * excluded by the master switch at the same time: the feature never started,
 * and no page said why.
 *
 * Turning the master on IS what the toggle means -- "use this camera for AI,
 * for this" -- so the endpoint that takes the toggle does it. One rule for
 * every feature toggle, which is the point: a toggle that reads ON must mean
 * the thing is running.
 *
 * THAT FEATURE ONLY, and that is the whole care taken here. Switching the
 * master on is switching on the thing every feature hangs off, so each one is
 * checked against what this returns (one test per feature):
 *
 *   face          `faceRecognitionOn` -- ABSENT MEANS ON, so it is set
 *                 explicitly FALSE. This is the anonymous case the
 *                 master/face split was built for: people detected, no face
 *                 matched. Left absent, ticking a camera for counting would
 *                 start matching faces against the org's gallery and spend a
 *                 face licence -- not asked for, and not undone by unticking.
 *   activity      `activityMonitoring` -- absent, so off unless its own
 *                 toggle is what brought us here.
 *   zone-guard    `zoneBodyDetection` -- absent, so off, likewise.
 *   head count    `settings.headcount.enabled`, written by its own endpoint.
 *
 * A camera whose master is ALREADY on is not passed through here at all: its
 * settings are its own and the feature needs nothing changed. Turning a
 * feature OFF never comes here either -- other features hang off the master,
 * and unticking one is not a request to stop them.
 *
 * An explicit `faceRecognition: true` on a camera whose master is OFF is
 * overridden rather than honoured. Nothing was running, honouring it would
 * spend a face licence that can be REFUSED -- failing a toggle the feature's
 * page cannot act on -- and turning it back on in Camera Setup is one switch,
 * additively.
 *
 * Does NOT reconcile the face runtime: with face off the reconcile loop does
 * not want this camera (`isAiEnabled && faceRecognitionOn`), so starting it
 * here would be a start followed at once by a stop. Each feature's own service
 * reads the flag on its own registry poll.
 */
function masterOnForFeature(previousAi = {}, now = new Date().toISOString()) {
  const prev = previousAi || {};
  return {
    ...prev,
    enabled: true,
    // A stored mode is kept unless it is the off state we are leaving.
    mode: prev.mode && prev.mode !== 'off' ? prev.mode : 'continuous',
    faceRecognition: false,
    updatedAt: now,
    createdAt: prev.createdAt || now,
    disabledAt: null,
    lastError: null,
  };
}

/**
 * Said where the toggle was, when the toggle also switched the master on.
 *
 * Both halves matter. The first is why the camera's AI is suddenly on; the
 * second is what stops that reading as a privacy surprise.
 */
function aiTurnedOnFor(what) {
  return `This camera's AI was switched on so it can be ${what}. It detects people only `
    + '— faces are not matched. Turn on face recognition in Camera Setup → AI Detection '
    + 'if you want that too.';
}

const AI_TURNED_ON_FOR_COUNTING = aiTurnedOnFor('counted');
const AI_TURNED_ON_FOR_ACTIVITY = aiTurnedOnFor('monitored for activity');

/**
 * The code a refusal carries when a feature cannot start until someone agrees
 * to switch the camera's AI on.
 *
 * ASKED, NOT REPORTED. An earlier version of this switched the master on by
 * itself and said so afterwards, which made the feature work but took a
 * decision that is not the endpoint's to take: using a camera for AI at all is
 * a privacy and a cost decision, and "I ticked counting" is not the same
 * sentence as "yes, run AI on this camera". Reporting it after the fact leaves
 * an operator reading about a change they did not choose -- the same class of
 * fault as doing it silently, one step quieter.
 *
 * So the server refuses, names what it would do, and waits. `enableAi: true`
 * on the retry is the consent. The UI asks in a dialog before it ever sends;
 * this is what makes it impossible for ANY caller -- that dialog, Zone Setup,
 * a script, a future page -- to turn a camera's AI on without someone saying
 * so.
 */
const AI_CONSENT_REQUIRED = 'AI_CONSENT_REQUIRED';

/** What to ask, when a feature needs the master switch on first. */
function aiConsentQuestion(what, cameraName = 'this camera') {
  return `${cameraName} has AI switched off, so it cannot be ${what} yet. `
    + 'Switch AI on for it? It will detect people only — faces are not matched, '
    + 'and no other AI feature is started.';
}

async function getRuntime() {
  try {
    const sentAt = Date.now();
    const { data, headers } = await axios.get(`${config.aiServiceUrl}/status`, { timeout: 5000 });
    // A clock reading off the poll we already make; it must never cost the
    // reconcile, so a bad header is simply skipped.
    try { recordAiClock(headers?.date, sentAt, Date.now()); } catch { /* measurement only */ }
    return data?.cameras || {};
  } catch (err) {
    logger.warn('aiLifecycle: AI status unavailable', { error: err.message });
    return null;
  }
}

async function postAiForm(path, monitorId) {
  const body = new URLSearchParams({ monitor_id: monitorId });
  const { data } = await axios.post(`${config.aiServiceUrl}${path}`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 12000,
  });
  return data;
}

/** True while playback holds the NVR this camera streams from. */
function yieldsToPlayback(camera) {
  if (!YIELD_TO_PLAYBACK) return false;
  return [camera.host, camera.group?.host].some((h) => h && nvrLoad.interactiveActive(h, camera.userId ?? null));
}

async function reconcile({ stopUnselected = true } = {}) {
  if (_running) { _again = true; return; }
  _running = true;
  try {
    const runtime = await getRuntime();
    if (!runtime) return;

    // Owners whose current plan includes AI. A Basic-VMS / downgraded / expired
    // account is absent here, so its cameras are treated as AI-off below.
    const aiUserIds = await getAiEntitledUserIds();

    const cameras = await Camera.findAll({
      attributes: ['id', 'monitorId', 'name', 'settings', 'userId', 'host'],
      include: [{ model: CameraGroup, as: 'group', attributes: ['host'], required: false }],
      order: [['createdAt', 'ASC']],
    });

    let started = 0;
    let stopped = 0;

    for (const camera of cameras) {
      // FOUR conditions now, from two independent changes that compose.
      //
      // `ai.enabled` is the MASTER switch -- "use this camera for AI at all" --
      // and every AI feature is gated on it. But this loop starts one specific
      // thing: the FACE pipeline. While face AI was the only consumer of the
      // master, the two meant the same and one flag served both. It no longer
      // can: with the master governing head count, zones and activity too,
      // reading it here as "run face recognition" would make it impossible to
      // count people without recognising them -- which is exactly what
      // "Anonymous counting only" promises the operator. So face recognition
      // has its own flag; absent means ON, so every camera that existed before
      // the split behaves exactly as it did.
      //
      // A downgrade to Basic drops the owner from aiUserIds, so this loop
      // /stop-camera's their orchestrators within one reconcile even if
      // settings.ai.enabled is still stale-true.
      //
      // `wanted` is the standing intent; `yielding` is the momentary override
      // while footage is replayed from this camera's recorder. Keeping them
      // apart is what lets detection RESUME afterwards: a camera that is
      // merely yielding is still wanted, so the next reconcile restarts it,
      // whereas one whose flag is off must stay stopped.
      const wanted = isAiEnabled(camera)
        && faceRecognitionOn(camera)
        && aiUserIds.has(camera.userId);
      const yielding = wanted && yieldsToPlayback(camera);
      const enabled = wanted && !yielding;
      const isRunning = runtime[camera.monitorId]?.running === true;
      try {
        if (enabled && !isRunning) {
          await postAiForm('/set-camera', camera.monitorId);
          started += 1;
          if (_paused.delete(camera.monitorId)) {
            logger.info('aiLifecycle: playback ended, detection resumed', { monitorId: camera.monitorId });
          }
        } else if (!enabled && isRunning && (stopUnselected || yielding)) {
          await postAiForm('/stop-camera', camera.monitorId);
          stopped += 1;
          if (yielding) {
            _paused.add(camera.monitorId);
            logger.info('aiLifecycle: detection paused while footage is replayed from its NVR', {
              monitorId: camera.monitorId,
            });
          }
        } else if (enabled) {
          _paused.delete(camera.monitorId);
        }
      } catch (err) {
        logger.warn('aiLifecycle: camera reconcile failed', {
          monitorId: camera.monitorId,
          enabled,
          error: err.message,
        });
      }
    }

    if (started || stopped) {
      logger.info('aiLifecycle: reconciled camera runtime', { started, stopped });
    }

    // The activity monitor, re-stated on the same tick and for the same reason.
    // It is the one AI service that had no loop: its camera set was pushed once
    // per toggle, a failure was a log line, and nothing ever re-stated it -- so
    // a toggle made while it was restarting was lost for good, a backend
    // restart never re-sent the set, and changing a camera's AI switch or
    // losing an AI plan never reached it at all.
    //
    // Loaded here rather than at module scope: activityPush depends on the
    // feature selectors, which depend on this module for isAiEnabled, and a
    // top-level require would close that circle.
    try {
      // eslint-disable-next-line global-require
      await require('./activityPush.service').pushActivityCameras();
    } catch (err) {
      // pushActivityCameras does not throw; this is belt and braces so an
      // unexpected failure can never stop the face reconcile that precedes it.
      logger.warn('aiLifecycle: activity reconcile failed', { error: err.message });
    }
  } finally {
    _running = false;
    if (_again) { _again = false; setImmediate(() => reconcile({ stopUnselected }).catch(() => {})); }
  }
}

// Playback started or ended on an NVR: reconcile now, not at the next tick.
function onNvrEvent() {
  if (_eventTimer) return;
  _eventTimer = setTimeout(() => {
    _eventTimer = null;
    reconcile({ stopUnselected: true }).catch((err) => {
      logger.warn('aiLifecycle: reconcile after playback change failed', { error: err.message });
    });
  }, EVENT_DEBOUNCE_MS);
  _eventTimer.unref?.();
}

function start() {
  if (_timer) return;
  const tick = () => reconcile({ stopUnselected: true }).catch((err) => {
    logger.warn('aiLifecycle: reconcile loop failed', { error: err.message });
  });
  _timer = setInterval(tick, RECONCILE_INTERVAL_MS);
  setTimeout(tick, 1000);
  setTimeout(tick, 8000);
  if (YIELD_TO_PLAYBACK) {
    nvrLoad.events.on('interactive', onNvrEvent);
    nvrLoad.events.on('released', onNvrEvent);
  }
  logger.info('aiLifecycle: started', { intervalMs: RECONCILE_INTERVAL_MS });
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  nvrLoad.events.off('interactive', onNvrEvent);
  nvrLoad.events.off('released', onNvrEvent);
}

module.exports = {
  reconcile,
  start,
  stop,
  // Exported so every service that has to ask "is this camera's AI on?" asks
  // it the same way. The zone-guard selector (internal.routes.js) is the first
  // other caller; restating the test there would let the two drift, and a
  // camera the operator switched off being watched anyway is the whole defect
  // that selector exists to fix.
  isAiEnabled,
  // The face-recognition half of what `ai.enabled` used to mean on its own.
  faceRecognitionOn,
  // Turning the master ON for one feature, without turning anything else on.
  // One rule for every feature toggle: ON means the thing is running.
  masterOnForFeature,
  aiTurnedOnFor,
  AI_TURNED_ON_FOR_COUNTING,
  AI_TURNED_ON_FOR_ACTIVITY,
  // Switching the master on is ASKED FOR, not reported afterwards.
  AI_CONSENT_REQUIRED,
  aiConsentQuestion,
  _internals: { yieldsToPlayback, paused: _paused },
};
