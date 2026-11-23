/**
 * Which cameras zone-guard is allowed to watch.
 *
 * The service used to pick its own from ZONE_SIM_MONITORS, an environment
 * variable read once at import and checked against nothing: set to `all` it
 * opened every camera in the deployment on the main stream, permanently,
 * including cameras with no zone and cameras whose AI an operator had switched
 * off. The product answers now, and these tests pin the three conditions.
 *
 * The first condition is the one worth guarding hardest. An earlier draft of
 * this change qualified a camera on the zone and the plan ALONE — which would
 * have cut the load and still ignored "Set up AI" being off, leaving the
 * original defect alive inside its own fix.
 */

jest.mock('../src/models', () => ({
  Camera: { findAll: jest.fn() },
  RestrictedZone: { findAll: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  getAiEntitledUserIds: jest.fn(),
}));
jest.mock('../src/services/drishyamStreaming.service', () => ({
  getRtspEgressUrl: (mon, sub) => `rtsp://relay/cam_${mon}${sub ? '_sub' : ''}`,
  deriveSubPath: (path) => (path === 'has-sub' ? 'sub' : null),
}));

const { Camera, RestrictedZone } = require('../src/models');
const { getAiEntitledUserIds } = require('../src/services/entitlements.service');
const { zoneGuardCameras } = require('../src/services/zoneGuardCameras.service');

/** A camera row as Sequelize hands it over, AI on unless told otherwise. */
const camera = (monitorId, over = {}) => ({
  id: `id-${monitorId}`,
  userId: 'owner-1',
  monitorId,
  name: monitorId.toUpperCase(),
  path: 'no-sub',
  settings: { ai: { enabled: true, mode: 'continuous' } },
  ...over,
});

const zoneOn = (monitorId) => ({ monitorId });

const monitorsOf = (list) => list.map((c) => c.monitorId).sort();

beforeEach(() => {
  jest.clearAllMocks();
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
});

/* ─────────────────── condition 2: a reason to watch ───────────────────── */

test('no enabled zones anywhere means no cameras, and no camera query at all', async () => {
  RestrictedZone.findAll.mockResolvedValue([]);

  expect(await zoneGuardCameras()).toEqual([]);
  // The early return matters: the common case on a fresh deployment must not
  // pay for a full camera scan.
  expect(Camera.findAll).not.toHaveBeenCalled();
});

test('only cameras that carry an enabled zone are listed', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([camera('cam-a')]);

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);
  // Scoped by monitorId rather than fetched whole and filtered in JS.
  expect(Camera.findAll.mock.calls[0][0].where.monitorId).toEqual(['cam-a']);
});

test('a camera is asked for once however many zones it carries', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a'), zoneOn('cam-a'), zoneOn('cam-b')]);
  Camera.findAll.mockResolvedValue([camera('cam-a'), camera('cam-b')]);

  await zoneGuardCameras();
  expect(Camera.findAll.mock.calls[0][0].where.monitorId.sort()).toEqual(['cam-a', 'cam-b']);
});

test('a zone row with no monitorId is ignored rather than widening the query', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a'), { monitorId: null }, {}]);
  Camera.findAll.mockResolvedValue([camera('cam-a')]);

  await zoneGuardCameras();
  expect(Camera.findAll.mock.calls[0][0].where.monitorId).toEqual(['cam-a']);
});

/* ───────────── condition 1: the operator's own AI switch ─────────────── */

test("a camera whose AI is switched off is NOT watched, zone or no zone", async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a'), zoneOn('cam-b')]);
  Camera.findAll.mockResolvedValue([
    camera('cam-a', { settings: { ai: { enabled: false, mode: 'off' } } }),
    camera('cam-b'),
  ]);

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-b']);
});

test("mode 'off' with enabled still true is also off", async () => {
  // The same pair isAiEnabled tests, so the two can never disagree.
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([camera('cam-a', { settings: { ai: { enabled: true, mode: 'off' } } })]);

  expect(await zoneGuardCameras()).toEqual([]);
});

test('a camera with no AI settings at all is not watched', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a'), zoneOn('cam-b')]);
  Camera.findAll.mockResolvedValue([
    camera('cam-a', { settings: {} }),
    camera('cam-b', { settings: null }),
  ]);

  expect(await zoneGuardCameras()).toEqual([]);
});

/* ───────────────────── condition 3: the plan ─────────────────────────── */

test("a camera on an account without AI is not watched", async () => {
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a'), zoneOn('cam-b')]);
  Camera.findAll.mockResolvedValue([
    camera('cam-a'),
    camera('cam-b', { userId: 'lapsed-owner' }),
  ]);

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);
});

test('no entitled accounts means nothing is watched', async () => {
  getAiEntitledUserIds.mockResolvedValue(new Set());
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([camera('cam-a')]);

  expect(await zoneGuardCameras()).toEqual([]);
});

/* ───────────────────────── the payload ───────────────────────────────── */

test('each camera carries what the service needs to subscribe', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([camera('cam-a', { path: 'has-sub' })]);

  expect(await zoneGuardCameras()).toEqual([{
    id: 'id-cam-a',
    userId: 'owner-1',
    monitorId: 'cam-a',
    name: 'CAM-A',
    rtsp: 'rtsp://relay/cam_cam-a',
    rtspSub: 'rtsp://relay/cam_cam-a_sub',
  }]);
});

test('a camera with no sub-stream reports rtspSub as null, not a broken URL', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([camera('cam-a', { path: 'no-sub' })]);

  const [cam] = await zoneGuardCameras();
  expect(cam.rtspSub).toBeNull();
  expect(cam.rtsp).toBe('rtsp://relay/cam_cam-a');
});

/* ──────────────── all three together, which is the point ─────────────── */

test('the three conditions are an AND: failing any one excludes the camera', async () => {
  // The camera mock HONOURS the where clause here, so condition 2 is enforced
  // by the query exactly as it is in production rather than by the assertion.
  // `no-zone` exists in the fleet and must never come back, because the
  // service never asks for it.
  const fleet = [
    camera('zone-ai-plan'),                                                 // all three
    camera('no-ai', { settings: { ai: { enabled: false, mode: 'off' } } }),  // fails 1: AI off
    camera('no-plan', { userId: 'lapsed-owner' }),                          // fails 3: no plan
    camera('no-zone'),                                                      // fails 2: no zone
  ];
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
  RestrictedZone.findAll.mockResolvedValue([zoneOn('zone-ai-plan'), zoneOn('no-ai'), zoneOn('no-plan')]);
  Camera.findAll.mockImplementation(async ({ where }) => {
    const ids = where.monitorId;
    return fleet.filter((c) => ids.includes(c.monitorId));
  });

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['zone-ai-plan']);
});
