/**
 * liveAudio — a camera's sound on its own socket, played in its own <audio>
 * element (backend/src/services/liveAudio.service.js).
 *
 * The video relay is video only. Audio inside the same MediaSource made the
 * picture lag (MediaSource plays only where every track is buffered, and the
 * cameras' audio arrives late and with gaps), so sound gets a separate
 * MediaSource that can fall behind, drop out or be missing without the
 * picture ever waiting for it.
 *
 * listen(monitorId, { variant, onState }) → stop(). Only an unmuted player
 * calls it, so muted tiles cost nothing. onState('playing' | 'noaudio' |
 * 'error') lets the player show that a camera has no microphone.
 */
import api from '@/core/services/api';
import { API_BASE } from '@/core/config/endpoints';
import { playSafe } from '@/core/players/relay/mseSink';

const MSE = typeof window !== 'undefined' ? (window.ManagedMediaSource || window.MediaSource) : null;

// Jitter buffer. The NVRs deliver audio in bursts: measured 2026-11-16, even
// a raw copy of the camera's G.711 arrived with pauses of 0.5-0.8 s and then
// several packets at once. Played right at the edge, every pause ran the
// buffer dry (sound cut out) and every burst then looked like lag (we jumped,
// another cut). So we keep `target` seconds of sound in hand, grow it each
// time the buffer still runs dry, shrink it back while it doesn't, and catch
// up after a burst by playing slightly fast (pitch is kept) instead of jumping.
//
// Tuned 2026-11-16 by replaying 2-minute captures of two cameras' real
// arrival times (gaps: median ~95 ms, p99 ~460 ms, worst 0.95 s and 2.7 s)
// through this logic: the delay/glitch sweet spot for <= ~1 s of delay. The
// rare multi-second NVR pause still costs one cut; covering it would need
// ~2.4 s of constant delay.
const TARGET_MIN   = 0.65; // s of audio buffered ahead at best
const TARGET_MAX   = 1.2;  // never more delay than this
const TARGET_STEP  = 0.1;  // added per dry buffer
const SHRINK_AFTER = 180_000; // ms without a dry buffer before stepping down
const CATCHUP_RATE = 1.05;
const FAST_OVER    = 0.8;  // s above target before we play fast…
const SLOW_UNDER   = 0.1;  // …and back to normal speed within this of target
const JUMP_OVER    = 2.0;  // s above target: jump (an audible cut) instead
const RESUME_AT    = 0.3;  // after running dry, refill this much before resuming
const KEEP_BEHIND  = 5;    // s of played audio kept in the buffer

export function audioSupported(mime = 'audio/mp4; codecs="mp4a.40.2"') {
  try { return !!(MSE && typeof WebSocket !== 'undefined' && MSE.isTypeSupported(mime)); } catch { return false; }
}

