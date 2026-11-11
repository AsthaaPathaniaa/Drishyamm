/**
 * liveSnapshot.service.js — one still from a camera, for the Monitor Wall
 * editor's tiles and the zone editor's reference picture.
 *
 * The recorder is the constraint here, not this server. Stream Service keeps an
 * on-demand path pulling for a while after its last reader leaves
 * (sourceOnDemandCloseAfter), so a still taken THROUGH Stream Service holds an
 * NVR session open. Sixteen tiles would be sixteen sessions: the flood that
 * took a whole Hikvision offline on 2026-07-06. So, in order:
 *
 *   1. A cached still younger than FRESH_MS is served as is. Every viewer and
 *      every tab shares it.
 *   2. If the camera's path is already live (someone is watching, or it
 *      records), one frame is read from Stream Service's RTSP egress. The
 *      recorder is already serving that session, so this costs it nothing.
 *   3. Otherwise one frame is read straight from the camera's SUB-stream. That
 *      session lasts only as long as ffmpeg (a second or two, no linger), and a
 *      per-recorder lock allows one such grab per NVR host at a time.
 *
 * When a grab fails, a still up to STALE_MS old is served instead of nothing
 * and flagged stale, so the page can show its age.
 *
 * Saved picture. The memory cache is lost on restart and an offline camera is
 * never grabbed, so one picture per camera is also kept in S3
 * (snapshots/<userId>/<monitorId>/latest.jpg, overwritten in place) with a
 * pointer in Camera.settings.lastSnapshot. It is written on the camera's
 * first grab, by the background queue (camera came online, saved picture
 * expired), or when an operator asks — never by ordinary viewer grabs. A grab
 * that will be saved tries, cheapest for the NVR first: the live path, then a
 * recording segment under RECORDING_FRESH_MS old, then the sub-stream direct —
 * and that last one is deferred (not taken) while the NVR already has
 * NVR_VIEW_BUDGET ready paths, so the picture never competes with people
 * watching. A deferred grab goes back on the queue for RETRY_MS, MAX_TRIES
 * times at most.
 *
 * Expiry. An hourly sweep replaces (online camera) or deletes (offline, or
 * the grab fails) every saved picture older than SNAPSHOT_MAX_AGE_DAYS; a
 * bucket lifecycle rule on snapshots/ is the backstop if the sweep stops
 * (scripts/s3-snapshot-lifecycle.js).
 */

const { spawn } = require('child_process');
const streamingService = require('./drishyamStreaming.service');
const s3Service = require('./s3.service');
const localRecordings = require('./localRecordings.service');
const { QueryTypes } = require('sequelize');
const { Camera, sequelize } = require('../models');
const { createSemaphore } = require('../utils/semaphore');
const logger = require('../config/logger');

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

const FRESH_MS = 60 * 1000;
const STALE_MS = 15 * 60 * 1000;
const RECORDING_FRESH_MS = 10 * 60 * 1000;
const MAX_AGE_MS = int(process.env.SNAPSHOT_MAX_AGE_DAYS, 14) * 24 * 3600 * 1000;
const MANUAL_MIN_MS = int(process.env.SNAPSHOT_MANUAL_MIN, 5) * 60 * 1000;
const NVR_VIEW_BUDGET = int(process.env.NVR_VIEW_BUDGET, 9);
const FLAP_MIN_MS = int(process.env.SNAPSHOT_FLAP_MIN, 60) * 60 * 1000;
const SWEEP_MAX = int(process.env.SNAPSHOT_SWEEP_MAX, 200);
const ONLINE_DELAY_MS = 30 * 1000;      // let the path become ready, so the frame is Stream Service's
const RETRY_MS = 10 * 60 * 1000;        // a deferred grab waits this long for the NVR to free up
const MAX_TRIES = 6;
const SWEEP_MS = 60 * 60 * 1000;
const GRAB_TIMEOUT_MS = 9000;
const MAX_ENTRIES = 1000;
const MAX_SAVED_ENTRIES = 300;
const WIDTH = 640;

