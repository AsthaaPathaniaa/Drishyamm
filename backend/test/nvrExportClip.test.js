// What an evidence clip has to be, enforced where the clip is produced.
//
// The export used to write a FRAGMENTED mp4 straight to a pipe
// (`-movflags frag_keyframe+empty_moov+default_base_moof`, `-f mp4 pipe:1`) and
// end ffmpeg with SIGKILL. Measured on that command's own output, the header it
// writes declares `mvhd duration 0` — no player can be told how long the clip
// is — and the fragment index (`mfra`) is only written in the trailer, which a
// SIGKILLed ffmpeg never reaches. An evidence clip nobody can scrub is not
// evidence, so now: a real file, finalised, sent with a Content-Length; ffmpeg
// ASKED to stop before it is killed; the temp file gone on every path; and a
// breach clip capped at the window clipWindow() pads.
//
// These tests drive the real handler with a fake ffmpeg, so they assert what
// the controller does with the file and the process, not how it is spelled.
// The flags themselves are checked against real ffmpeg in
// nvrExportClip.ffmpeg.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const spawned = [];
jest.mock('node:child_process', () => ({
  spawn: jest.fn((cmd, args) => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.signals = [];
    proc.kill = jest.fn((sig) => { proc.signals.push(sig); return true; });
    proc.args = args;
    proc.outPath = args[args.length - 1];   // where the clip is recorded
    spawned.push(proc);
    return proc;
  }),
}));

jest.mock('../src/models', () => ({ Camera: { findOne: jest.fn() }, CameraGroup: {} }));
// The encoder probe would spawn the (fake, never-exiting) ffmpeg too; this file
// tests the export's lifecycle, so pin the CPU encoder (h264Encode.test.js covers the choice).
jest.mock('../src/services/h264Encode', () => ({
  h264Encode: async () => ({ name: 'libx264', input: [], video: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] }),
}));
jest.mock('../src/services/vendors', () => ({
  supportsPlayback: () => true,
  buildPlaybackPath: () => '/Streaming/tracks/101',
}));
jest.mock('../src/services/streamRouter.service', () => ({
  buildRtspUrl: () => 'rtsp://user:secret@10.0.0.9:554/Streaming/tracks/101',
}));
jest.mock('../src/services/drishyamStreaming.service', () => ({ api: { delete: jest.fn() } }));
jest.mock('../src/services/nvrRecordingSearch.service', () => ({ searchRecordings: jest.fn() }));
jest.mock('../src/services/edgeRelay.service', () => ({
  parseEdgeCamera: () => null,
  openReplay: jest.fn(),
  closeReplay: jest.fn(),
}));
jest.mock('../src/services/liveRelay.service', () => ({
  issueTicket: jest.fn(), stopRelay: jest.fn(), attach: jest.fn(),
}));
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { Camera } = require('../src/models');
const ctrl = require('../src/controllers/playback.controller');

// ── fixtures ────────────────────────────────────────────────────────────────
const box = (type, body) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(8 + body.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), body]);
};
// A finalised clip: ftyp, then the moov (duration + seek index) AHEAD of the
// media, which is what +faststart produces.
const CLIP = Buffer.concat([
  box('ftyp', Buffer.from('isom')),
  box('moov', Buffer.alloc(64, 1)),
  box('mdat', Buffer.alloc(512, 7)),
]);
// What an ffmpeg killed before its trailer leaves behind: media, no moov. Bytes
// on disk, but not a clip.
const RUBBLE = Buffer.concat([
  box('ftyp', Buffer.from('isom')),
  box('mdat', Buffer.alloc(512, 7)),
]);

const START = '2026-11-20T10:00:00.000Z';
const at = (ms) => new Date(Date.parse(START) + ms).toISOString();

// The handler awaits real file I/O (stat, the moov scan, then the send), so the
// tests wait for what they are about to assert rather than for a tick count.
// Fake timers leave setImmediate alone, so this turns the loop under both.
const step = () => new Promise((r) => setImmediate(r));
const flush = async (turns = 50) => { for (let i = 0; i < turns; i += 1) await step(); };
const settle = async (done, turns = 20_000) => {
  for (let i = 0; i < turns; i += 1) {
    if (done()) return true;
    await step();
  }
  return false;
};

function makeRes() {
  const res = new PassThrough();
  res.statusCode = 200;
  res.headers = {};
  res.chunks = [];
  res.body = undefined;
  res.headersSent = false;
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; res.end(); return res; };
  res.on('data', (c) => res.chunks.push(c));
  res.on('error', () => { /* a destroyed response is one of the cases under test */ });
  return res;
}

