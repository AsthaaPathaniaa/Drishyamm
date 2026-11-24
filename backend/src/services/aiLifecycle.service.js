const axios = require('axios');

const config = require('../config/env');
const logger = require('../config/logger');
const { Camera, CameraGroup } = require('../models');
const { getAiEntitledUserIds } = require('./entitlements.service');
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
  return ai.enabled === true && ai.mode !== 'off';
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
  return (camera.settings?.ai || {}).faceRecognition !== false;
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

// The owner's org JWT, like ai.controller's reconcileAiRuntime: without it the
// AI files the camera under its shared default tenant, and everything the
// camera produces (sightings, journey points, the investigation index) is
// invisible to that organisation's searches, which carry the org tenant.
async function postAiForm(path, camera) {
  const { aiAuthHeader } = require('../utils/aiTenant');
  const body = new URLSearchParams({ monitor_id: camera.monitorId });
  const { data } = await axios.post(`${config.aiServiceUrl}${path}`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...aiAuthHeader({ id: camera.userId }) },
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
          await postAiForm('/set-camera', camera);
          started += 1;
          if (_paused.delete(camera.monitorId)) {
            logger.info('aiLifecycle: playback ended, detection resumed', { monitorId: camera.monitorId });
          }
        } else if (!enabled && isRunning && (stopUnselected || yielding)) {
          await postAiForm('/stop-camera', camera);
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
  _internals: { yieldsToPlayback, paused: _paused },
};
