/**
 * Which cameras zone-guard is allowed to watch.
 *
 * The service used to pick its own from ZONE_SIM_MONITORS, an environment
 * variable read once at import and checked against nothing: set to `all` it
 * opened every camera in the deployment on the main stream, permanently,
 * including cameras with no zone and cameras whose AI an operator had switched
 * off. The product answers now, and these tests pin the FOUR conditions.
 *
 * The first condition is the one worth guarding hardest. An earlier draft of
 * this change qualified a camera on the zone and the plan ALONE — which would
 * have cut the load and still ignored "Set up AI" being off, leaving the
 * original defect alive inside its own fix.
 *
 * The fourth, `settings.ai.zoneBodyDetection`, is the per-camera switch. It
 * exists because the right answer differs per ZONE: a strict lockout wants
 * this detector, an allow-list zone is broken by its nameless boxes, and an
 * anonymous camera needs it or the zone never fires. ABSENT MEANS FALSE, so
 * the tests below set it explicitly on every camera that should be watched —
 * and the ones that do not set it are the regression guard for a fleet that
 * must not start running a second detector because this shipped.
 */

// The arm-window test below reads a wall clock in this zone. Pinned before
// the service is required so the window maths does not depend on where CI runs.
process.env.ALERT_TIMEZONE = 'UTC';

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
const { headcountCameras, zoneGuardCameras } = require('../src/services/aiFeatureCameras.service');

/** A camera row as Sequelize hands it over, AI on unless told otherwise. */
const camera = (monitorId, over = {}) => ({
  id: `id-${monitorId}`,
  userId: 'owner-1',
  monitorId,
  name: monitorId.toUpperCase(),
  path: 'no-sub',
  status: 'online',
  settings: { ai: { enabled: true, mode: 'continuous' } },
  ...over,
});

/** A camera with head count switched on, and AI on unless told otherwise. */
const counting = (monitorId, over = {}) => camera(monitorId, {
  settings: { ai: { enabled: true, mode: 'continuous' }, headcount: { enabled: true } },
  ...over,
});

/**
 * A camera an operator has asked zone-guard to watch: AI on AND the
 * per-camera body-detection switch on. This is what a zone-guard camera looks
 * like after the fourth condition; `camera()` above is one that has NOT opted
 * in, and is used wherever the point is that it stays unwatched.
 */
const watched = (monitorId, over = {}) => camera(monitorId, {
  settings: { ai: { enabled: true, mode: 'continuous', zoneBodyDetection: true } },
  ...over,
});

/** An enabled zone with no schedule: armed always, as the column defaults. */
const zoneOn = (monitorId) => ({ monitorId });

/**
 * An enabled zone armed only between `from` and `to`. The rows the selector
 * reads are already filtered to `enabled: true` by SQL, so these carry the
 * window and nothing else -- exactly the shape the query asks for.
 */
const zoneWindow = (monitorId, from, to) => ({
  monitorId, schedule: 'custom', armWindow: { from, to },
});

/** Pretend it is HH:00 UTC for the duration of `fn`. */
const atHour = (hh, fn) => {
  const Real = global.Date;
  const fixed = new Real(Real.UTC(2026, 10, 23, hh, 0, 0));
  // Only `new Date()` is redirected; `new Date(x)` and the statics stay real,
  // because zoneArming formats the instance it is given.
  class Frozen extends Real {
    constructor(...args) {
      super(...(args.length ? args : [fixed.getTime()]));
    }
  }
  Frozen.now = () => fixed.getTime();
  global.Date = Frozen;
  return Promise.resolve(fn()).finally(() => { global.Date = Real; });
};

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
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

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
    watched('cam-a', { settings: { ai: { enabled: false, mode: 'off', zoneBodyDetection: true } } }),
    watched('cam-b'),
  ]);

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-b']);
});

test("mode 'off' with enabled still true is also off", async () => {
  // The same pair isAiEnabled tests, so the two can never disagree.
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([
    watched('cam-a', { settings: { ai: { enabled: true, mode: 'off', zoneBodyDetection: true } } }),
  ]);

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
    watched('cam-a'),
    watched('cam-b', { userId: 'lapsed-owner' }),
  ]);

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);
});

test('no entitled accounts means nothing is watched', async () => {
  getAiEntitledUserIds.mockResolvedValue(new Set());
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  expect(await zoneGuardCameras()).toEqual([]);
});

/* ───────────────────────── the payload ───────────────────────────────── */

test('each camera carries what the service needs to subscribe', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([watched('cam-a', { path: 'has-sub' })]);

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
  Camera.findAll.mockResolvedValue([watched('cam-a', { path: 'no-sub' })]);

  const [cam] = await zoneGuardCameras();
  expect(cam.rtspSub).toBeNull();
  expect(cam.rtsp).toBe('rtsp://relay/cam_cam-a');
});

/* ────────── condition 4: the per-camera body-detection switch ──────── */

