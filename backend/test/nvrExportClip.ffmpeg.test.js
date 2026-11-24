// The export command, checked against real ffmpeg rather than against itself.
//
// The unit test next door asserts the flags; this one asserts what they
// PRODUCE, because that is the whole claim: an exported clip reports its true
// duration, its first frame is at timeline 0, and it can be scrubbed. The old
// command (`frag_keyframe+empty_moov+default_base_moof` to `pipe:1`) wrote
// `mvhd duration 0` — a header that declares no length at all — so these
// assertions are what stops that coming back.
//
// Skipped where ffmpeg is not installed (CI images mostly), so it never turns
// the suite red for a missing binary. The real-signal case is POSIX-only:
// Windows has no SIGINT to send a child process.

const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ctrl = require('../src/controllers/playback.controller');

const have = (bin) => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
};
const HAVE_FFMPEG = have('ffmpeg') && have('ffprobe');
const describeFf = HAVE_FFMPEG ? describe : describe.skip;

let workDir;
let source;

// A recorder's own file, stamped as if the footage were shot at 14:32: its
// first timestamp is 52 320 s into the timeline. That is the shape of input
// that made a short clip read as hours long.
const SOURCE_TS_OFFSET = 52_320;
const SOURCE_SECONDS = 6;
const CLIP_SECONDS = 4;

function run(args) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr}`);
  return r;
}

function probe(file, entries) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', entries, '-of', 'default=noprint_wrappers=1', file,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return Object.fromEntries(
    r.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split('=')),
  );
}

/** Top-level MP4 boxes, in file order: `['ftyp', 'moov', 'mdat']`. */
function boxes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const head = Buffer.alloc(16);
    const out = [];
    for (let off = 0; off + 8 <= size;) {
      const n = fs.readSync(fd, head, 0, 16, off);
      if (n < 8) break;
      let len = head.readUInt32BE(0);
      let hdr = 8;
      out.push(head.toString('latin1', 4, 8));
      if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; }
      else if (len === 0) break;
      if (len < hdr) break;
      off += len;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** The duration the movie header declares, in seconds. `empty_moov` wrote 0. */
function mvhdSeconds(file) {
  const b = fs.readFileSync(file);
  const i = b.indexOf(Buffer.from('mvhd'));
  if (i < 0) return null;
  const version = b[i + 4];
  const o = i + 8;                                  // past version + flags
  const timescale = version === 1 ? b.readUInt32BE(o + 16) : b.readUInt32BE(o + 8);
  const duration = version === 1
    ? Number(b.readBigUInt64BE(o + 20))
    : b.readUInt32BE(o + 12);
  return timescale ? duration / timescale : null;
}

// exportArgs builds an RTSP pull; `-rtsp_transport` is a private option of that
// demuxer and ffmpeg refuses it for a file input ("Option rtsp_transport not
// found"), so only those two tokens are dropped here. Everything under test —
// -t, the codec, -avoid_negative_ts, -movflags, the output file — is exactly
// what production runs.
function exportFromFile(input, seconds, format, out) {
  const args = ctrl.exportArgs(input, seconds, format, out);
  const i = args.indexOf('-rtsp_transport');
  if (i >= 0) args.splice(i, 2);
  return args;
}

beforeAll(() => {
  if (!HAVE_FFMPEG) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-export-ffmpeg-'));
  source = path.join(workDir, 'source.mp4');
  run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${SOURCE_SECONDS}:size=160x120:rate=10`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-output_ts_offset', String(SOURCE_TS_OFFSET),
    source,
  ]);
  // The premise: the source really is stamped hours in.
  expect(Number(probe(source, 'format=start_time').start_time)).toBeCloseTo(SOURCE_TS_OFFSET, 0);
});

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describeFf('an exported clip', () => {
  for (const format of ['original', 'mp4']) {
    test(`reports its true duration and starts at timeline 0 (${format})`, () => {
      const out = path.join(workDir, `clip-${format}.mp4`);
      run(exportFromFile(source, CLIP_SECONDS, format, out));

      const f = probe(out, 'format=duration,start_time');
      // A stream-copied clip starts exactly at 0; a re-encoded one carries the
      // H.264 encoder's own delay (a fifth of a second), which is the codec,
      // not the recorder's clock. Either way: the start of the clip, not hours
      // into the day.
      expect(Number(f.start_time)).toBeLessThan(0.5);
      if (format === 'original') expect(Number(f.start_time)).toBe(0);
      expect(Number(f.duration)).toBeCloseTo(CLIP_SECONDS, 0);    // not 52 324 s
      // The header itself carries the length — what empty_moov left at 0.
      expect(mvhdSeconds(out)).toBeCloseTo(CLIP_SECONDS, 0);
    });
  }

  test('can be scrubbed: the moov is finalised and sits ahead of the media', async () => {
    const out = path.join(workDir, 'clip-faststart.mp4');
    run(exportFromFile(source, CLIP_SECONDS, 'original', out));

    const order = boxes(out);
    expect(order).toContain('moov');
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'));   // +faststart
    expect(order).not.toContain('moof');                                 // not fragmented
    await expect(ctrl.hasMoovBox(out)).resolves.toBe(true);
  });
});

// Only ffmpeg can finalise the file, which is why the backstop asks it to stop
// instead of killing it. POSIX only: Node cannot send SIGINT on Windows.
const describeSignals = HAVE_FFMPEG && process.platform !== 'win32' ? describe : describe.skip;

describeSignals('ending a running export', () => {
  jest.setTimeout(30_000);

  // A clip that is still being written when we stop it: lavfi at real speed.
  const startLongExport = (out) => spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-re', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10',
    '-t', '60', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
    '-f', 'mp4', out,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const closed = (proc) => new Promise((r) => proc.once('close', r));
  const after = (ms) => new Promise((r) => setTimeout(r, ms));

  test('SIGINT leaves a playable clip; SIGKILL leaves rubble', async () => {
    const asked = path.join(workDir, 'asked.mp4');
    const killed = path.join(workDir, 'killed.mp4');

    const a = startLongExport(asked);
    await after(3000);
    ctrl.endExportFfmpeg(a);          // what the hard stop now does
    await closed(a);
    await expect(ctrl.hasMoovBox(asked)).resolves.toBe(true);
    expect(Number(probe(asked, 'format=duration').duration)).toBeGreaterThan(0);

    const k = startLongExport(killed);
    await after(3000);
    k.kill('SIGKILL');                // what it used to do
    await closed(k);
    await expect(ctrl.hasMoovBox(killed)).resolves.toBe(false);
  });
});