const cache = new Map();       // monitorId → { jpeg, at, source }
const saved = new Map();       // monitorId → { jpeg, at, key }  (saved pictures read back from S3)
const inFlight = new Map();    // monitorId[#save|#rec] → Promise
const queued = new Map();      // monitorId → background job (see enqueue)
const hostLocks = new Map();   // recorder host → semaphore(1)
// Decoding a keyframe (often H.265) is the CPU cost; cap it for the server.
const ffmpegSlots = createSemaphore(4);
// Background grabs take at most two of those slots, so a whole NVR coming
// back never crowds out people opening the editor.
const queueSlots = createSemaphore(2);

function hostLock(host) {
  const key = String(host || '').toLowerCase();
  if (!hostLocks.has(key)) hostLocks.set(key, createSemaphore(1));
  return hostLocks.get(key);
}

// ffmpeg echoes its input URL in errors; never let camera credentials reach a
// log. Greedy to the LAST '@' before the host, so a raw '@' in a password
// can't leave the tail of it behind.
function scrub(text) {
  return String(text || '').replace(/rtsp:\/\/[^\s/]*@/gi, 'rtsp://***@');
}

async function isPathReady(name) {
  if (!streamingService.api?.get) return false;
  try {
    const { data } = await streamingService.api.get(`/v3/paths/get/${name}`, { timeout: 800 });
    return data?.ready === true;
  } catch {
    return false;
  }
}

// Paths on Stream Service that are pulling from this NVR right now (main and
// sub of every camera on the host; an _h264 sidecar reads Stream Service, not
// the NVR). Unreachable Stream Service counts as 0 — today's behaviour.
async function readyPathsOnNvr(host) {
  const cams = await Camera.findAll({ where: { host }, attributes: ['monitorId'], raw: true });
  const names = new Set(cams.flatMap((c) => [streamingService.pathName(c.monitorId), streamingService.subPathName(c.monitorId)]));
  const items = (await streamingService.listPaths?.()) || [];
  return items.filter((it) => it.ready && names.has(it.name)).length;
}

async function pickSource(camera, { persist = false, skipRecording = false } = {}) {
  const { monitorId } = camera;
  if (await isPathReady(streamingService.subPathName(monitorId))) {
    return { kind: 'live', url: streamingService.getRtspEgressUrl(monitorId, true) };
  }
  if (await isPathReady(streamingService.pathName(monitorId))) {
    return { kind: 'live', url: streamingService.getRtspEgressUrl(monitorId, false) };
  }
  if (persist && !skipRecording) {
    const seg = await localRecordings.latestSegment(monitorId).catch(() => null);
    if (seg && Date.now() - seg.mtimeMs < RECORDING_FRESH_MS) {
      return { kind: 'recording', file: seg.file, at: seg.startedAtMs };
    }
  }
  if (persist) {
    const readyPaths = await readyPathsOnNvr(camera.host);
    if (readyPaths >= NVR_VIEW_BUDGET) return { kind: 'deferred', readyPaths };
  }
  const subPath = streamingService.deriveSubPath(camera.path);
  return {
    kind: 'direct',
    host: camera.host,
    url: streamingService.buildRtspUrl({
      host: camera.host,
      port: camera.port,
      path: subPath || camera.path,
      username: camera.username,
      password: camera.password,
    }),
  };
}

