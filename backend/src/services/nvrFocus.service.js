// NVR focus: while someone replays footage from an NVR, their OWN background
// streams on that NVR stop, so the replay gets the uplink those were using.
// Other users' streams on the same NVR are not touched.
//
// Why
//   A recorder's uplink is small and shared by everything that pulls from it.
//   Measured 2026-11-21 on the lab NVR (111.125.141.20): with AI main streams
//   and warm-keeper sub-streams running, recorded 1080p playback arrived at
//   0.12-0.5x real time, in bursts with 16-28 s of silence. The player could
//   not keep a buffer and looked frozen.
//
// What it does (on nvrLoad 'interactive' (host, userId): that user's playback
// or export claims the NVR)
//   • Parks every Stream Service path (main and sub) of that user's cameras
//     on that NVR that no person is watching: its source is switched to 'publisher', which
//     closes the NVR session and disconnects all readers (AI, zone-guard,
//     head-count, recording, our transcoders). Readers can't reconnect, so
//     nothing re-opens the NVR behind the viewer's back.
//   • Stops that user's idle live relays there (warm-keeper pins).
//   • Re-checks every FOCUS_RECHECK_MS while the claim holds, for pulls that
//     started in between.
//   On nvrLoad 'released' (host, userId) (the claim ended and its grace
//   passed) every path parked for it gets its source back and the normal on-demand behaviour returns.
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

// path name → { host, userId, source, sourceOnDemand }
const _parked = new Map();
const _focused = new Map();   // `${host}|${userId}` → recheck timer
const _busy = new Map();      // same key → running focus/unfocus promise (serialised)
const keyOf = (host, userId) => `${host}|${userId ?? '*'}`;

const streaming = () => require('./drishyamStreaming.service');
const relay = () => require('./liveRelay.service');

function serial(key, fn) {
  const prev = _busy.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (_busy.get(key) === next) _busy.delete(key); });
  _busy.set(key, next);
  return next;
}

async function save() {
  try {
    const redis = require('../config/redis');
    if (_parked.size) await redis.setJSON(REDIS_KEY, Object.fromEntries(_parked), REDIS_TTL_S);
    else await redis.del(REDIS_KEY);
  } catch (_) { /* best effort: the in-memory map still restores on release */ }
}

/** monitorIds of `userId`'s cameras on `host` (own host or their group's NVR). */
async function camerasOn(host, userId) {
  const { Camera, CameraGroup } = require('../models');
  const cams = await Camera.findAll({
    where: { userId },
    attributes: ['monitorId', 'host', 'userId'],
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

async function focus(host, userId) {
  if (userId == null || !nvrLoad.interactiveActive(host, userId)) return;
  const api = streaming().api;
  const ids = await camerasOn(host, userId);
  if (!ids.length) return;
  const pathNames = new Set(ids.flatMap((id) => [streaming().pathName(id), streaming().subPathName(id)]));

  // This user's idle live relays first: they may pull the NVR directly.
  const stoppedRelays = relay().releaseIdleWhere((path) => pathNames.has(path) || pathNames.has(path.replace(/_h264$/, '')));

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
      _parked.set(name, { host, userId, source: cfg.source, sourceOnDemand: cfg.sourceOnDemand !== false });
      parkedNow.push(name);
      try { require('./transcoder.service').stopVariant(id, variant); } catch (_) { /* none running */ }
    }
  }
  if (parkedNow.length) await save();
  if (parkedNow.length || stoppedRelays.length) {
    logger.info('nvrFocus: this user\'s background streams paused for their playback', {
      host, userId, parkedPaths: parkedNow.length, stoppedRelays: stoppedRelays.length,
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

async function unfocus(host, userId) {
  if (nvrLoad.interactiveActive(host, userId)) return;    // claimed again meanwhile
  const key = keyOf(host, userId);
  stopRecheck(key);
  const names = [..._parked].filter(([, p]) => p.host === host && (p.userId ?? null) === userId).map(([n]) => n);
  const restored = await restorePaths(names);
  if (restored.length) logger.info('nvrFocus: playback ended, background streams restored', { host, userId, paths: restored.length });
  if (restored.length < names.length) setTimeout(() => serial(key, () => unfocus(host, userId)), 5000).unref?.();
}

/** A person opened live view of a parked camera: give its paths back now. */
async function unparkCamera(monitorId) {
  const names = [streaming().pathName(monitorId), streaming().subPathName(monitorId)].filter((n) => _parked.has(n));
  if (names.length) await restorePaths(names);
}

function stopRecheck(key) {
  const t = _focused.get(key);
  if (t) clearInterval(t);
  _focused.delete(key);
}

function onInteractive(host, userId = null) {
  if (userId == null) return;                  // no owner to scope to: leave everyone's streams alone
  const key = keyOf(host, userId);
  if (!_focused.has(key)) {
    const t = setInterval(() => {
      if (!nvrLoad.interactiveActive(host, userId)) { stopRecheck(key); return; }
      serial(key, () => focus(host, userId)).catch(() => {});
    }, FOCUS_RECHECK_MS);
    t.unref?.();
    _focused.set(key, t);
  }
  serial(key, () => focus(host, userId)).catch((err) => logger.warn('nvrFocus: focus failed', { host, error: err.message }));
}

function onReleased(host, userId = null) {
  if (userId == null) return;
  serial(keyOf(host, userId), () => unfocus(host, userId))
    .catch((err) => logger.warn('nvrFocus: restore failed', { host, error: err.message }));
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
      const stale = Object.keys(saved).filter((n) => {
        const p = _parked.get(n);
        return !p?.host || !nvrLoad.interactiveActive(p.host, p.userId ?? null);
      });
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
