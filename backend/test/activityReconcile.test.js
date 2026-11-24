/**
 * The activity camera set is RE-STATED, not pushed once and forgotten.
 *
 * It was the one AI service with no loop. A toggle made while it was restarting
 * was lost; a backend restart never re-sent the set; a camera's AI switch going
 * off, or an owner's plan lapsing, never reached it at all. And the service
 * persists whatever it last received, so a wrong set survived reboots with
 * nothing anywhere that would correct it.
 *
 * What is pinned here is the behaviour that fixes all of that, plus the two
 * guards that stop the fix becoming its own problem: it must not chatter an
 * identical list every 15 s, and it must not let a failure be remembered as
 * success.
 */

process.env.ACTIVITY_SERVICE_URL = 'http://activity-monitor:8000';
process.env.STREAM_SERVICE_RTSP_HOST = 'stream-service';
process.env.STREAM_SERVICE_RTSP_PORT = '8554';
process.env.ACTIVITY_SELF_HEAL_EVERY = '3';

jest.mock('axios');
jest.mock('../src/models', () => ({
  Camera: { findAll: jest.fn() },
  RestrictedZone: { findAll: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  getAiEntitledUserIds: jest.fn(),
}));

const axios = require('axios');
const { Camera } = require('../src/models');
const { getAiEntitledUserIds } = require('../src/services/entitlements.service');
const { forgetLastPosted, pushActivityCameras } = require('../src/services/activityPush.service');

const watched = (monitorId, over = {}) => ({
  id: `id-${monitorId}`,
  userId: 'owner-1',
  monitorId,
  name: monitorId,
  path: 'no-sub',
  status: 'online',
  settings: { ai: { enabled: true, mode: 'continuous', activityMonitoring: true } },
  ...over,
});

const posts = () => axios.post.mock.calls.filter(([u]) => String(u).includes('/activity/cameras'));
const lastSet = () => (posts().at(-1)?.[1]?.cameras || []).map((c) => c.id).sort();

beforeEach(() => {
  jest.clearAllMocks();
  forgetLastPosted();
  axios.post.mockResolvedValue({ data: { ok: true } });
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
});

test('the first reconcile states the set', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  const r = await pushActivityCameras();
  expect(r).toMatchObject({ ok: true, pushed: 1 });
  expect(lastSet()).toEqual(['cam-a']);
});

test('an unchanged set is not re-posted every tick', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  await pushActivityCameras();
  const after = await pushActivityCameras();

  expect(posts()).toHaveLength(1);
  expect(after).toMatchObject({ ok: true, skipped: true });
});

test('a CHANGED set is posted at once', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);
  await pushActivityCameras();

  Camera.findAll.mockResolvedValue([watched('cam-a'), watched('cam-b')]);
  await pushActivityCameras();

  expect(posts()).toHaveLength(2);
  expect(lastSet()).toEqual(['cam-a', 'cam-b']);
});

test('an unchanged set is re-stated anyway every Nth tick', async () => {
  // The service could have been restarted, rolled back or hand-edited since.
  // A reconcile that only reacts to local change cannot discover that, so it
  // states the truth periodically regardless. ACTIVITY_SELF_HEAL_EVERY=3 here.
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  await pushActivityCameras();            // posts
  for (let i = 0; i < 3; i += 1) await pushActivityCameras();   // 3 skips
  await pushActivityCameras();            // self-heal

  expect(posts()).toHaveLength(2);
});

test('a camera that loses its AI switch is removed on the next reconcile', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a'), watched('cam-b')]);
  await pushActivityCameras();
  expect(lastSet()).toEqual(['cam-a', 'cam-b']);

  // The operator switches cam-a's AI off. Nothing calls the toggle path.
  Camera.findAll.mockResolvedValue([
    watched('cam-a', { settings: { ai: { enabled: false, mode: 'off', activityMonitoring: true } } }),
    watched('cam-b'),
  ]);
  await pushActivityCameras();

  expect(lastSet()).toEqual(['cam-b']);
});

test('a lapsed plan is removed on the next reconcile', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);
  await pushActivityCameras();

  getAiEntitledUserIds.mockResolvedValue(new Set());
  await pushActivityCameras();

  expect(lastSet()).toEqual([]);
});

test('an empty set is still posted — that is how a camera gets removed', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);
  await pushActivityCameras();

  Camera.findAll.mockResolvedValue([]);
  await pushActivityCameras();

  expect(posts()).toHaveLength(2);
  expect(lastSet()).toEqual([]);
});

test('a FAILED push is not remembered as posted, so the next tick retries', async () => {
  // The whole point. Remembering a failed set would reintroduce the original
  // defect with extra steps: the loop would skip it for ever after.
  Camera.findAll.mockResolvedValue([watched('cam-a')]);
  axios.post.mockRejectedValueOnce(new Error('connection refused'));

  const bad = await pushActivityCameras();
  expect(bad).toMatchObject({ ok: false, error: 'connection refused' });

  axios.post.mockResolvedValue({ data: { ok: true } });
  const good = await pushActivityCameras();

  // Asserting a SECOND post, not just a truthy result: if the failed set were
  // remembered, this call would take the unchanged-set skip and still return
  // ok, with the set never actually reaching the service.
  expect(posts()).toHaveLength(2);
  expect(good.skipped).toBeUndefined();
  expect(good).toMatchObject({ ok: true, pushed: 1 });
  expect(lastSet()).toEqual(['cam-a']);
});

test('force ignores the unchanged-set skip, for an operator who is waiting', async () => {
  Camera.findAll.mockResolvedValue([watched('cam-a')]);
  await pushActivityCameras();
  await pushActivityCameras({ force: true });

  expect(posts()).toHaveLength(2);
});

test('a camera query failure is reported, never thrown at the loop', async () => {
  Camera.findAll.mockRejectedValue(new Error('db gone'));

  await expect(pushActivityCameras()).resolves.toMatchObject({ ok: false, error: 'db gone' });
  expect(posts()).toHaveLength(0);
});
