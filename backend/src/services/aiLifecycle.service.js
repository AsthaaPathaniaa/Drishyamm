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

function isAiEnabled(camera) {
  const ai = camera.settings?.ai || {};
  return ai.enabled === true && ai.mode !== 'off';
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
  return [camera.host, camera.group?.host].some((h) => h && nvrLoad.interactiveActive(h));
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
      // Detection runs only when the per-camera AI flag is on AND the owner's
      // plan includes AI. A downgrade to Basic drops the owner from aiUserIds,
      // so this loop /stop-camera's their orchestrators within one reconcile
      // even if settings.ai.enabled is still stale-true.
      const wanted = isAiEnabled(camera) && aiUserIds.has(camera.userId);
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
  _internals: { yieldsToPlayback, paused: _paused },
};
