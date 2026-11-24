/**
 * A zone may not be ARMED on a camera that has nothing detecting people.
 *
 * A restricted zone is not a detector. It subscribes to boxes a producer
 * publishes and applies its dwell / confirm rules to them. A camera with face
 * recognition OFF and body detection OFF publishes nothing, so a zone armed on
 * it shows green, spends a restricted-zone licence, and watches nothing — the
 * worst failure mode a security control has, because it is invisible.
 *
 * The route refuses that, rather than arming something hollow. The mirror case
 * — switching face recognition off on a camera that ALREADY carries an armed
 * zone — cannot be refused here because it is a different route; it forces body
 * detection on instead (resolveZoneBodyFlag in ai.controller.js). Both ends
 * read zoneProducer.service.js, so they cannot drift apart.
 */

jest.mock('../src/models', () => ({
  Camera: { findOne: jest.fn() },
  RestrictedZone: { count: jest.fn(), create: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  assertAiLicence: jest.fn(),
}));

const { Camera, RestrictedZone } = require('../src/models');
const { assertAiLicence } = require('../src/services/entitlements.service');
const { create, update } = require('../src/controllers/restrictedZone.controller');
const { NO_PRODUCER_REASON } = require('../src/services/zoneProducer.service');

const ai = (over = {}) => ({ enabled: true, mode: 'continuous', ...over });

/** The camera the zone is being drawn on, as Sequelize hands it over. */
const cameraWith = (aiSettings) => ({ id: 'cam-id', settings: { ai: aiSettings } });

const req = (body = {}, params = {}) => ({ user: { id: 'owner-1' }, body, params });

/**
 * Call one controller and wait for it to answer.
 *
 * `asyncHandler` does not RETURN the promise it wraps, so awaiting the handler
 * resolves immediately and proves nothing. This resolves on whichever of the
 * two exits the handler actually takes: `res.json` for a success, `next(err)`
 * for a thrown AppError.
 */
function run(handler, request) {
  const out = { statusCode: null, body: null };
  let err = null;
  let settle;
  const answered = new Promise((resolve) => { settle = resolve; });
  const response = {
    status(code) { out.statusCode = code; return response; },
    json(payload) { out.body = payload; settle(); return response; },
  };
  handler(request, response, (e) => { err = e; settle(); });
  return answered.then(() => ({ response: out, err }));
}

const NEW_ZONE = { monitorId: 'cam-a', name: 'Server room' };

beforeEach(() => {
  jest.clearAllMocks();
  RestrictedZone.count.mockResolvedValue(0);
  RestrictedZone.create.mockImplementation(async (row) => ({ id: 'zone-1', ...row }));
  assertAiLicence.mockResolvedValue(undefined);
});

/* ───────────────────────── the refusal ─────────────────────────────────── */

describe('create', () => {
  test('a camera with face off and body off cannot have a zone armed', async () => {
    Camera.findOne.mockResolvedValue(cameraWith(ai({ faceRecognition: false })));

    const { err } = await run(create, req(NEW_ZONE));

    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe(NO_PRODUCER_REASON);
    // Refused BEFORE the licence is spent and before the row exists: a zone
    // that cannot work must not cost the account a camera's entitlement.
    expect(assertAiLicence).not.toHaveBeenCalled();
    expect(RestrictedZone.create).not.toHaveBeenCalled();
  });

  test('an explicit zoneBodyDetection false is refused the same way', async () => {
    Camera.findOne.mockResolvedValue(
      cameraWith(ai({ faceRecognition: false, zoneBodyDetection: false })),
    );
    const { err } = await run(create, req(NEW_ZONE));
    expect(err?.statusCode).toBe(409);
  });

  test('the reason tells the operator which switch to turn on', async () => {
    // A refusal with no next step is how someone ends up deleting the zone
    // instead of fixing the camera.
    Camera.findOne.mockResolvedValue(cameraWith(ai({ faceRecognition: false })));
    const { err } = await run(create, req(NEW_ZONE));
    expect(err.message).toContain('Catch people with no visible face');
  });

  /* ──────────────────── and what is still allowed ─────────────────────── */

  test('face recognition on is a producer: the zone is created', async () => {
    Camera.findOne.mockResolvedValue(cameraWith(ai()));

    const { err, response } = await run(create, req(NEW_ZONE));

    expect(err).toBeNull();
    expect(response.statusCode).toBe(201);
    expect(RestrictedZone.create).toHaveBeenCalled();
  });

  test('an anonymous camera WITH body detection is a producer', async () => {
    // The case the new switch exists for: no face pipeline, but zone-guard is
    // watching, so the zone fires on a nameless body box.
    Camera.findOne.mockResolvedValue(
      cameraWith(ai({ faceRecognition: false, zoneBodyDetection: true })),
    );

    const { err, response } = await run(create, req(NEW_ZONE));

    expect(err).toBeNull();
    expect(response.statusCode).toBe(201);
  });

  test('a camera saved before the face flag existed is a producer', async () => {
    // Absent means ON for faceRecognition. If this were read as off, every
    // legacy camera would start refusing new zones.
    Camera.findOne.mockResolvedValue(cameraWith({ enabled: true, mode: 'continuous' }));
    const { err } = await run(create, req(NEW_ZONE));
    expect(err).toBeNull();
  });

  test('a DISARMED zone is saved on any camera, producer or not', async () => {
    // `enabled: false` is a draft. Nothing is watching for it, nothing claims
    // to be, and no licence is spent — so there is nothing to refuse.
    Camera.findOne.mockResolvedValue(cameraWith(ai({ faceRecognition: false })));

    const { err, response } = await run(create, req({ ...NEW_ZONE, enabled: false }));

    expect(err).toBeNull();
    expect(response.statusCode).toBe(201);
    expect(Camera.findOne).not.toHaveBeenCalled();
  });

  test('a camera the AI registry has never seen is not refused', async () => {
    // Ownership is enforced by the queries around this. Turning a
    // missing-camera bug into "your zone cannot be saved" would leave an
    // operator with no way forward at all.
    Camera.findOne.mockResolvedValue(null);

    const { err, response } = await run(create, req(NEW_ZONE));

    expect(err).toBeNull();
    expect(response.statusCode).toBe(201);
  });

  test('a camera with AI switched off is refused: nothing runs on it', async () => {
    Camera.findOne.mockResolvedValue(cameraWith({ enabled: false, mode: 'off', zoneBodyDetection: true }));
    const { err } = await run(create, req(NEW_ZONE));
    expect(err?.statusCode).toBe(409);
  });

  test('the camera is looked up scoped to this account', async () => {
    Camera.findOne.mockResolvedValue(cameraWith(ai()));
    await run(create, req(NEW_ZONE));
    expect(Camera.findOne.mock.calls[0][0].where).toEqual({
      monitorId: 'cam-a', userId: 'owner-1',
    });
  });
});

/* ──────────── update: the disarmed -> armed edge is the gate ───────────── */

describe('update', () => {
  const stored = (over = {}) => ({
    id: 'zone-1', monitorId: 'cam-a', enabled: false, update: jest.fn(), ...over,
  });

  test('arming an existing zone on a producerless camera is refused', async () => {
    RestrictedZone.findOne.mockResolvedValue(stored());
    Camera.findOne.mockResolvedValue(cameraWith(ai({ faceRecognition: false })));

    const { err } = await run(update, req({ enabled: true }, { id: 'zone-1' }));

    expect(err?.statusCode).toBe(409);
    expect(assertAiLicence).not.toHaveBeenCalled();
  });

  test('arming it on a camera with a producer goes through', async () => {
    const zone = stored();
    RestrictedZone.findOne.mockResolvedValue(zone);
    Camera.findOne.mockResolvedValue(cameraWith(ai({ zoneBodyDetection: true })));

    const { err } = await run(update, req({ enabled: true }, { id: 'zone-1' }));

    expect(err).toBeNull();
    expect(zone.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  test('editing an ALREADY-armed zone is not re-gated', async () => {
    // Deliberate, and the same edge the licence check uses. A camera that
    // drifted into a producerless state must not lock the operator out of the
    // zone editor — renaming or redrawing it has to keep working, and the
    // other end of the invariant is what repairs the camera.
    const zone = stored({ enabled: true });
    RestrictedZone.findOne.mockResolvedValue(zone);
    Camera.findOne.mockResolvedValue(cameraWith(ai({ faceRecognition: false })));

    const { err } = await run(update, req({ name: 'Renamed' }, { id: 'zone-1' }));

    expect(err).toBeNull();
    expect(Camera.findOne).not.toHaveBeenCalled();
    expect(zone.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Renamed' }));
  });

  test('DISARMING a zone is never refused', async () => {
    const zone = stored({ enabled: true });
    RestrictedZone.findOne.mockResolvedValue(zone);

    const { err } = await run(update, req({ enabled: false }, { id: 'zone-1' }));

    expect(err).toBeNull();
    expect(Camera.findOne).not.toHaveBeenCalled();
    expect(zone.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
