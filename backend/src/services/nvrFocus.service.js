// NVR focus: while someone replays footage from an NVR, that NVR serves only
// them.
//
// Why
//   A recorder's uplink is small and shared by everything that pulls from it.
//   Measured 2026-11-21 on the lab NVR (111.125.141.20): with AI main streams
//   and warm-keeper sub-streams running, recorded 1080p playback arrived at
//   0.12-0.5x real time, in bursts with 16-28 s of silence. The player could
//   not keep a buffer and looked frozen.
//
// What it does (on nvrLoad 'interactive', i.e. playback or export claims the NVR)
//   • Parks every Stream Service path of that NVR's cameras (main and sub)
//     that no person is watching: its source is switched to 'publisher', which
//     closes the NVR session and disconnects all readers (AI, zone-guard,
//     head-count, recording, our transcoders). Readers can't reconnect, so
//     nothing re-opens the NVR behind the viewer's back.
//   • Stops the idle live relays on that NVR (warm-keeper pins), direct or not.
//   • Re-checks every FOCUS_RECHECK_MS while the claim holds, for pulls that
//     started in between.
//   On nvrLoad 'released' (the claim ended and its grace passed) every parked
//   path gets its source back and the normal on-demand behaviour returns.
//
// Watched means: a WebRTC/HLS reader on the path (or its _h264 sidecar), or a
// live-relay viewer of either. Those are a person's live view and stay.
//
// Parked sources are saved in Redis, so a backend restart while parked still
// restores them (start()).
//
// NVR_FOCUS=0 turns it off; background work then only yields as before.
const logger = require('../config/logger');
const nvrLoad = require('./nvrLoad.service');

const ENABLED = process.env.NVR_FOCUS !== '0';
const FOCUS_RECHECK_MS = 10_000;
const REDIS_KEY = 'nvrFocus:parked';
const REDIS_TTL_S = 7 * 24 * 3600;
const PERSON_READERS = new Set(['webRTCSession', 'hlsMuxer', 'rtmpConn', 'srtConn', 'rtmpsConn']);

// path name → { host, source, sourceOnDemand }
const _parked = new Map();
const _focused = new Map();   // host → recheck timer
const _busy = new Map();      // host → running focus/unfocus promise (serialised per host)

const streaming = () => require('./drishyamStreaming.service');
const relay = () => require('./liveRelay.service');

function serial(host, fn) {
  const prev = _busy.get(host) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (_busy.get(host) === next) _busy.delete(host); });
  _busy.set(host, next);
  return next;
}

async function save() {
  try {
    const redis = require('../config/redis');
    if (_parked.size) await redis.setJSON(REDIS_KEY, Object.fromEntries(_parked), REDIS_TTL_S);
    else await redis.del(REDIS_KEY);
  } catch (_) { /* best effort: the in-memory map still restores on release */ }
}

/** monitorIds of the cameras on `host` (own host or their group's NVR). */
async function camerasOn(host) {
  const { Camera, CameraGroup } = require('../models');
  const cams = await Camera.findAll({
    attributes: ['monitorId', 'host'],
    include: [{ model: CameraGroup, as: 'group', attributes: ['host'], required: false }],
  });
  return cams.filter((c) => c.host === host || c.group?.host === host).map((c) => c.monitorId);
}

function watched(name, byName) {
  for (const n of [name, `${name}_h264`]) {
    if ((byName.get(n)?.readers || []).some((r) => PERSON_READERS.has(r.type))) return true;
    if (relay().viewerCount(n) > 0) return true;
  }
  return false;
}

