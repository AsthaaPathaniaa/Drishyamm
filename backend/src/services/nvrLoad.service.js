// NVR session budget: one place that knows how many RTSP sessions each
// recorder is serving, and who gets the next one.
//
// Why
//   An NVR serves only so many concurrent streams. Past that it doesn't
//   refuse: it slows EVERY session down. Measured 2026-11-21 on the lab
//   recorder (111.125.141.20): 14 sessions (5 AI main streams through Stream
//   Service, 8 warm-keeper sub relays, 1 playback) and it delivered 0.26 Mbit/s
//   in total, about 15% of real time. Recorded playback played a second, then
//   waited, and the live relays' watchdog restarted every stalled tile, which
//   added sessions instead of removing them. Each feature had its own cap
//   (warm-keeper 9 per NVR, snapshots 9, backfill 2) and none of them saw the
//   total.
//
// What it does
//   • Counts every session on an NVR:
//       relay     direct live relays, incl. NVR playback over the relay
//                 (liveRelay.sessionsOnHost)
//       media     Stream Service paths of this NVR's cameras that are pulling
//                 (AI, HLS viewers, recording); cached, refreshed every few s
//       leases    other ffmpeg pulls we start (playback HLS transcode, export,
//                 backfill), registered with track()
//   • Interactive work (someone is replaying or exporting footage) claims the
//     NVR for that user with claim(host, userId). While it holds, background
//     work for THAT USER's cameras on that NVR (warm-keeper, backfill, AI
//     detection, snapshots, nvrFocus) does not start, and listeners of
//     'interactive' (host, userId) stop what they can give back. Other users
//     on the same NVR are not affected. 'released' (host, userId) fires when
//     that user's last claim there ends (after the grace).
//   • Background work only starts while the NVR has room below its limit
//     minus NVR_INTERACTIVE_RESERVE, so a person opening playback always finds
//     a free session.
//
// Configuration
//   NVR_MAX_SESSIONS         sessions one NVR serves well (default 9, the
//                            figure the warm-keeper and the wall already use)
//   NVR_SESSION_LIMITS       per-NVR overrides, "host=limit,host=limit"
//   NVR_INTERACTIVE_RESERVE  sessions background work leaves free (default 2)
//   NVR_CLAIM_GRACE_MS       how long an NVR stays claimed after its last
//                            playback ends (default 20000), so a seek, which
//                            ends one replay and starts the next, doesn't
//                            bring every background pull back for a moment
const { EventEmitter } = require('node:events');
const logger = require('../config/logger');

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

function parseLimits(spec) {
  const out = new Map();
  for (const part of String(spec || '').split(',')) {
    const m = part.trim().match(/^([^=\s]+)\s*=\s*(\d+)$/);
    if (m) out.set(m[1], parseInt(m[2], 10));
  }
  return out;
}

const DEFAULT_LIMIT = int(process.env.NVR_MAX_SESSIONS, 9);
const LIMITS = parseLimits(process.env.NVR_SESSION_LIMITS);
const RESERVE = int(process.env.NVR_INTERACTIVE_RESERVE, 2);
const MEDIA_REFRESH_MS = int(process.env.NVR_LOAD_REFRESH_MS, 5000);
const CLAIM_GRACE_MS = int(process.env.NVR_CLAIM_GRACE_MS, 20000);
const CAMERA_MAP_MS = 60_000;
const IDLE_STOP_MS = 120_000;    // stop polling Stream Service when nobody asks

const events = new EventEmitter();
const _leases = new Map();       // host → Map<id, kind>
const _claims = new Map();       // `${host}|${userId}` → number of interactive holds
const _media = new Map();        // host → ready Stream Service paths (last refresh)
const _grace = new Map();        // `${host}|${userId}` → timer: last claim ended, still held for CLAIM_GRACE_MS
let _leaseSeq = 0;
let _hostOfPath = new Map();     // Stream Service path name → NVR host
let _hostMapAt = 0;
let _timer = null;
let _lastUse = 0;
let _refreshing = null;

function limitFor(host) {
  return LIMITS.has(host) ? LIMITS.get(host) : DEFAULT_LIMIT;
}

/** Register a pull we started on `host`. Returns release() (safe to call twice). */
function track(host, kind) {
  if (!host) return () => {};
  touch();
  const id = ++_leaseSeq;
  if (!_leases.has(host)) _leases.set(host, new Map());
  _leases.get(host).set(id, kind);
  return () => {
    const m = _leases.get(host);
    if (!m || !m.delete(id)) return;
    if (!m.size) _leases.delete(host);
  };
}

/**
 * Someone is replaying or exporting footage from `host`: background work
 * yields until release() is called. Emits 'interactive' (host) so running
 * background pulls can give their sessions back.
 */
