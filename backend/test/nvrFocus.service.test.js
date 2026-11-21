// While a user replays footage from an NVR, the background Stream Service
// paths of THAT USER's cameras there are parked (source → publisher, so
// nothing re-opens the NVR) and their idle live relays stop; paths a person
// watches, and other users' cameras on the same NVR, stay. When the claim
// ends everything gets its source back (2026-11-21: AI + warm-keeper pulls left
// recorded playback at 0.12-0.5x real time on a ~1 Mbit/s NVR uplink).

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockStore = {};
jest.mock('../src/config/redis', () => ({
  setJSON: jest.fn(async (k, v) => { mockStore[k] = v; }),
  getJSON: jest.fn(async (k) => mockStore[k] ?? null),
  del: jest.fn(async (k) => { delete mockStore[k]; }),
}));
jest.mock('../src/models', () => ({
  Camera: { findAll: async ({ where }) => [
    { monitorId: 'a', host: '10.0.0.1', group: null, userId: 'u1' },
    { monitorId: 'b', host: null, group: { host: '10.0.0.1' }, userId: 'u1' },
    { monitorId: 'c', host: '10.0.0.2', group: null, userId: 'u1' },
    { monitorId: 'x', host: '10.0.0.1', group: null, userId: 'u2' },
  ].filter((c) => !where?.userId || c.userId === where.userId) },
  CameraGroup: {},
}));
const mockConfigs = {};
const mockPathList = [];
const mockPatches = [];
jest.mock('../src/services/drishyamStreaming.service', () => ({
  pathName: (id) => `cam_${id}`,
  subPathName: (id) => `cam_${id}_sub`,
  api: {
    get: jest.fn(async (url) => {
      if (url.startsWith('/v3/paths/list')) return { data: { items: mockPathList } };
      const name = url.split('/').pop();
      if (!mockConfigs[name]) { const e = new Error('404'); e.response = { status: 404 }; throw e; }
      return { data: { ...mockConfigs[name] } };
    }),
    patch: jest.fn(async (url, body) => {
      const name = url.split('/').pop();
      mockPatches.push([name, body.source]);
      Object.assign(mockConfigs[name], body);
      return { data: {} };
    }),
  },
}));
const mockViewers = {};
const mockReleased = [];
jest.mock('../src/services/liveRelay.service', () => ({
  sessionsOnHost: () => 0,
  viewerCount: (p) => mockViewers[p] || 0,
  hostOf: (r) => r.host || null,
  releaseIdleWhere: (belongs) => {
    const relays = [['cam_a_sub', {}], ['cam_x_sub', { host: '10.0.0.1' }], ['cam_c_sub', {}]];
    const out = relays.filter(([p, r]) => belongs(p, r)).map(([p]) => p);
    mockReleased.push(...out);
    return out;
  },
}));
const mockStopVariant = jest.fn();
jest.mock('../src/services/transcoder.service', () => ({ stopVariant: (...a) => mockStopVariant(...a) }));

process.env.NVR_LOAD_REFRESH_MS = '0';
process.env.NVR_CLAIM_GRACE_MS = '0';
const nvrLoad = require('../src/services/nvrLoad.service');
const focus = require('../src/services/nvrFocus.service');

const rtsp = (id) => ({ source: `rtsp://nvr/${id}`, sourceOnDemand: true });
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  focus.stop();
  nvrLoad._internals.reset();
  focus._internals.parked.clear();
  for (const k of Object.keys(mockConfigs)) delete mockConfigs[k];
  for (const k of Object.keys(mockViewers)) delete mockViewers[k];
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  mockPathList.length = 0;
  mockPatches.length = 0;
  mockReleased.length = 0;
  mockStopVariant.mockClear();
  Object.assign(mockConfigs, {
    cam_a: rtsp('a'), cam_a_sub: rtsp('a_sub'), cam_b: { source: 'rtsp://nvr/b', sourceOnDemand: false },
    cam_b_sub: rtsp('b_sub'), cam_c: rtsp('c'), cam_c_sub: rtsp('c_sub'),
    cam_x: rtsp('x'), cam_x_sub: rtsp('x_sub'),
  });
  await focus.start();
});

test("a user's claim parks their unwatched paths and idle relays on that NVR; release restores them", async () => {
  mockPathList.push({ name: 'cam_a_sub_h264', readers: [{ type: 'webRTCSession' }] });   // someone watches a live
  const release = nvrLoad.claim('10.0.0.1', 'u1');
  await settle();

  expect(mockConfigs.cam_a.source).toBe('publisher');
  expect(mockConfigs.cam_a_sub.source).toBe('rtsp://nvr/a_sub');              // watched: kept
  expect(mockConfigs.cam_b.source).toBe('publisher');                         // via its group's NVR
  expect(mockConfigs.cam_b.sourceOnDemand).toBe(false);
  expect(mockConfigs.cam_c.source).toBe('rtsp://nvr/c');                      // other NVR untouched
  expect(mockConfigs.cam_x.source).toBe('rtsp://nvr/x');                      // other user, same NVR: untouched
  expect(mockConfigs.cam_x_sub.source).toBe('rtsp://nvr/x_sub');
  expect(mockReleased).toEqual(['cam_a_sub']);                                // not the other user's relay
  expect(mockStopVariant).toHaveBeenCalledWith('a', 'main');
  expect(Object.keys(mockStore['nvrFocus:parked']).sort()).toEqual(['cam_a', 'cam_b', 'cam_b_sub']);

  release();
  await settle();
  expect(mockConfigs.cam_a).toEqual(rtsp('a'));
  expect(mockConfigs.cam_b).toEqual({ source: 'rtsp://nvr/b', sourceOnDemand: false });
  expect(focus._internals.parked.size).toBe(0);
  expect(mockStore['nvrFocus:parked']).toBeUndefined();
});

test('a claim without a user parks nothing', async () => {
  nvrLoad.claim('10.0.0.1');
  await settle();
  expect(mockPatches).toEqual([]);
});

test('opening live view of a parked camera gives it back at once', async () => {
  nvrLoad.claim('10.0.0.1', 'u1');
  await settle();
  await focus.unparkCamera('a');
  expect(mockConfigs.cam_a.source).toBe('rtsp://nvr/a');
  expect(mockConfigs.cam_b.source).toBe('publisher');
});

test('paths left parked by a previous run are restored on start', async () => {
  focus.stop();
  mockConfigs.cam_c.source = 'publisher';
  mockStore['nvrFocus:parked'] = { cam_c: { host: '10.0.0.2', userId: 'u1', source: 'rtsp://nvr/c', sourceOnDemand: true } };
  await focus.start();
  expect(mockConfigs.cam_c.source).toBe('rtsp://nvr/c');
  expect(mockStore['nvrFocus:parked']).toBeUndefined();
});