test('a camera with a zone but the switch OFF is not watched', async () => {
  // The default, and the reason this condition is safe to add to a live
  // fleet: every camera that exists carries no `zoneBodyDetection` key, so
  // none of them starts running a second detector because this shipped.
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([camera('cam-a')]);

  expect(await zoneGuardCameras()).toEqual([]);
});

test('an explicit false is not watched either', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([
    camera('cam-a', { settings: { ai: { enabled: true, mode: 'continuous', zoneBodyDetection: false } } }),
  ]);

  expect(await zoneGuardCameras()).toEqual([]);
});

test('switching the flag on lists the camera within one refresh, and off de-lists it', async () => {
  // The switch has to GOVERN the service, not merely be stored. The list is
  // rebuilt per call (the service polls it), so one flip of the stored value
  // is the whole round trip an operator sees.
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);

  Camera.findAll.mockResolvedValue([camera('cam-a')]);
  expect(await zoneGuardCameras()).toEqual([]);

  Camera.findAll.mockResolvedValue([watched('cam-a')]);
  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);

  Camera.findAll.mockResolvedValue([camera('cam-a')]);
  expect(await zoneGuardCameras()).toEqual([]);
});

test('the switch is per camera: one on does not drag its neighbours in', async () => {
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a'), zoneOn('cam-b'), zoneOn('cam-c')]);
  Camera.findAll.mockResolvedValue([watched('cam-a'), camera('cam-b'), watched('cam-c')]);

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a', 'cam-c']);
});

test('an anonymous camera with the switch on IS watched', async () => {
  // The case that makes the switch necessary rather than merely tidy: with
  // face recognition off there is no face pipeline, so zone-guard is the only
  // thing that can make this camera's zone fire at all.
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([
    camera('cam-a', {
      settings: { ai: { enabled: true, mode: 'continuous', faceRecognition: false, zoneBodyDetection: true } },
    }),
  ]);

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);
});

test('face recognition on does not imply body detection', async () => {
  // These are two producers, not one feature with two names. A camera that
  // recognises faces must not be handed a second detector it never asked for.
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a')]);
  Camera.findAll.mockResolvedValue([
    camera('cam-a', { settings: { ai: { enabled: true, mode: 'continuous', faceRecognition: true } } }),
  ]);

  expect(await zoneGuardCameras()).toEqual([]);
});

/* ──────────────── all four together, which is the point ─────────────── */

test('the four conditions are an AND: failing any one excludes the camera', async () => {
  // The camera mock HONOURS the where clause here, so condition 2 is enforced
  // by the query exactly as it is in production rather than by the assertion.
  // `no-zone` exists in the fleet and must never come back, because the
  // service never asks for it.
  const fleet = [
    watched('all-four'),                                                      // all four
    watched('no-ai', { settings: { ai: { enabled: false, mode: 'off', zoneBodyDetection: true } } }),  // fails 1
    watched('no-plan', { userId: 'lapsed-owner' }),                           // fails 3: no plan
    watched('no-zone'),                                                       // fails 2: no zone
    camera('no-switch'),                                                      // fails 4: not opted in
  ];
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
  RestrictedZone.findAll.mockResolvedValue([
    zoneOn('all-four'), zoneOn('no-ai'), zoneOn('no-plan'), zoneOn('no-switch'),
  ]);
  Camera.findAll.mockImplementation(async ({ where }) => {
    const ids = where.monitorId;
    return fleet.filter((c) => ids.includes(c.monitorId));
  });

  expect(monitorsOf(await zoneGuardCameras())).toEqual(['all-four']);
});

test('head count is NOT gated on the zone switch', async () => {
  // Guards against the fourth condition leaking into the wrong feature. Head
  // count has its own flag and its own detector; zone-guard's switch has
  // nothing to say about it.
  Camera.findAll.mockResolvedValue([counting('cam-a')]);
  expect(monitorsOf(await headcountCameras())).toEqual(['cam-a']);
});

/* ══════════════════ head count: the same rule, its own flag ═════════════ */

