// Recorded playback has right of way on its NVR: starting it claims the
// recorder (background work yields) and releases the warm-keeper's unwatched
// sub-streams there; ending it gives the NVR back. A relay replay whose relay
// is gone (tab closed without the stop beacon) must not keep the claim for
// the 30-minute session cap.

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/config/env', () => ({ streamService: { hlsUrl: 'http://hls', webrtcUrl: 'http://rtc' } }));
jest.mock('../src/models', () => ({ Camera: {}, CameraGroup: {} }));
jest.mock('../src/services/vendors', () => ({ supportsPlayback: () => true }));
jest.mock('../src/services/streamRouter.service', () => ({ buildRtspUrl: () => 'rtsp://nvr/replay' }));
jest.mock('../src/services/drishyamStreaming.service', () => ({ api: { delete: jest.fn() } }));
jest.mock('../src/services/nvrRecordingSearch.service', () => ({}));
jest.mock('../src/services/edgeRelay.service', () => ({ closeReplay: jest.fn(), parseEdgeCamera: () => null }));
const mockRunning = new Set();
jest.mock('../src/services/liveRelay.service', () => ({
  stopRelay: jest.fn(), isRunning: (p) => mockRunning.has(p), sessionsOnHost: () => 0,
}));
const mockYield = jest.fn(async () => ({ released: 0 }));
jest.mock('../src/services/streamWarm.service', () => ({ yieldForMain: (c) => mockYield(c) }));

process.env.NVR_LOAD_REFRESH_MS = '0';
const nvrLoad = require('../src/services/nvrLoad.service');
const { _internals: { sessions, stopSession, sweepEndedRelaySessions, claimNvr } } = require('../src/controllers/playback.controller');

const cam = (over = {}) => ({
  camera: { monitorId: 'm1', host: '10.0.0.1' }, group: { host: '10.0.0.1' }, deviceType: 'hikvision', edge: null, ...over,
});

beforeEach(() => { nvrLoad._internals.reset(); sessions.clear(); mockRunning.clear(); mockYield.mockClear(); });

test('playback claims its NVR, tracks its pull and frees warm sub-streams there', () => {
  const nvr = claimNvr(cam(), 'playback');
  expect(nvrLoad.interactiveActive('10.0.0.1')).toBe(true);
  expect(nvrLoad.usage('10.0.0.1').byKind.playback).toBe(1);
  expect(mockYield).toHaveBeenCalledWith({ host: '10.0.0.1', monitorId: 'm1' });
  nvr.release();
  nvr.release();
  expect(nvrLoad.interactiveActive('10.0.0.1')).toBe(false);
  expect(nvrLoad.usage('10.0.0.1').total).toBe(0);
});

test('a camera addressed by its own host claims that host too', () => {
  const nvr = claimNvr(cam({ camera: { monitorId: 'm1', host: '10.0.0.7' } }), null);
  expect(nvrLoad.interactiveActive('10.0.0.1')).toBe(true);
  expect(nvrLoad.interactiveActive('10.0.0.7')).toBe(true);
  nvr.release();
  expect(nvrLoad.interactiveActive('10.0.0.7')).toBe(false);
});

test('site-relay cameras claim nothing (their relay paces them)', () => {
  const nvr = claimNvr(cam({ edge: { site: 's' } }), 'playback');
  expect(nvr.load).toBeNull();
  expect(mockYield).not.toHaveBeenCalled();
  expect(nvrLoad._internals.claims.size).toBe(0);
});

test('stopping a session gives the NVR back', () => {
  const nvr = claimNvr(cam(), null);
  sessions.set('pb_m1_1', { relay: true, release: nvr.release, startedAt: Date.now(), timer: null });
  stopSession('pb_m1_1');
  expect(nvrLoad.interactiveActive('10.0.0.1')).toBe(false);
});

test('a relay replay whose relay ended is closed by the sweep; a connecting or running one is kept', () => {
  const now = Date.now();
  const mk = (path, age) => {
    const nvr = claimNvr(cam(), null);
    sessions.set(path, { relay: true, release: nvr.release, startedAt: now - age, timer: null });
  };
  mk('pb_ended', 120_000);
  mk('pb_running', 120_000);
  mk('pb_connecting', 5_000);
  mockRunning.add('pb_running');
  sweepEndedRelaySessions(now);
  expect([...sessions.keys()].sort()).toEqual(['pb_connecting', 'pb_running']);
  expect(nvrLoad._internals.claims.get('10.0.0.1')).toBe(2);
});
