// liveAudio.service: the audio-only live socket (kept out of the video relay
// so late camera audio can't hold the picture back).
const { EventEmitter } = require('node:events');
const audio = require('../src/services/liveAudio.service');

function fakeWs() {
  const ws = new EventEmitter();
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.closed = false;
  ws.send = (d) => ws.sent.push(d);
  ws.close = () => { ws.closed = true; };
  return ws;
}

describe('liveAudio ffmpeg args', () => {
  const args = audio._internals.ffmpegArgs('rtsp://example/cam');

  test('asks the RTSP server for the audio track only (no second copy of the video)', () => {
    expect(args[args.indexOf('-allowed_media_types') + 1]).toBe('audio');
    expect(args).toContain('-vn');
    expect(args[args.indexOf('-map') + 1]).toBe('0:a:0');
    expect(args).not.toContain('0:v:0');
  });

  test('re-encodes to AAC with gap filling into fragmented MP4 on stdout', () => {
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-af') + 1]).toMatch(/aresample=async/);
    expect(args[args.indexOf('-f') + 1]).toBe('mp4');
    expect(args[args.length - 1]).toBe('pipe:1');
  });
});

describe('liveAudio listeners', () => {
  afterEach(() => {
    audio._internals.noAudio.clear();
    for (const key of [...audio._internals.streams.keys()]) audio.stopAudio(key);
  });

  test('a camera known to have no audio gets noaudio at once and starts no ffmpeg', () => {
    const nvrUrl = 'rtsp://nvr/silent';
    audio._internals.noAudio.set(nvrUrl, Date.now() + 60_000);
    const ws = fakeWs();
    audio.addListener(ws, { path: 'cam_x_sub', monitorId: 'x', nvrUrl });
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'noaudio' });
    expect(ws.closed).toBe(true);
    expect(audio._internals.streams.size).toBe(0);
  });

  test('the stall watchdog kills a stream that stopped sending audio', () => {
    const kill = jest.fn();
    const s = { key: 'k', path: 'p', listeners: new Set(), proc: { kill }, stopped: false, init: Buffer.alloc(1), startedAt: 0, lastFragAt: 1000 };
    audio._internals.streams.set('k', s);
    audio._internals.sweepStalled(1000 + 60_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(s.killReason).toMatch(/no audio data/);
    s.proc = null; // nothing to restart in a test
  });
});
