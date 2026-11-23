const axios = require('axios');

const config = require('../config/env');
const logger = require('../config/logger');
const { Camera } = require('../models');
const { getAiEntitledUserIds } = require('./entitlements.service');
const { recordAiClock } = require('./aiClockSkew');

const RECONCILE_INTERVAL_MS = Number(process.env.AI_LIFECYCLE_RECONCILE_MS || 15000);

let _timer = null;
let _running = false;

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

async function postAiForm(path, monitorId) {
  const body = new URLSearchParams({ monitor_id: monitorId });
  const { data } = await axios.post(`${config.aiServiceUrl}${path}`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 12000,
  });
  return data;
}

async function reconcile({ stopUnselected = true } = {}) {
  if (_running) return;
  _running = true;
  try {
    const runtime = await getRuntime();
    if (!runtime) return;

    // Owners whose current plan includes AI. A Basic-VMS / downgraded / expired
    // account is absent here, so its cameras are treated as AI-off below.
    const aiUserIds = await getAiEntitledUserIds();

    const cameras = await Camera.findAll({
      attributes: ['id', 'monitorId', 'name', 'settings', 'userId'],
      order: [['createdAt', 'ASC']],
    });

    let started = 0;
    let stopped = 0;

    for (const camera of cameras) {
      // THREE conditions, not two, and the third is new.
      //
      // `ai.enabled` is the MASTER switch -- "use this camera for AI at all" --
      // and every AI feature is now gated on it. But this loop starts one
      // specific thing: the FACE pipeline. While face AI was the only consumer
      // of the master, the two meant the same and one flag served both. It no
      // longer can: with the master governing head count, zones and activity
      // too, reading it here as "run face recognition" would make it impossible
      // to count people without recognising them -- which is exactly what
      // "Anonymous counting only" promises the operator.
      //
      // So face recognition has its own flag. Absent means ON, so every camera
      // that existed before this split behaves exactly as it did.
      const enabled = isAiEnabled(camera)
        && faceRecognitionOn(camera)
        && aiUserIds.has(camera.userId);
      const isRunning = runtime[camera.monitorId]?.running === true;
      try {
        if (enabled && !isRunning) {
          await postAiForm('/set-camera', camera.monitorId);
          started += 1;
        } else if (!enabled && isRunning && stopUnselected) {
          await postAiForm('/stop-camera', camera.monitorId);
          stopped += 1;
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
  }
}

function start() {
  if (_timer) return;
  const tick = () => reconcile({ stopUnselected: true }).catch((err) => {
    logger.warn('aiLifecycle: reconcile loop failed', { error: err.message });
  });
  _timer = setInterval(tick, RECONCILE_INTERVAL_MS);
  setTimeout(tick, 1000);
  setTimeout(tick, 8000);
  logger.info('aiLifecycle: started', { intervalMs: RECONCILE_INTERVAL_MS });
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
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
};