function grabFrame(input, { file = false } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(file ? [] : [
        '-rtsp_transport', 'tcp',
        '-timeout', '5000000',          // socket I/O timeout, microseconds
      ]),
      // Decode keyframes only. Joining a stream mid-GOP, the first frame an
      // H.265 decoder emits is a grey half-frame with no reference picture;
      // waiting for the next keyframe costs at most one GOP (~2 s).
      '-skip_frame', 'nokey',
      '-i', input,
      '-frames:v', '1', '-an',
      '-vf', `scale=${WIDTH}:-2`,
      '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error('timed out waiting for a frame'));
    }, GRAB_TIMEOUT_MS);

    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { stderr = (stderr + c).slice(-500); });
    ff.on('error', (err) => { clearTimeout(timer); reject(err); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      if (code === 0 && jpeg.length) resolve(jpeg);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() || 'no frame'}`));
    });
  });
}

// Width × height from a JPEG's start-of-frame marker, or nulls.
function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf[0] !== 0xff || buf[1] !== 0xd8) return { width: null, height: null };
  let i = 2;
  while (i + 9 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: null, height: null };
}

function bounded(map, limit, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function remember(monitorId, entry) {
  bounded(cache, MAX_ENTRIES, monitorId, entry);
}

// ── Saved picture ────────────────────────────────────────────────────────────

function savedMeta(camera) {
  let s = camera.settings;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
  const meta = s?.lastSnapshot;
  return meta?.key && meta?.capturedAt ? meta : null;
}

function usableSaved(camera) {
  const meta = savedMeta(camera);
  return meta && Date.now() - Date.parse(meta.capturedAt) <= MAX_AGE_MS ? meta : null;
}

/**
 * Save one picture as the camera's reference: overwrite its single S3 object
 * and point Camera.settings.lastSnapshot at it. JSON_SET touches only that key,
 * so a concurrent AI-settings write isn't clobbered.
 * @returns {Promise<object|null>} the stored pointer, or null if S3 refused it
 */
async function persist(camera, jpeg, { at = Date.now(), source, reason } = {}) {
  const key = `snapshots/${camera.userId}/${camera.monitorId}/latest.jpg`;
  if (!(await s3Service.putObject(key, jpeg, 'image/jpeg'))) return null;
  const prev = savedMeta(camera);
  const meta = {
    key,
    capturedAt: new Date(at).toISOString(),
    ...jpegSize(jpeg),
    source,
    manualAt: reason === 'manual' ? new Date().toISOString() : (prev?.manualAt || null),
  };
  await sequelize.query(
    "UPDATE cameras SET settings = JSON_SET(COALESCE(settings, JSON_OBJECT()), '$.lastSnapshot', CAST(:meta AS JSON)) WHERE id = :id",
    { replacements: { meta: JSON.stringify(meta), id: camera.id } },
  );
  bounded(saved, MAX_SAVED_ENTRIES, camera.monitorId, { jpeg, at, key });
  logger.info('snapshot saved', { monitorId: camera.monitorId, source, reason });
  return meta;
}

async function loadSaved(camera) {
  const meta = usableSaved(camera);
  if (!meta) return null;
  const at = Date.parse(meta.capturedAt);
  const memo = saved.get(camera.monitorId);
  if (memo && memo.key === meta.key && memo.at === at) return { jpeg: memo.jpeg, at, source: 'saved' };
  try {
    const { stream } = await s3Service.getReadStream(meta.key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const jpeg = Buffer.concat(chunks);
    if (!jpeg.length) return null;
    bounded(saved, MAX_SAVED_ENTRIES, camera.monitorId, { jpeg, at, key: meta.key });
    return { jpeg, at, source: 'saved' };
  } catch (err) {
    logger.warn('saved snapshot unreadable', { monitorId: camera.monitorId, error: err.message });
    return null;
  }
}

// ── Grabbing ─────────────────────────────────────────────────────────────────

async function runGrab(source) {
  const lock = source.kind === 'direct' ? hostLock(source.host) : null;
  if (lock) await lock.acquire();
  await ffmpegSlots.acquire();
  try {
    return await (source.kind === 'recording' ? grabFrame(source.file, { file: true }) : grabFrame(source.url));
  } finally {
    ffmpegSlots.release();
    if (lock) lock.release();
  }
}

/**
 * Take one fresh still and cache it; save it when it should be saved.
 * @param {object} camera
 * @param {object} [opts]
 * @param {'online'|'expired'|'manual'|'first'} [opts.reason]  set by the queue or
 *        an operator; absent for an ordinary viewer, whose grab is saved only
 *        when the camera has no usable saved picture yet
 * @param {boolean} [opts.fromQueue]  the queue retries its own deferred jobs;
 *        anyone else's deferred grab is handed to the queue here
 * @returns {Promise<{ jpeg, at, source, saved: object|null } | { deferred: true, readyPaths }>}
 */
async function refresh(camera, { reason, fromQueue = false } = {}) {
  const persistIt = !!reason || !usableSaved(camera);
  const trigger = reason || 'first';
  let skipRecording = false;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- at most two passes, in order
    const source = await pickSource(camera, { persist: persistIt, skipRecording });
    if (source.kind === 'deferred') {
      logger.info('snapshot deferred', { monitorId: camera.monitorId, source: 'deferred', reason: trigger, readyPaths: source.readyPaths });
      if (!fromQueue) {
        enqueue({ cameraId: camera.id, monitorId: camera.monitorId, reason: trigger, onlyIfMissing: !reason, tries: 1 }, RETRY_MS);
      }
      return { deferred: true, readyPaths: source.readyPaths };
    }
    let jpeg;
    try {
      // eslint-disable-next-line no-await-in-loop
      jpeg = await runGrab(source);
    } catch (err) {
      logger.warn('live snapshot failed', { monitorId: camera.monitorId, source: source.kind, error: scrub(err.message) });
      // An in-progress segment can have no fragment yet; move on down the order.
      if (source.kind !== 'recording') throw err;
      skipRecording = true;
      continue;
    }
    return keep(camera, jpeg, source, { persistIt, trigger });
  }
}

async function keep(camera, jpeg, source, { persistIt, trigger }) {
  const at = source.kind === 'recording' ? source.at : Date.now();
  const entry = { jpeg, at, source: source.kind };
  remember(camera.monitorId, entry);
  let meta = null;
  if (persistIt) {
    meta = await persist(camera, jpeg, { at, source: source.kind, reason: trigger }).catch((err) => {
      logger.warn('snapshot save failed', { monitorId: camera.monitorId, error: err.message });
      return null;
    });
  }
  return { ...entry, saved: meta };
}

function once(key, fn) {
  if (!inFlight.has(key)) inFlight.set(key, fn().finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

// A frame from the camera's own latest recording when nothing better exists —
// an offline camera's last moments. Saved, so the next read needn't decode.
async function fromLatestRecording(camera) {
  const seg = await localRecordings.latestSegment(camera.monitorId).catch(() => null);
  if (!seg || Date.now() - seg.startedAtMs > MAX_AGE_MS) return null;
  try {
    const jpeg = await runGrab({ kind: 'recording', file: seg.file });
    await persist(camera, jpeg, { at: seg.startedAtMs, source: 'recording', reason: 'fallback' })
      .catch((err) => logger.warn('snapshot save failed', { monitorId: camera.monitorId, error: err.message }));
    return { jpeg, at: seg.startedAtMs, source: 'recording' };
  } catch (err) {
    logger.warn('recording snapshot failed', { monitorId: camera.monitorId, error: err.message });
    return null;
  }
}

function offlineError(camera) {
  const err = new Error('camera is offline');
  err.code = 'OFFLINE';
  err.lastSeenAt = camera.lastSeenAt ? new Date(camera.lastSeenAt).toISOString() : null;
  err.neverConnected = !camera.lastSeenAt;
  err.reason = err.neverConnected ? 'never_connected' : 'expired';
  return err;
}

// Saved picture, then a recording frame, then nothing. `cause` is the failed
// grab of an online camera, rethrown so it isn't reported as offline.
async function lastKnown(camera, cause) {
  const shot = (await loadSaved(camera)) || (await once(`${camera.monitorId}#rec`, () => fromLatestRecording(camera)));
  if (shot) return { ...shot, stale: true };
  throw cause || offlineError(camera);
}