// Starts the handler and returns once it has reached ffmpeg (if it gets there).
async function startExport(query = {}) {
  const res = makeRes();
  const state = { err: undefined };
  const req = {
    query: { monitorId: 'cam1', start: START, end: at(60_000), ...query },
    user: { id: 'u1' },
    destroyed: false,
  };
  const before = spawned.length;
  ctrl.exportNvrClip(req, res, (e) => { state.err = e; });
  await settle(() => spawned.length > before || state.err !== undefined);
  return { res, req, state, proc: spawned[spawned.length - 1] };
}

// Hands the fake ffmpeg's output over and waits for the handler to be done with
// it: the clip is sent (or refused) and the temp file is gone.
async function finish(res, proc, { file, code = 0, signal = null } = {}) {
  if (file) fs.writeFileSync(proc.outPath, file);
  proc.emit('close', code, signal);
  await settle(() => res.writableFinished || res.body !== undefined);
  await settle(() => !fs.existsSync(proc.outPath));
}

beforeEach(() => {
  spawned.length = 0;
  Camera.findOne.mockResolvedValue({
    monitorId: 'cam1', name: 'Gate', channel: 1, host: '10.0.0.9',
    deviceType: 'hikvision', group: null,
  });
});

afterEach(() => {
  for (const p of spawned) { try { fs.rmSync(p.outPath, { force: true }); } catch { /* gone */ } }
  jest.useRealTimers();
});

// ── the command ─────────────────────────────────────────────────────────────
describe('exportArgs', () => {
  test('writes a finalised file with its timeline rebased, not a fragmented pipe', () => {
    const args = ctrl.exportArgs('rtsp://nvr/track', 60, 'mp4', '/tmp/clip.mp4');
    const line = args.join(' ');
    expect(line).toContain('-avoid_negative_ts make_zero');   // frame one at timeline 0
    expect(line).toContain('-movflags +faststart');           // duration + index, in front
    expect(args[args.length - 1]).toBe('/tmp/clip.mp4');
    expect(line).not.toContain('pipe:1');
    expect(line).not.toContain('empty_moov');
    expect(line).not.toContain('frag_keyframe');
  });

  test('-t stays where it was: the window still sets the clip length', () => {
    const args = ctrl.exportArgs('rtsp://nvr/track', 1800, 'mp4', '/tmp/c.mp4');
    expect(args[args.indexOf('-i') + 2]).toBe('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('1800');
  });
});

// ── a clip that can be scrubbed ─────────────────────────────────────────────
test('a finished clip is sent with a real Content-Length, then deleted', async () => {
  const { res, proc } = await startExport();
  expect(fs.existsSync(proc.outPath)).toBe(false);     // nothing before ffmpeg writes
  await finish(res, proc, { file: CLIP });

  expect(res.statusCode).toBe(200);
  expect(res.headers['Content-Length']).toBe(String(CLIP.length));
  expect(res.headers['Content-Type']).toBe('video/mp4');
  expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename=".+[.]mp4"$/);
  expect(Buffer.concat(res.chunks).equals(CLIP)).toBe(true);
  expect(fs.existsSync(proc.outPath)).toBe(false);     // and nothing left behind
});

test('the account is free to export again once the clip has been sent', async () => {
  const first = await startExport();
  await finish(first.res, first.proc, { file: CLIP });

  const second = await startExport();
  expect(second.state.err).toBeUndefined();
  expect(second.proc).not.toBe(first.proc);
  await finish(second.res, second.proc, { code: 1 });
});

test('an export with no footage is reported, not handed over as a file', async () => {
  const { res, proc } = await startExport();
  proc.stderr.emit('data', Buffer.from('rtsp://user:secret@10.0.0.9:554/x: 404 Not Found'));
  await finish(res, proc, { code: 1 });

  expect(res.statusCode).toBe(502);
  expect(res.body).toMatchObject({ success: false });
  expect(res.chunks).toHaveLength(0);
});

test('a part-written file with no moov is refused: it would not play', async () => {
  const { res, proc } = await startExport();
  await finish(res, proc, { file: RUBBLE, code: null, signal: 'SIGKILL' });

  expect(res.statusCode).toBe(502);
  expect(res.chunks).toHaveLength(0);
  expect(fs.existsSync(proc.outPath)).toBe(false);
});

