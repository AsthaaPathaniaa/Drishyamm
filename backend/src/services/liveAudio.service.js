// Live audio: a camera's sound, on its own, to the one browser player that has
// it unmuted.
//
// Why not in the video relay
//   Carrying audio inside the video relay's fragmented MP4 (RELAY_AUDIO=1)
//   made live video lag. MediaSource only plays where EVERY track is
//   buffered, and the cameras' G.711 arrives late and with gaps, so the
//   playable range kept falling behind the video and the player kept
//   jumping to catch up. ffmpeg also held video up to 1 s to interleave it
//   with audio. And every muted grid tile paid for audio it never played.
//
// How
//   The video relay stays video only. A tile that is unmuted opens a second,
//   audio-only socket (ticket with ?audio=1). One ffmpeg per camera source,
//   shared by every listener, asks the RTSP server for the AUDIO track only
//   (`-allowed_media_types audio`: the video is not sent a second time),
//   re-encodes G.711 → AAC and writes fragmented MP4 in ~100 ms fragments.
//   The browser plays it in a separate <audio> MediaSource, so a late or
//   missing audio packet can never hold the picture back.
//
//   It runs only while someone listens (stopped IDLE_MS after the last one
//   leaves). A camera without an audio track gets {type:'noaudio'} once and
//   is not retried for a while. Any failure here only silences the sound —
//   the video relay is a separate process and never notices.
//
//   Wire format (per listener): text {type:'init', mime}, the binary init
//   segment (ftyp+moov), then binary fragments (moof+mdat). Every AAC
//   fragment is independently decodable, so no cache is needed for a late
//   joiner: it gets the init and the next fragment.
const { spawn } = require('node:child_process');
const logger = require('../config/logger');

const IDLE_MS      = parseInt(process.env.AUDIO_IDLE_MS || '5000', 10);
const STALL_MS     = parseInt(process.env.AUDIO_STALL_MS || '10000', 10);
const NO_INIT_MS   = parseInt(process.env.AUDIO_NO_INIT_MS || '15000', 10);
const MAX_RESTARTS = parseInt(process.env.AUDIO_MAX_RESTARTS || '5', 10);
const NO_AUDIO_MS  = 10 * 60_000;
const MIME = 'audio/mp4; codecs="mp4a.40.2"';

const _streams = new Map();  // key (NVR URL or Stream Service path) → stream
const _noAudio = new Map();  // key → ms until which we don't try again

// ffmpeg's words for "this source has no audio track".
const NO_AUDIO_RE = /matches no streams|does not contain any stream|no audio|Output file is empty/i;

function send(ws, data) {
  try { ws.send(data); } catch (_) { /* closed */ }
}

function sendInit(s, ws) {
  send(ws, JSON.stringify({ type: 'init', mime: MIME }));
  send(ws, s.init);
}

function ffmpegArgs(input) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-rtsp_transport', 'tcp',
    // SETUP only the audio track: the NVR doesn't send the video again.
    '-allowed_media_types', 'audio',
    '-timeout', '30000000',
    '-fflags', '+genpts+nobuffer', '-flags', 'low_delay',
    '-probesize', '64000', '-analyzeduration', '1000000',
    '-i', input,
    '-vn', '-map', '0:a:0',
    // async: fill gaps in the camera's timestamps with silence (and drop
    // overlaps), so the browser gets one continuous track, not holes it
    // would stop at.
    '-af', 'aresample=async=1000:first_pts=0',
    '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '64k',
    '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof',
    '-frag_duration', '100000',
    '-flush_packets', '1',
    'pipe:1',
  ];
}

async function resolveInput(s) {
  // Same choice as the video relay: read Stream Service when it already pulls
  // this stream (no extra NVR session), else the NVR itself, paced like every
  // other NVR open.
  const relay = require('./liveRelay.service');
  if (await relay._internals.sourceReady(s.path)) return relay._internals.sourceUrl(s.path);
  if (s.nvrUrl) {
    // Lowest priority in the per-NVR open queue: sound must never make a
    // picture wait. ("Unmute all" in Live View asks for every tile's audio at
    // once; at `view` priority those opens took turns with the tiles' video.)
    const transcoder = require('./transcoder.service');
    await transcoder.paceNvrOpen(s.monitorId, { priority: transcoder.OPEN_PRIORITY.warm });
    return s.nvrUrl;
  }
  return relay._internals.sourceUrl(s.path);
}