/**
 * @param {object} camera  Camera row (id, userId, monitorId, host, port, path,
 *                         username, password, status, lastSeenAt, settings)
 * @param {object} [opts]
 * @param {boolean} [opts.cachedOnly]  never grab; only what is already held
 * @returns {Promise<{ jpeg: Buffer, at: number, source: string, stale: boolean }>}
 * @throws  Error with code 'OFFLINE' (and reason, lastSeenAt) when there is
 *          nothing to show for an offline camera; 'NOT_CACHED' when
 *          cachedOnly and an online camera has no picture held yet
 */
async function getSnapshot(camera, { cachedOnly = false } = {}) {
  const { monitorId } = camera;
  const hit = cache.get(monitorId);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (age < FRESH_MS) return { ...hit, stale: false };

  // Cached only: a picture already in hand (the memory copy, then the saved
  // one), never a grab. An editor asks this the moment it opens, while live
  // is still starting on the same NVR — a grab then would be a second session.
  if (cachedOnly) {
    if (age < MAX_AGE_MS) return { ...hit, stale: true };
    if (camera.status !== 'online') return lastKnown(camera);
    const kept = await loadSaved(camera);
    if (kept) return { ...kept, stale: true };
    const err = new Error('no picture in hand');
    err.code = 'NOT_CACHED';
    throw err;
  }

  // An unreachable camera would hold its recorder's lock for the whole
  // timeout and stall every other still on that NVR. Don't try.
  if (camera.status !== 'online') {
    if (age < STALE_MS) return { ...hit, stale: true };
    return lastKnown(camera);
  }

  const key = usableSaved(camera) ? monitorId : `${monitorId}#save`;
  let result;
  try {
    result = await once(key, () => refresh(camera));
  } catch (err) {
    if (age < STALE_MS) return { ...hit, stale: true };
    return lastKnown(camera, err);
  }
  if (result.deferred) {
    if (age < STALE_MS) return { ...hit, stale: true };
    const err = new Error('NVR is at its viewing limit; the still is queued');
    err.code = 'DEFERRED';
    return lastKnown(camera, err);
  }
  const { saved: _saved, ...shot } = result;
  return { ...shot, stale: false };
}

