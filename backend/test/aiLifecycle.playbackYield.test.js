// AI detection gives the NVR's uplink to recorded playback: while footage is
// replayed from a recorder, detection on that recorder's cameras is stopped,
// and it restarts when the last playback there ends (2026-11-21: two AI main
// streams left playback at half real time on a ~1 Mbit/s NVR uplink).

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/config/env', () => ({ aiServiceUrl: 'http://ai' }));
jest.mock('../src/services/aiClockSkew', () => ({ recordAiClock: () => {} }));
jest.mock('../src/services/entitlements.service', () => ({ getAiEntitledUserIds: async () => new Set(['u1', 'u2']) }));
const mockCameras = [];
jest.mock('../src/models', () => ({ Camera: { findAll: async () => mockCameras }, CameraGroup: {} }));
jest.mock('../src/services/liveRelay.service', () => ({ sessionsOnHost: () => 0 }));
const mockRuntime = {};
const mockPosts = [];
jest.mock('axios', () => ({
  get: jest.fn(async () => ({ data: { cameras: mockRuntime }, headers: {} })),
  post: jest.fn(async (url, body) => {
    const id = body.get('monitor_id');
    mockPosts.push(`${url.split('/').pop()} ${id}`);
    mockRuntime[id] = { running: url.endsWith('/set-camera') };
    return { data: {} };
  }),
}));

process.env.NVR_LOAD_REFRESH_MS = '0';
process.env.NVR_CLAIM_GRACE_MS = '0';
const nvrLoad = require('../src/services/nvrLoad.service');
const ai = require('../src/services/aiLifecycle.service');

const cam = (monitorId, host, groupHost = null) => ({
  monitorId, host, group: groupHost ? { host: groupHost } : null, userId: 'u1',
  settings: { ai: { enabled: true, mode: 'continuous' } },
});

beforeEach(() => {
  nvrLoad._internals.reset();
  mockCameras.length = 0;
  mockPosts.length = 0;
  for (const k of Object.keys(mockRuntime)) delete mockRuntime[k];
});

test("a user's playback pauses detection on their cameras on that NVR only, and ending it resumes", async () => {
  const otherUsers = { ...cam('o', '10.0.0.1'), userId: 'u2' };
  mockCameras.push(cam('a', '10.0.0.1'), cam('b', '10.0.0.2'), otherUsers);
  mockRuntime.a = { running: true };
  mockRuntime.b = { running: true };
  mockRuntime.o = { running: true };

  const release = nvrLoad.claim('10.0.0.1', 'u1');
  await ai.reconcile();
  expect(mockPosts).toEqual(['stop-camera a']);
  expect(ai._internals.paused.has('a')).toBe(true);

  await ai.reconcile();                       // still replaying: stays stopped
  expect(mockPosts).toEqual(['stop-camera a']);

  release();
  await ai.reconcile();
  expect(mockPosts).toEqual(['stop-camera a', 'set-camera a']);
  expect(ai._internals.paused.has('a')).toBe(false);
});

test("a camera is matched by its group's NVR host too", () => {
  nvrLoad.claim('10.0.0.9', 'u1');
  expect(ai._internals.yieldsToPlayback(cam('c', null, '10.0.0.9'))).toBe(true);
  expect(ai._internals.yieldsToPlayback(cam('d', '10.0.0.3'))).toBe(false);
});

test('a camera with AI off is never started by the resume', async () => {
  const off = cam('e', '10.0.0.1');
  off.settings.ai.enabled = false;
  mockCameras.push(off);
  nvrLoad.claim('10.0.0.1', 'u1')();
  await ai.reconcile();
  expect(mockPosts).toEqual([]);
});
