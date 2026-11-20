// Which H.264 encoder the live transcoder uses, on any host.
//
// The old detection picked the first hardware encoder that `ffmpeg -encoders`
// LISTED. The backend image lists h264_nvenc everywhere, so a host without an
// NVIDIA GPU (or a container without GPU access) started every transcoder on
// NVENC, failed twice and only then fell back to libx264. These tests pin the
// replacement: candidates are tried with a test encode, in order, and the
// first that works wins; nothing works → libx264.

const videoEncoder = require('../src/services/videoEncoder');

const { selectEncoder, findVaapiDevice, testEncodeArgs, hardwareCandidates, asEncoder, SOFTWARE } = videoEncoder;

// A fake ffmpeg: passes the test encode only for the encoders in `works`.
const fakeRun = (works) => {
  const tried = [];
  const run = async (args) => {
    const name = args[args.indexOf('-c:v') + 1];
    tried.push(name);
    return works.includes(name);
  };
  return { run, tried };
};

describe('selectEncoder', () => {
  test('TRANSCODER_ALLOW_HW off: libx264 without running anything', async () => {
    const { run, tried } = fakeRun(['h264_nvenc']);
    expect(await selectEncoder({ allowHw: false, run })).toBe(SOFTWARE);
    expect(tried).toEqual([]);
  });

  test('NVIDIA host: NVENC passes first and is used', async () => {
    const { run, tried } = fakeRun(['h264_nvenc', 'h264_vaapi']);
    const enc = await selectEncoder({ allowHw: true, run, vaapiDevice: '/dev/dri/renderD128' });
    expect(enc.name).toBe('h264_nvenc');
    expect(tried).toEqual(['h264_nvenc']);
  });

  test('Intel/AMD host: NVENC fails its test, VAAPI on the render node is used', async () => {
    const { run, tried } = fakeRun(['h264_vaapi']);
    const enc = await selectEncoder({ allowHw: true, run, vaapiDevice: '/dev/dri/renderD128' });
    expect(enc.name).toBe('h264_vaapi');
    expect(enc.inputArgs).toEqual(['-vaapi_device', '/dev/dri/renderD128']);
    expect(tried).toEqual(['h264_nvenc', 'h264_vaapi']);
  });

  test('no GPU at all: every candidate fails, libx264', async () => {
    const { run, tried } = fakeRun([]);
    expect(await selectEncoder({ allowHw: true, run, vaapiDevice: '/dev/dri/renderD128' })).toBe(SOFTWARE);
    expect(tried).toEqual(['h264_nvenc', 'h264_vaapi', 'h264_qsv', 'h264_amf']);
  });

  test('no render node visible: VAAPI is not tried', async () => {
    const { run, tried } = fakeRun([]);
    await selectEncoder({ allowHw: true, run, vaapiDevice: null });
    expect(tried).not.toContain('h264_vaapi');
  });

  test('an encoder demoted at runtime is skipped on the next selection', async () => {
    const { run, tried } = fakeRun(['h264_nvenc', 'h264_vaapi']);
    const enc = await selectEncoder({ allowHw: true, run, vaapiDevice: '/dev/dri/renderD128', skip: new Set(['h264_nvenc']) });
    expect(enc.name).toBe('h264_vaapi');
    expect(tried).toEqual(['h264_vaapi']);
  });

  test('a test run that throws counts as a failure, not a crash', async () => {
    const run = async (args) => {
      if (args.includes('h264_nvenc')) throw new Error('spawn ENOENT');
      return false;
    };
    expect(await selectEncoder({ allowHw: true, run })).toBe(SOFTWARE);
  });
});

describe('findVaapiDevice', () => {
  test('TRANSCODER_VAAPI_DEVICE wins', () => {
    expect(findVaapiDevice({ envDevice: '/dev/dri/renderD129', listDir: () => ['renderD128'] })).toBe('/dev/dri/renderD129');
  });

  test('first render node, not card nodes', () => {
    expect(findVaapiDevice({ listDir: () => ['card1', 'renderD129', 'by-path', 'renderD128'] })).toBe('/dev/dri/renderD128');
  });

  test('no /dev/dri in the container: null', () => {
    expect(findVaapiDevice({ listDir: () => { throw new Error('ENOENT'); } })).toBeNull();
    expect(findVaapiDevice({ listDir: () => [] })).toBeNull();
  });
});

describe('testEncodeArgs', () => {
  test('VAAPI test uploads frames to the GPU and opens the device before the input', () => {
    const vaapi = hardwareCandidates({ vaapiDevice: '/dev/dri/renderD128' }).find((e) => e.name === 'h264_vaapi');
    const args = testEncodeArgs(vaapi);
    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-vf') + 1]).toBe('format=nv12,hwupload');
    expect(args).not.toContain('-pix_fmt');
  });

  test('other encoders get plain yuv420p frames', () => {
    const args = testEncodeArgs(SOFTWARE);
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args).not.toContain('-vf');
  });
});

describe('asEncoder', () => {
  test('a bare args array (older callers) becomes an encoder without GPU upload', () => {
    const enc = asEncoder(['-c:v', 'h264_nvenc', '-preset', 'fast']);
    expect(enc).toMatchObject({ name: 'h264_nvenc', inputArgs: [], hwUpload: null });
  });
});

describe('transcoder buildFfmpegArgs with the selected encoder', () => {
  // The service only needs these at require time; nothing is spawned here.
  jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  jest.mock('../src/queues', () => ({ isEnabled: () => false, QUEUE_NAMES: {}, getQueue: jest.fn(), getQueueEvents: jest.fn() }));
  jest.mock('../src/models', () => ({ Camera: { findOne: jest.fn(async () => null) } }));
  const { buildFfmpegArgs } = require('../src/services/transcoder.service')._internals;
  const vaapi = hardwareCandidates({ vaapiDevice: '/dev/dri/renderD128' }).find((e) => e.name === 'h264_vaapi');
  const nvenc = hardwareCandidates().find((e) => e.name === 'h264_nvenc');

  test('VAAPI: device before -i, upload after the scale, no forced pix_fmt', () => {
    for (const lowProfile of [false, true]) {
      const args = buildFfmpegArgs('rtsp://src', 'rtsp://dst', vaapi, { lowProfile });
      expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
      expect(args[args.indexOf('-vf') + 1]).toMatch(/^scale=.*,format=nv12,hwupload$/);
      expect(args).not.toContain('-pix_fmt');
      expect(args[args.indexOf('-c:v') + 1]).toBe('h264_vaapi');
    }
  });

  test('NVENC and libx264: unchanged shape (yuv420p, plain scale)', () => {
    for (const enc of [nvenc, SOFTWARE]) {
      const args = buildFfmpegArgs('rtsp://src', 'rtsp://dst', enc);
      expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
      expect(args[args.indexOf('-vf') + 1]).toBe("scale=-2:'min(1080,ih)'");
      expect(args).not.toContain('-vaapi_device');
    }
  });

  test('the 360p grid profile keeps libx264 on ultrafast', () => {
    const args = buildFfmpegArgs('rtsp://src', 'rtsp://dst', SOFTWARE, { lowProfile: true });
    expect(args.lastIndexOf('-preset')).toBeGreaterThan(args.indexOf('libx264'));
    expect(args[args.lastIndexOf('-preset') + 1]).toBe('ultrafast');
  });
});