/**
 * An operator's "update picture": a fresh grab, always saved, which restarts
 * the saved picture's expiry clock.
 * @returns {Promise<{ capturedAt: string } | { queued: true }>}
 * @throws  'OFFLINE' (saved picture untouched), 'TOO_SOON' (retryAfterSec),
 *          or the grab's own error
 */
async function refreshByHand(camera) {
  if (camera.status !== 'online') throw offlineError(camera);
  const manualAt = savedMeta(camera)?.manualAt;
  const wait = manualAt ? MANUAL_MIN_MS - (Date.now() - Date.parse(manualAt)) : 0;
  if (wait > 0) {
    const err = new Error('picture was updated by hand moments ago');
    err.code = 'TOO_SOON';
    err.retryAfterSec = Math.ceil(wait / 1000);
    throw err;
  }
  const result = await once(`${camera.monitorId}#manual`, () => refresh(camera, { reason: 'manual' }));
  if (result.deferred) return { queued: true };
  if (!result.saved) throw new Error('the picture could not be saved');
  return { capturedAt: result.saved.capturedAt };
}

// ── Background queue ─────────────────────────────────────────────────────────
//
// One pending job per camera, run in-process after a delay. A job holds ids
// only and re-reads the camera when it runs, so it acts on the camera as it is
// then (still online? picture replaced meanwhile?), never on a stale row.

const PRIORITY = { first: 0, online: 1, expired: 2, manual: 3 };

/** @returns {boolean} false when the camera already had a job (merged into it) */
function enqueue(job, delayMs) {
  const prev = queued.get(job.monitorId);
  if (prev) {
    if (PRIORITY[job.reason] > PRIORITY[prev.reason]) prev.reason = job.reason;
    prev.onlyIfMissing = prev.onlyIfMissing && !!job.onlyIfMissing;
    return false;
  }
  const entry = { tries: 0, onlyIfMissing: false, ...job };
  entry.timer = setTimeout(() => {
    queued.delete(entry.monitorId);
    runJob(entry).catch((err) => logger.warn('snapshot job crashed', { monitorId: entry.monitorId, error: err.message }));
  }, delayMs);
  entry.timer.unref?.();
  queued.set(entry.monitorId, entry);
  return true;
}

/**
 * A camera just came online: save a fresh picture of it in ONLINE_DELAY_MS.
 * @param {object} camera  needs id and monitorId
 * @param {object} [opts]
 * @param {boolean} [opts.onlyIfMissing]  only when it has no usable picture
 *        (a backend restart re-discovering cameras that were already online)
 */
function queueOnline(camera, { onlyIfMissing = false } = {}) {
  return enqueue({ cameraId: camera.id, monitorId: camera.monitorId, reason: 'online', onlyIfMissing }, ONLINE_DELAY_MS);
}