async function spawnAudio(s) {
  if (s.stopped) return;
  const input = await resolveInput(s);
  if (s.stopped) return;
  const proc = spawn('ffmpeg', ffmpegArgs(input), { stdio: ['ignore', 'pipe', 'pipe'] });
  s.proc = proc;
  s.startedAt = Date.now();
  s.lastFragAt = 0;
  s.init = null;
  let buf = Buffer.alloc(0);
  let initParts = [];
  let pendingMoof = null;
  let err = '';

  proc.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= 8) {
      let size = buf.readUInt32BE(off);
      if (size === 1) {
        if (buf.length - off < 16) break;
        size = Number(buf.readBigUInt64BE(off + 8));
      }
      if (size < 8 || buf.length - off < size) break;
      const box = buf.subarray(off, off + size);
      const type = box.toString('latin1', 4, 8);
      off += size;
      if (!s.init) {
        if (type === 'moof') {
          s.init = Buffer.concat(initParts);
          initParts = [];
          if (s.restarts) s.restarts = 0;
          logger.info('liveAudio: init', { path: s.path, ms: Date.now() - s.startedAt });
          for (const ws of s.listeners) sendInit(s, ws);
          pendingMoof = Buffer.from(box);
        } else {
          initParts.push(Buffer.from(box));
        }
        continue;
      }
      if (type === 'moof') { pendingMoof = Buffer.from(box); continue; }
      if (type === 'mdat' && pendingMoof) {
        const frag = Buffer.concat([pendingMoof, box]);
        pendingMoof = null;
        s.lastFragAt = Date.now();
        for (const ws of s.listeners) {
          // Audio is tiny; a listener this far behind is gone — skip, don't queue.
          if (ws.bufferedAmount > 256 * 1024) continue;
          send(ws, frag);
        }
      }
    }
    buf = off ? buf.subarray(off) : buf;
  });
  proc.stderr.on('data', (c) => { err = (err + c.toString()).slice(-2000); });
  proc.on('exit', (code) => {
    if (s.proc !== proc) return;
    s.proc = null;
    if (s.stopped) return;
    const msg = (s.killReason || err.trim().split('\n').slice(-2).join(' | '))
      .replace(/rtsp:\/\/[^@\s/]*@/g, 'rtsp://***@');
    s.killReason = null;
    if (!s.init && NO_AUDIO_RE.test(err)) {
      logger.info('liveAudio: camera has no audio track', { path: s.path });
      _noAudio.set(s.key, Date.now() + NO_AUDIO_MS);
      for (const ws of s.listeners) send(ws, JSON.stringify({ type: 'noaudio' }));
      stopAudio(s.key);
      return;
    }
    s.restarts = (s.restarts || 0) + 1;
    if (s.restarts > MAX_RESTARTS) {
      logger.warn('liveAudio: giving up', { path: s.path, code, error: msg });
      for (const ws of s.listeners) send(ws, JSON.stringify({ type: 'error', message: 'audio unavailable' }));
      stopAudio(s.key);
      return;
    }
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(s.restarts, 4));
    logger.warn('liveAudio: source ended, restarting', { path: s.path, code, delay, error: msg });
    for (const ws of s.listeners) send(ws, JSON.stringify({ type: 'reset' }));
    setTimeout(() => { if (!s.stopped) spawnAudio(s).catch(() => {}); }, delay);
  });
}

function stopAudio(key) {
  const s = _streams.get(key);
  if (!s) return false;
  s.stopped = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  _streams.delete(key);
  try { s.proc?.kill('SIGKILL'); } catch (_) {}
  for (const ws of s.listeners) { try { ws.close(1001, 'audio stopped'); } catch (_) {} }
  logger.info('liveAudio: stopped', { path: s.path });
  return true;
}

function touchIdle(s) {
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  if (s.listeners.size) return;
  s.idleTimer = setTimeout(() => { if (!s.listeners.size) stopAudio(s.key); }, IDLE_MS);
  if (s.idleTimer.unref) s.idleTimer.unref();
}

/** Attach an audio-only WebSocket listener (ticket fields: path, monitorId, nvrUrl). */
function addListener(ws, { path, monitorId, nvrUrl = null }) {
  const key = nvrUrl || path;
  if ((_noAudio.get(key) || 0) > Date.now()) {
    send(ws, JSON.stringify({ type: 'noaudio' }));
    try { ws.close(1000, 'no audio'); } catch (_) {}
    return;
  }
  let s = _streams.get(key);
  if (!s) {
    s = { key, path, monitorId, nvrUrl, listeners: new Set(), init: null, proc: null, stopped: false, restarts: 0, idleTimer: null };
    _streams.set(key, s);
    spawnAudio(s).catch((e) => logger.error('liveAudio: spawn failed', { path, error: e.message }));
  }
  s.listeners.add(ws);
  touchIdle(s);
  if (s.init) sendInit(s, ws);
  ws.on('close', () => {
    s.listeners.delete(ws);
    touchIdle(s);
  });
}

/** Kill audio streams that went silent; the exit handler restarts them. */
function sweepStalled(now = Date.now()) {
  for (const s of _streams.values()) {
    if (!s.proc || s.stopped || s.killReason) continue;
    let reason = null;
    if (!s.init) {
      if (now - s.startedAt > NO_INIT_MS) reason = 'no audio header (watchdog)';
    } else if (now - Math.max(s.lastFragAt || 0, s.startedAt) > STALL_MS) {
      reason = 'no audio data (watchdog)';
    }
    if (!reason) continue;
    s.killReason = reason;
    try { s.proc.kill('SIGKILL'); } catch (_) { s.killReason = null; }
  }
}
setInterval(() => sweepStalled(), 2000).unref?.();

function stats() {
  return [..._streams.values()].map((s) => ({
    path: s.path, listeners: s.listeners.size, running: !!s.proc, restarts: s.restarts,
    lastFragAgoMs: s.lastFragAt ? Date.now() - s.lastFragAt : null,
  }));
}

module.exports = { addListener, stopAudio, stats, MIME, _internals: { ffmpegArgs, sweepStalled, streams: _streams, noAudio: _noAudio } };