function claim(host, userId = null) {
  if (!host) return () => {};
  touch();
  const k = claimKey(host, userId);
  if (_grace.has(k)) { clearTimeout(_grace.get(k)); _grace.delete(k); }
  _claims.set(k, (_claims.get(k) || 0) + 1);
  events.emit('interactive', host, userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (_claims.get(k) || 1) - 1;
    if (n > 0) { _claims.set(k, n); return; }
    _claims.delete(k);
    if (!CLAIM_GRACE_MS) { events.emit('released', host, userId); return; }
    const t = setTimeout(() => {
      _grace.delete(k);
      if (!_claims.get(k)) events.emit('released', host, userId);
    }, CLAIM_GRACE_MS);
    t.unref?.();
    _grace.set(k, t);
  };
}

// Claims are per (NVR, user): one person's playback holds back only that
// person's own background work (their cameras' AI, warm tiles, recording,
// backfill, snapshots). Other accounts on the same NVR are not touched.
const claimKey = (host, userId) => `${host}|${userId ?? '*'}`;

/**
 * Is `userId` replaying from `host` (or within the grace after it)? Without a
 * userId: is anyone?
 */
function interactiveActive(host, userId) {
  if (!host) return false;
  if (userId !== undefined) {
    const k = claimKey(host, userId);
    return (_claims.get(k) || 0) > 0 || _grace.has(k);
  }
  const prefix = `${host}|`;
  for (const k of _claims.keys()) if (k.startsWith(prefix)) return true;
  for (const k of _grace.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

function claimCount(host) {
  let n = 0;
  for (const [k, c] of _claims) if (k.startsWith(`${host}|`)) n += c;
  return n;
}

/** Sessions on `host` right now, by kind. Synchronous: media is the last refresh. */
function usage(host) {
  touch();
  const byKind = { relay: 0, media: _media.get(host) || 0 };
  try { byKind.relay = require('./liveRelay.service').sessionsOnHost(host); } catch (_) { /* relay not loaded */ }
  for (const kind of (_leases.get(host) || new Map()).values()) byKind[kind] = (byKind[kind] || 0) + 1;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const limit = limitFor(host);
  return { host, limit, reserve: RESERVE, total, byKind, interactive: claimCount(host), full: total >= limit };
}

/**
 * Sessions background work may still open on `host` (0 = none). With a
 * userId, work for that user's cameras gets none while they replay from it.
 */
function backgroundRoom(host, userId) {
  if (!host || (userId !== undefined && interactiveActive(host, userId))) return 0;
  const u = usage(host);
  return Math.max(0, u.limit - RESERVE - u.total);
}

// ── Stream Service pulls (cached) ─────────────────────────────────────────

async function refreshHostMap() {
  if (Date.now() - _hostMapAt < CAMERA_MAP_MS && _hostOfPath.size) return;
  const { Camera } = require('../models');
  const streamingService = require('./drishyamStreaming.service');
  const cams = await Camera.findAll({ attributes: ['monitorId', 'host'], raw: true });
  const map = new Map();
  for (const c of cams) {
    if (!c.host) continue;
    map.set(streamingService.pathName(c.monitorId), c.host);
    map.set(streamingService.subPathName(c.monitorId), c.host);
  }
  _hostOfPath = map;
  _hostMapAt = Date.now();
}

async function refreshMedia() {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      await refreshHostMap();
      const items = (await require('./drishyamStreaming.service').listPaths?.()) || [];
      const counts = new Map();
      for (const it of items) {
        if (!it.ready) continue;
        const host = _hostOfPath.get(it.name);
        if (host) counts.set(host, (counts.get(host) || 0) + 1);
      }
      _media.clear();
      for (const [h, n] of counts) _media.set(h, n);
    } catch (err) {
      logger.debug?.('nvrLoad: could not read Stream Service paths', { error: err.message });
    } finally {
      _refreshing = null;
    }
  })();
  return _refreshing;
}

function touch() {
  _lastUse = Date.now();
  if (_timer || MEDIA_REFRESH_MS === 0) return;
  refreshMedia();
  _timer = setInterval(() => {
    if (Date.now() - _lastUse > IDLE_STOP_MS) { clearInterval(_timer); _timer = null; return; }
    refreshMedia();
  }, MEDIA_REFRESH_MS);
  _timer.unref?.();
}

module.exports = {
  limitFor, track, claim, interactiveActive, usage, backgroundRoom, refreshMedia, events,
  _internals: { parseLimits, leases: _leases, claims: _claims, media: _media, reset() {
    _leases.clear(); _claims.clear(); _media.clear(); events.removeAllListeners();
    for (const t of _grace.values()) clearTimeout(t);
    _grace.clear();
  } },
};