function wsUrl(ticket, monitorId) {
  const base = /^https?:/.test(API_BASE)
    ? API_BASE.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${API_BASE}`;
  // `cam` routes the socket to the replica that issued the ticket (nginx).
  return `${base}/api/stream/live?ticket=${encodeURIComponent(ticket)}&cam=${encodeURIComponent(monitorId)}`;
}

/** One MediaSource on an <audio> element, fed init + fragments, kept at the live edge. */
function createAudioSink(el) {
  let ms = null;
  let sb = null;
  let url = null;
  let queue = [];
  let tick = null;
  let lastTrim = 0;

  function pump() {
    if (!sb || sb.updating || !queue.length) return;
    try { sb.appendBuffer(queue.shift()); } catch (err) {
      if (err?.name === 'QuotaExceededError') { queue = []; trim(true); }
    }
  }
  function trim(force) {
    if (!sb || sb.updating || !el.buffered.length) return;
    const now = performance.now();
    if (!force && now - lastTrim < 5000) return;
    lastTrim = now;
    const start = el.buffered.start(0);
    const cut = el.currentTime - KEEP_BEHIND;
    if (cut > start + 1) { try { sb.remove(start, cut); } catch { /* ignore */ } }
  }
  let target = TARGET_MIN;
  let started = false;
  let refilling = false;
  let seekedAt = 0; // our own jumps also fire 'waiting': not a dry buffer
  let calmSince = performance.now();
  const seek = (t) => { seekedAt = performance.now(); el.currentTime = t; };

  // The buffer ran dry mid-play: the pauses are longer than what we hold.
  // Hold until RESUME_AT has refilled — resuming on the first few ms of a
  // burst just runs dry again at once (a stutter instead of one clean gap).
  function onWaiting() {
    if (!started || refilling || performance.now() - seekedAt < 1000) return;
    target = Math.min(TARGET_MAX, target + TARGET_STEP);
    calmSince = performance.now();
    refilling = true;
    el.playbackRate = 1;
    try { el.pause(); } catch { /* ignore */ }
  }
  el.addEventListener('waiting', onWaiting);

  function keepLive() {
    const b = el.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    const now = performance.now();
    if (!started) {
      // Fill the jitter buffer before the first sound, then start just
      // `target` behind the newest audio.
      if (end - b.start(b.length - 1) < target) return;
      started = true;
      calmSince = now;
      seek(Math.max(end - target, 0));
      playSafe(el);
      return;
    }
    if (now - calmSince > SHRINK_AFTER && target > TARGET_MIN) {
      target = Math.max(TARGET_MIN, target - 0.05);
      calmSince = now;
    }
    const lag = end - el.currentTime;
    if (refilling) {
      if (lag < RESUME_AT) return;
      refilling = false;
    }
    if (lag > target + JUMP_OVER || el.currentTime < b.start(b.length - 1)) {
      // Far behind (tab was asleep, long NVR pause) or stuck before a gap: one jump.
      seek(Math.max(end - target, 0));
      el.playbackRate = 1;
    } else if (lag > target + FAST_OVER) {
      el.playbackRate = CATCHUP_RATE;   // a burst arrived: drift back, no cut
    } else if (lag <= target + SLOW_UNDER) {
      el.playbackRate = 1;
    }
    if (el.paused) playSafe(el);
    trim(false);
  }
  function teardown() {
    if (tick) { clearInterval(tick); tick = null; }
    queue = [];
    sb = null;
    if (ms && ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* ignore */ } }
    ms = null;
    if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } url = null; }
  }
  return {
    init(mime, initU8) {
      teardown();
      started = false; // refill the jitter buffer (target is kept: same link)
      ms = new MSE();
      url = URL.createObjectURL(ms);
      el.src = url;
      queue = [initU8];
      ms.addEventListener('sourceopen', () => {
        if (!ms) return;
        try {
          sb = ms.addSourceBuffer(mime);
          sb.mode = 'segments';
          sb.addEventListener('updateend', pump);
          pump();
          tick = setInterval(keepLive, 200);
        } catch { /* unsupported: stay silent */ }
      }, { once: true });
    },
    frame(u8) {
      if (!ms) return;
      if (queue.length > 100) queue = []; // tab was asleep: drop, keepLive jumps
      queue.push(u8);
      pump();
    },
    reset: teardown,
    destroy() {
      teardown();
      el.removeEventListener('waiting', onWaiting);
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
    },
  };
}

export function listen(monitorId, { variant = 'sub', onState } = {}) {
  if (!audioSupported()) { onState?.('error'); return () => {}; }
  // No autoplay: keepLive() starts it once the jitter buffer is full.
  const el = new Audio();
  const sink = createAudioSink(el);
  let closed = false;
  let ws = null;
  let retry = 0;
  let timer = null;

  async function open() {
    if (closed) return;
    let ticket;
    try {
      const { data } = await api.post(`/stream/live/${encodeURIComponent(monitorId)}/ticket`, {}, {
        params: { variant, audio: '1' },
      });
      ticket = data.ticket;
    } catch {
      return again();
    }
    if (closed) return;
    const sock = new WebSocket(wsUrl(ticket, monitorId));
    sock.binaryType = 'arraybuffer';
    ws = sock;
    let mime = null;
    let expectInit = false;
    let done = false; // noaudio / error: don't reconnect
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.type === 'init') { mime = msg.mime; expectInit = true; }
        else if (msg.type === 'reset') sink.reset();
        else if (msg.type === 'noaudio' || msg.type === 'error') { done = true; onState?.(msg.type); }
        return;
      }
      const u8 = new Uint8Array(e.data);
      if (expectInit) {
        expectInit = false;
        retry = 0;
        sink.init(mime, u8);
        onState?.('playing');
        return;
      }
      sink.frame(u8);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (!done) again();
    };
  }

  function again() {
    if (closed) return;
    retry++;
    if (retry > 6) { onState?.('error'); return; }
    timer = setTimeout(open, Math.min(8000, 500 * 2 ** Math.min(retry, 4)));
  }

  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try { ws?.close(); } catch { /* closed */ }
    ws = null;
    sink.destroy();
  };
}