async function runJob(job) {
  await queueSlots.acquire();
  let camera = null;
  try {
    camera = await Camera.findByPk(job.cameraId);
    if (!camera) return 'gone';
    if (camera.status !== 'online') {
      if (job.reason === 'expired') await expire(camera);
      return 'offline';
    }
    const meta = usableSaved(camera);
    if ((job.onlyIfMissing || job.reason === 'expired') && meta) return 'skipped';
    // A flapping camera re-enters 'online' every few minutes; its picture
    // from an hour ago is still good.
    if (job.reason === 'online' && meta && Date.now() - Date.parse(meta.capturedAt) < FLAP_MIN_MS) return 'skipped';

    job.tries += 1;
    const result = await once(`${camera.monitorId}#queue`, () => refresh(camera, { reason: job.reason, fromQueue: true }));
    if (!result.deferred) return 'saved';
    if (job.tries >= MAX_TRIES) {
      logger.info('snapshot gave up', { monitorId: camera.monitorId, reason: job.reason, tries: job.tries });
      if (job.reason === 'expired') await expire(camera);
      return 'gave_up';
    }
    const { timer: _t, ...again } = job;
    enqueue(again, RETRY_MS);
    return 'retry';
  } catch (err) {
    logger.warn('queued snapshot failed', { monitorId: job.monitorId, reason: job.reason, error: scrub(err.message) });
    if (job.reason === 'expired' && camera) await expire(camera).catch(() => {});
    return 'failed';
  } finally {
    queueSlots.release();
  }
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Drop a camera's saved picture if it is past SNAPSHOT_MAX_AGE_DAYS. The row
 * is cleared only while it still points at that same picture, so one an
 * operator saved a moment ago is never removed.
 * @returns {Promise<boolean>} true when it was removed
 */
async function expire(camera) {
  const meta = savedMeta(camera);
  if (!meta || Date.now() - Date.parse(meta.capturedAt) <= MAX_AGE_MS) return false;
  const [, affected] = await sequelize.query(
    `UPDATE cameras SET settings = JSON_REMOVE(settings, '$.lastSnapshot')
      WHERE id = :id AND JSON_UNQUOTE(JSON_EXTRACT(settings, '$.lastSnapshot.capturedAt')) = :capturedAt`,
    { replacements: { id: camera.id, capturedAt: meta.capturedAt }, type: QueryTypes.UPDATE },
  );
  if (!affected) return false;
  saved.delete(camera.monitorId);
  await s3Service.deleteRecording(meta.key).catch(() => {}); // logged there; the lifecycle rule is the backstop
  logger.info('snapshot expired', { monitorId: camera.monitorId, capturedAt: meta.capturedAt });
  return true;
}

/**
 * Hourly: replace (online) or delete (offline) every saved picture older than
 * SNAPSHOT_MAX_AGE_DAYS, oldest first, at most SNAPSHOT_SWEEP_MAX a run.
 */
async function sweep() {
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const rows = await sequelize.query(
    `SELECT id FROM cameras
      WHERE JSON_UNQUOTE(JSON_EXTRACT(settings, '$.lastSnapshot.capturedAt')) < :cutoff
      ORDER BY JSON_UNQUOTE(JSON_EXTRACT(settings, '$.lastSnapshot.capturedAt'))
      LIMIT :limit`,
    { replacements: { cutoff, limit: SWEEP_MAX }, type: QueryTypes.SELECT },
  );
  const stats = { expired: rows.length, queued: 0, deleted: 0 };
  if (!rows.length) return stats;
  const cameras = await Camera.findAll({ where: { id: rows.map((r) => r.id) } });
  for (const camera of cameras) {
    if (camera.status === 'online') {
      if (enqueue({ cameraId: camera.id, monitorId: camera.monitorId, reason: 'expired' }, 0)) stats.queued += 1;
    } else if (await expire(camera).catch(() => false)) {
      stats.deleted += 1;
    }
  }
  logger.info('snapshot sweep', stats);
  return stats;
}

let sweepTimer = null;

function startSweep() {
  if (sweepTimer) return;
  const loop = async () => {
    try {
      let leader = true;
      try { leader = require('./streamSupervisor.service').isLeader(); } catch (_) { /* default true */ }
      if (leader) await sweep();
    } catch (err) {
      logger.warn('snapshot sweep failed', { error: err.message });
    } finally {
      if (sweepTimer) { sweepTimer = setTimeout(loop, SWEEP_MS); sweepTimer.unref?.(); }
    }
  };
  sweepTimer = setTimeout(loop, 5 * 60 * 1000); // first pass 5 min after boot
  sweepTimer.unref?.();
}

function stopSweep() {
  if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
}

module.exports = {
  getSnapshot,
  refresh,
  refreshByHand,
  persist,
  queueOnline,
  sweep,
  startSweep,
  stopSweep,
  _internals: { pickSource, scrub, jpegSize, runJob, expire, cache, saved, queued, FRESH_MS, STALE_MS, MAX_AGE_MS, MANUAL_MIN_MS, NVR_VIEW_BUDGET, FLAP_MIN_MS, RETRY_MS, MAX_TRIES },
};