test('hasMoovBox tells a clip from rubble', async () => {
  const good = path.join(os.tmpdir(), 'nvr-export-unit-good.mp4');
  const bad = path.join(os.tmpdir(), 'nvr-export-unit-bad.mp4');
  fs.writeFileSync(good, CLIP);
  fs.writeFileSync(bad, RUBBLE);
  try {
    await expect(ctrl.hasMoovBox(good)).resolves.toBe(true);
    await expect(ctrl.hasMoovBox(bad)).resolves.toBe(false);
    await expect(ctrl.hasMoovBox(`${good}.missing`)).resolves.toBe(false);
  } finally {
    fs.rmSync(good, { force: true });
    fs.rmSync(bad, { force: true });
  }
});

// ── cancelled download ──────────────────────────────────────────────────────
test('a cancelled download stops the NVR pull and leaves no temp file behind', async () => {
  const { res, proc } = await startExport();
  fs.writeFileSync(proc.outPath, CLIP);          // part-recorded when the tab closed
  res.destroy();                                 // browser went away
  await settle(() => proc.signals.length > 0);
  expect(proc.signals).toContain('SIGKILL');     // nothing to finalise: stop at once

  proc.emit('close', null, 'SIGKILL');
  expect(await settle(() => !fs.existsSync(proc.outPath))).toBe(true);
  expect(res.chunks).toHaveLength(0);
});

// ── the time backstop ───────────────────────────────────────────────────────
describe('the hard stop', () => {
  test('asks ffmpeg to stop, so the clip recorded so far is still playable', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { res, proc } = await startExport({ end: at(60_000) });

    jest.advanceTimersByTime((60 + 90) * 1000);   // durationSec + 90
    await settle(() => proc.signals.length > 0);
    expect(proc.signals).toEqual(['SIGINT']);     // not SIGKILL

    // ffmpeg finalises and exits the way it does when it handles a signal
    // itself: a code, and no signal.
    await finish(res, proc, { file: CLIP, code: 255 });

    expect(proc.signals).toEqual(['SIGINT']);     // the fallback never fired
    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(res.chunks).equals(CLIP)).toBe(true);
    expect(fs.existsSync(proc.outPath)).toBe(false);
  });

  test('falls back to SIGKILL only if ffmpeg ignores the ask', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { res, proc } = await startExport({ end: at(60_000) });

    jest.advanceTimersByTime((60 + 90) * 1000);
    await settle(() => proc.signals.length > 0);
    expect(proc.signals).toEqual(['SIGINT']);

    jest.advanceTimersByTime(14_000);             // still inside the grace
    await flush();
    expect(proc.signals).toEqual(['SIGINT']);

    jest.advanceTimersByTime(2_000);
    await settle(() => proc.signals.length > 1);
    expect(proc.signals).toEqual(['SIGINT', 'SIGKILL']);

    await finish(res, proc, { code: null, signal: 'SIGKILL' });
  });
});

// ── window limits ───────────────────────────────────────────────────────────
describe('how long a clip may be', () => {
  test('a breach clip cannot exceed the window clipWindow() pads', async () => {
    // clipWindow(): 15 s before the breach to 45 s after. That exact window:
    const ok = await startExport({ kind: 'breach', start: START, end: at(60_000) });
    expect(ok.state.err).toBeUndefined();
    expect(ok.proc).toBeDefined();
    await finish(ok.res, ok.proc, { code: 1 });

    const tooLong = await startExport({ kind: 'breach', start: START, end: at(61_000) });
    expect(tooLong.state.err).toMatchObject({ statusCode: 400 });
    expect(tooLong.state.err.message).toMatch(/60 seconds or less/);

    const hours = await startExport({ kind: 'breach', start: START, end: at(6 * 3600_000) });
    expect(hours.state.err).toMatchObject({ statusCode: 400 });
  });

  test('the general 30-minute limit is unchanged', async () => {
    const ok = await startExport({ start: START, end: at(30 * 60_000) });
    expect(ok.state.err).toBeUndefined();
    expect(ok.proc.args[ok.proc.args.indexOf('-t') + 1]).toBe('1800');
    await finish(ok.res, ok.proc, { code: 1 });

    const tooLong = await startExport({ start: START, end: at(30 * 60_000 + 1000) });
    expect(tooLong.state.err).toMatchObject({ statusCode: 400 });
    expect(tooLong.state.err.message).toMatch(/30 minutes or less/);
  });

  test('a rejected window never claims the one-export-per-account slot', async () => {
    const bad = await startExport({ kind: 'breach', end: at(10 * 60_000) });
    expect(bad.state.err).toMatchObject({ statusCode: 400 });

    const good = await startExport();
    expect(good.state.err).toBeUndefined();
    expect(good.proc).toBeDefined();
    await finish(good.res, good.proc, { code: 1 });
  });
});
