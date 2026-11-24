// One-off H.264 encodes (export as MP4, evidence H.264 copy) use the GPU the
// transcoder found; libx264 only when there is none.
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn() }));
const mockEncoder = { current: null };
jest.mock('../src/services/transcoder.service', () => ({
  _internals: { detectEncoder: async () => { if (mockEncoder.current === 'boom') throw new Error('probe'); return { encoder: mockEncoder.current }; } },
}));
const { h264Encode, CPU } = require('../src/services/h264Encode');
const { exportArgs } = require('../src/controllers/playback.controller');

test('NVENC host: decode and encode on the GPU', async () => {
  mockEncoder.current = { name: 'h264_nvenc', inputArgs: [], args: ['-c:v', 'h264_nvenc', '-preset', 'fast', '-bf', '0'], hwUpload: null };
  const e = await h264Encode();
  expect(e.input).toEqual(['-hwaccel', 'cuda']);
  expect(e.video).toEqual(['-c:v', 'h264_nvenc', '-preset', 'fast', '-bf', '0', '-pix_fmt', 'yuv420p']);
  const args = exportArgs('rtsp://nvr/x', 60, 'mp4', '/tmp/c.mp4', e);
  expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'));
  expect(args).toContain('h264_nvenc');
  expect(args).not.toContain('libx264');
});

test('VAAPI host uploads frames to the device', async () => {
  mockEncoder.current = { name: 'h264_vaapi', inputArgs: ['-vaapi_device', '/dev/dri/renderD128'], args: ['-c:v', 'h264_vaapi'], hwUpload: 'format=nv12,hwupload' };
  const e = await h264Encode();
  expect(e.input).toEqual(['-vaapi_device', '/dev/dri/renderD128']);
  expect(e.video.slice(0, 2)).toEqual(['-vf', 'format=nv12,hwupload']);
});

test('no GPU encoder, or the probe fails: libx264', async () => {
  mockEncoder.current = { name: 'libx264', args: [] };
  expect(await h264Encode()).toBe(CPU);
  mockEncoder.current = 'boom';
  expect(await h264Encode()).toBe(CPU);
});

test('original stays a stream copy, never re-encoded', () => {
  const args = exportArgs('rtsp://nvr/x', 60, 'original', '/tmp/c.mp4', { input: ['-hwaccel', 'cuda'], video: ['-c:v', 'h264_nvenc'] });
  expect(args).not.toContain('-hwaccel');
  expect(args.join(' ')).toContain('-c:v copy');
});