async function focus(host) {
  if (!nvrLoad.interactiveActive(host)) return;
  const api = streaming().api;
  const ids = await camerasOn(host);
  const pathNames = new Set(ids.flatMap((id) => [streaming().pathName(id), streaming().subPathName(id)]));

  // Idle live relays first: they may pull the NVR directly.
  const stoppedRelays = relay().releaseIdleWhere((path, r) => relay().hostOf(r) === host
    || pathNames.has(path) || pathNames.has(path.replace(/_h264$/, '')));

  let items = [];
  try { ({ data: { items = [] } = {} } = await api.get('/v3/paths/list', { timeout: 3000 })); } catch (_) { /* no list: park by config only */ }
  const byName = new Map(items.map((p) => [p.name, p]));

  const parkedNow = [];
  for (const id of ids) {
    for (const [name, variant] of [[streaming().pathName(id), 'main'], [streaming().subPathName(id), 'sub']]) {
      if (_parked.has(name) || watched(name, byName)) continue;
      let cfg;
      try {
        // eslint-disable-next-line no-await-in-loop -- a few paths per NVR, in order
        ({ data: cfg } = await api.get(`/v3/config/paths/get/${name}`, { timeout: 3000 }));
      } catch (_) { continue; }                       // not configured: nothing pulls it
      if (!cfg?.source || cfg.source === 'publisher') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await api.patch(`/v3/config/paths/patch/${name}`, { source: 'publisher', sourceOnDemand: false });
      } catch (err) {
        logger.warn('nvrFocus: could not park path', { name, error: err.message });
        continue;
      }
      _parked.set(name, { host, source: cfg.source, sourceOnDemand: cfg.sourceOnDemand !== false });
      parkedNow.push(name);
      try { require('./transcoder.service').stopVariant(id, variant); } catch (_) { /* none running */ }
    }
  }
  if (parkedNow.length) await save();
  if (parkedNow.length || stoppedRelays.length) {
    logger.info('nvrFocus: background streams paused for playback', {
      host, parkedPaths: parkedNow.length, stoppedRelays: stoppedRelays.length,
    });
  }
}

async function restorePaths(names) {
  const api = streaming().api;
  const restored = [];
  for (const name of names) {
    const p = _parked.get(name);
    if (!p) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- a few paths, in order
      await api.patch(`/v3/config/paths/patch/${name}`, { source: p.source, sourceOnDemand: p.sourceOnDemand });
      _parked.delete(name);
      restored.push(name);
    } catch (err) {
      if (err.response?.status === 404) { _parked.delete(name); continue; }   // path gone: re-added normally later
      logger.warn('nvrFocus: could not restore path, will retry', { name, error: err.message });
    }
  }
  await save();
  return restored;
}

async function unfocus(host) {
  if (nvrLoad.interactiveActive(host)) return;    // claimed again meanwhile
  stopRecheck(host);
  const names = [..._parked].filter(([, p]) => p.host === host).map(([n]) => n);
  const restored = await restorePaths(names);
  if (restored.length) logger.info('nvrFocus: playback ended, background streams restored', { host, paths: restored.length });
  if (restored.length < names.length) setTimeout(() => serial(host, () => unfocus(host)), 5000).unref?.();
}

/** A person opened live view of a parked camera: give its paths back now. */
async function unparkCamera(monitorId) {
  const names = [streaming().pathName(monitorId), streaming().subPathName(monitorId)].filter((n) => _parked.has(n));
  if (names.length) await restorePaths(names);
}

function stopRecheck(host) {
  const t = _focused.get(host);
  if (t) clearInterval(t);
  _focused.delete(host);
}

function onInteractive(host) {
  if (!_focused.has(host)) {
    const t = setInterval(() => {
      if (!nvrLoad.interactiveActive(host)) { stopRecheck(host); return; }
      serial(host, () => focus(host)).catch(() => {});
    }, FOCUS_RECHECK_MS);
    t.unref?.();
    _focused.set(host, t);
  }
  serial(host, () => focus(host)).catch((err) => logger.warn('nvrFocus: focus failed', { host, error: err.message }));
}

function onReleased(host) {
  serial(host, () => unfocus(host)).catch((err) => logger.warn('nvrFocus: restore failed', { host, error: err.message }));
}

/** Restore anything left parked by a previous run, then follow claims. */
async function start() {
  if (!ENABLED) return;
  nvrLoad.events.on('interactive', onInteractive);
  nvrLoad.events.on('released', onReleased);
  try {
    const saved = await require('../config/redis').getJSON(REDIS_KEY);
    if (saved && typeof saved === 'object') {
      for (const [name, p] of Object.entries(saved)) if (!_parked.has(name)) _parked.set(name, p);
      const stale = Object.keys(saved).filter((n) => !nvrLoad.interactiveActive(_parked.get(n)?.host));
      const restored = await restorePaths(stale);
      if (restored.length) logger.info('nvrFocus: restored paths parked before a restart', { paths: restored.length });
    }
  } catch (err) {
    logger.warn('nvrFocus: could not read parked paths', { error: err.message });
  }
}

function stop() {
  nvrLoad.events.off('interactive', onInteractive);
  nvrLoad.events.off('released', onReleased);
  for (const h of [..._focused.keys()]) stopRecheck(h);
}

module.exports = { start, stop, unparkCamera, _internals: { focus, unfocus, parked: _parked, watched } };