describe('headcountCameras', () => {
  test('a camera with head count on, AI on and a plan is listed', () => {
    Camera.findAll.mockResolvedValue([counting('cam-a')]);
    return expect(headcountCameras().then(monitorsOf)).resolves.toEqual(['cam-a']);
  });

  test('head count on but AI SWITCHED OFF is not listed', async () => {
    // The defect this change exists to remove: the service filtered on its own
    // flag alone, so a camera an operator had switched off kept counting.
    Camera.findAll.mockResolvedValue([
      counting('cam-a', { settings: { ai: { enabled: false, mode: 'off' }, headcount: { enabled: true } } }),
      counting('cam-b'),
    ]);
    expect(monitorsOf(await headcountCameras())).toEqual(['cam-b']);
  });

  test("mode 'off' with enabled true is also off", async () => {
    Camera.findAll.mockResolvedValue([
      counting('cam-a', { settings: { ai: { enabled: true, mode: 'off' }, headcount: { enabled: true } } }),
    ]);
    expect(await headcountCameras()).toEqual([]);
  });

  test('AI on but head count off is not listed', async () => {
    Camera.findAll.mockResolvedValue([camera('cam-a'), counting('cam-b')]);
    expect(monitorsOf(await headcountCameras())).toEqual(['cam-b']);
  });

  test('an un-entitled owner is not listed even with both flags on', async () => {
    getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
    Camera.findAll.mockResolvedValue([
      counting('cam-a'),
      counting('cam-b', { userId: 'lapsed-owner' }),
    ]);
    expect(monitorsOf(await headcountCameras())).toEqual(['cam-a']);
  });

  test('rows keep the shape the service already reads', async () => {
    Camera.findAll.mockResolvedValue([counting('cam-a', { path: 'has-sub', status: 'offline' })]);
    const [row] = await headcountCameras();

    // `settings` carries the counting zones; `status` is what the service's own
    // offline check reads. Both stay its decision, so both must be present.
    expect(row.settings.headcount.enabled).toBe(true);
    expect(row.status).toBe('offline');
    expect(row.rtsp).toBe('rtsp://relay/cam_cam-a');
    expect(row.rtspSub).toBe('rtsp://relay/cam_cam-a_sub');
  });

  test('an offline camera is still listed — dialling it is the service\'s call, not ours', async () => {
    Camera.findAll.mockResolvedValue([counting('cam-a', { status: 'offline' })]);
    expect(monitorsOf(await headcountCameras())).toEqual(['cam-a']);
  });

  test('every camera is considered, not a pre-filtered subset', async () => {
    Camera.findAll.mockResolvedValue([counting('cam-a')]);
    await headcountCameras();
    // No monitorId restriction: head count has no equivalent of zone-guard's
    // "needs a zone", so the query must span the fleet.
    expect(Camera.findAll.mock.calls[0][0].where).toBeUndefined();
  });
});

/* ──────── condition 2, sharpened: the zone must be ARMED, not merely on ──── */

test('a camera whose only zone is outside its arm window is NOT listed', async () => {
  // The engine already refuses to alert at 03:00 on a 09:00-17:00 zone, so
  // watching this camera bought a decoded, inferred, posted stream whose every
  // box was thrown away. The camera query must not even be made for it.
  RestrictedZone.findAll.mockResolvedValue([zoneWindow('cam-a', '09:00', '17:00')]);
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  await atHour(3, async () => {
    expect(await zoneGuardCameras()).toEqual([]);
    expect(Camera.findAll).not.toHaveBeenCalled();
  });
});

test('the same camera is listed again once its window opens, with no restart', async () => {
  // Nothing in the database changed between these two calls: the list is a
  // function of the clock as well as the rows, and the service re-reads it on
  // a timer. That is what releases the camera at 17:00 and re-acquires it at
  // 09:00 without an operator or a deploy.
  RestrictedZone.findAll.mockResolvedValue([zoneWindow('cam-a', '09:00', '17:00')]);
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  await atHour(3, async () => {
    expect(await zoneGuardCameras()).toEqual([]);
  });
  await atHour(12, async () => {
    expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);
  });
  await atHour(20, async () => {
    expect(await zoneGuardCameras()).toEqual([]);
  });
});

test('a camera is watched while ANY of its zones is armed', async () => {
  // Two zones on one camera, one of them on duty: there is something to watch
  // for, so the camera is watched. The engine decides which zone alerts.
  RestrictedZone.findAll.mockResolvedValue([
    zoneWindow('cam-a', '09:00', '17:00'),
    zoneWindow('cam-a', '22:00', '06:00'),
  ]);
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  await atHour(23, async () => {
    expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);
    expect(Camera.findAll.mock.calls[0][0].where.monitorId).toEqual(['cam-a']);
  });
});

test('an always-on zone is unaffected by the arm test', async () => {
  // Every zone that exists today has `schedule: 'always'`, so this change must
  // list exactly what it listed before for all of them, at any hour.
  RestrictedZone.findAll.mockResolvedValue([zoneOn('cam-a'), { monitorId: 'cam-b', schedule: 'always' }]);
  Camera.findAll.mockResolvedValue([watched('cam-a'), watched('cam-b')]);

  await atHour(3, async () => {
    expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a', 'cam-b']);
  });
});

test('a zone whose window is half-written is still watched', async () => {
  // Fail loud, not quiet: an unreadable schedule must not silently stop a
  // restricted zone being watched.
  RestrictedZone.findAll.mockResolvedValue([
    { monitorId: 'cam-a', schedule: 'custom', armWindow: { from: '09:00' } },
  ]);
  Camera.findAll.mockResolvedValue([watched('cam-a')]);

  await atHour(3, async () => {
    expect(monitorsOf(await zoneGuardCameras())).toEqual(['cam-a']);
  });
});

test('the window fields are actually fetched, or the test above could never fail', async () => {
  RestrictedZone.findAll.mockResolvedValue([]);
  await zoneGuardCameras();
  const attrs = RestrictedZone.findAll.mock.calls[0][0].attributes;
  expect(attrs).toContain('monitorId');
  expect(attrs).toContain('schedule');
  expect(attrs).toContain('armWindow');
});
