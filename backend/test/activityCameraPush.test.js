/**
 * The activity-monitor's camera list obeys the camera's AI switch.
 *
 * `pushActivityCameras` built the desired set from `settings.ai.activityMonitoring`
 * ALONE. So an operator who switched a camera's AI off kept paying for pose and
 * phone-usage analysis on it, and an account whose plan lapsed kept it running
 * indefinitely — the licence is only checked on the off→on edge, in
 * `setActivityCameras`, and nothing re-checks it afterwards.
 *
 * Both tests the feature was missing are now in the filter, taking the same
 * `isAiEnabled` the face-AI reconcile loop uses.
 */

process.env.ACTIVITY_SERVICE_URL = 'http://activity-monitor:8000';
process.env.STREAM_SERVICE_RTSP_HOST = 'stream-service';
process.env.STREAM_SERVICE_RTSP_PORT = '8554';

jest.mock('axios');
jest.mock('../src/models', () => ({
  Camera: { findAll: jest.fn() },
  CameraGroup: {},
  AIEvent: { create: jest.fn() },
  RestrictedZone: { findAll: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  assertAiLicence: jest.fn(),
  getAiEntitledUserIds: jest.fn(),
  getEntitlements: jest.fn(),
  allowsAny: jest.fn(() => true),
}));

const axios = require('axios');
const { Camera } = require('../src/models');
const { getAiEntitledUserIds } = require('../src/services/entitlements.service');
const { pushActivityCameras } = require('../src/controllers/ai.controller');

/** A camera with activity monitoring on, and AI on unless told otherwise. */
const watched = (monitorId, over = {}) => ({
  id: `id-${monitorId}`,
  userId: 'owner-1',
  name: monitorId.toUpperCase(),
  monitorId,
  settings: { ai: { enabled: true, mode: 'continuous', activityMonitoring: true } },
  ...over,
});

/** The monitorIds actually pushed to the service. */
const pushed = () => (axios.post.mock.calls[0]?.[1]?.cameras || []).map((c) => c.id).sort();

beforeEach(() => {
  jest.clearAllMocks();
  axios.post.mockResolvedValue({ data: { ok: true } });
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
});

test('a camera with activity on, AI on and a plan is pushed', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  const result = await pushActivityCameras();
  expect(result).toMatchObject({ ok: true, pushed: 1 });
  expect(pushed()).toEqual(['cam-a']);
});

test('activity on but AI SWITCHED OFF is not pushed', async () => {
  Camera.findAll.mockResolvedValue([
    watched('cam-a', {
      settings: { ai: { enabled: false, mode: 'off', activityMonitoring: true } },
    }),
    watched('cam-b'),
  ]);

  await pushActivityCameras();
  expect(pushed()).toEqual(['cam-b']);
});

test("mode 'off' with enabled true is also off", async () => {
  Camera.findAll.mockResolvedValue([
    watched('cam-a', {
      settings: { ai: { enabled: true, mode: 'off', activityMonitoring: true } },
    }),
  ]);

  await pushActivityCameras();
  expect(pushed()).toEqual([]);
});

test('an un-entitled owner is not pushed even with both flags on', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a'), watched('cam-b', { userId: 'lapsed-owner' })]);

  await pushActivityCameras();
  expect(pushed()).toEqual(['cam-a']);
});

test('AI on but activity monitoring off is not pushed', async () => {
  Camera.findAll.mockResolvedValue([
    watched('cam-a', { settings: { ai: { enabled: true, mode: 'continuous' } } }),
    watched('cam-b'),
  ]);

  await pushActivityCameras();
  expect(pushed()).toEqual(['cam-b']);
});

test('the full set is still sent, including when it is empty', async () => {
  // The service's endpoint is a full-set reconcile: an empty list is how a
  // camera gets REMOVED. Skipping the post when nothing qualifies would leave
  // the last set running for ever.
  Camera.findAll.mockResolvedValue([
    watched('cam-a', { settings: { ai: { enabled: false, mode: 'off', activityMonitoring: true } } }),
  ]);

  const result = await pushActivityCameras();
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(pushed()).toEqual([]);
  expect(result).toMatchObject({ ok: true, pushed: 0 });
});

test('the owner is read from the row, so the query must select userId', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  await pushActivityCameras();
  // Without userId in the attributes the entitlement test silently excludes
  // every camera — a failure that looks exactly like "nobody is entitled".
  expect(Camera.findAll.mock.calls[0][0].attributes).toContain('userId');
});

test('a failed push is reported, not thrown', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);
  axios.post.mockRejectedValue(new Error('connection refused'));

  // Unchanged behaviour, pinned because this is the known reliability hole:
  // nothing retries, so the caller's return value is the only signal there is.
  await expect(pushActivityCameras()).resolves.toMatchObject({
    ok: false,
    error: 'connection refused',
  });
});
