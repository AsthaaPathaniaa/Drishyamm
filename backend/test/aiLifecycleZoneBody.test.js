/**
 * Saving a camera's AI settings cannot leave a zone armed with no detector.
 *
 * `settings.ai.zoneBodyDetection` is normally just what the operator asked
 * for, defaulting to false. There is one exception, and it is not optional: a
 * camera with face recognition OFF has no face pipeline, so a restricted zone
 * on it has NO producer at all — it would show as armed, hold a licence, and
 * watch nothing.
 *
 * Here the save is not refused. An operator switching face recognition off has
 * asked for anonymity, which is a legitimate thing to want, so body detection
 * is FORCED ON and the reason is returned for the UI to show. Refusing is the
 * right answer at the other end — arming a zone on a camera that is already
 * anonymous — and that lives in restrictedZone.controller.js.
 *
 * Both ends read zoneProducer.service.js, so they cannot drift apart.
 */

jest.mock('../src/models', () => ({
  AIEvent: {},
  Camera: { findOne: jest.fn() },
  CameraGroup: {},
  RestrictedZone: { count: jest.fn(), findAll: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  assertAiLicence: jest.fn(),
  getAiEntitledUserIds: jest.fn(async () => new Set(['owner-1'])),
}));
jest.mock('../src/services/s3.service', () => ({}));
jest.mock('../src/config/redis', () => ({ getClient: () => null }));
jest.mock('axios', () => ({ get: jest.fn(async () => ({ data: {} })), post: jest.fn(async () => ({ data: {} })) }));

const { Camera, RestrictedZone } = require('../src/models');
const { updateCameraAiLifecycle } = require('../src/controllers/ai.controller');
const { NO_PRODUCER_REASON } = require('../src/services/zoneProducer.service');

/** The camera being saved. `update` records the settings that were written. */
function cameraDouble(ai = {}) {
  const row = {
    id: 'cam-id',
    monitorId: 'MON1',
    name: 'Server room',
    channel: 1,
    status: 'online',
    settings: { ai: { enabled: true, mode: 'continuous', ...ai } },
    written: null,
    async update({ settings }) { row.written = settings; row.settings = settings; },
    async reload() { return row; },
  };
  return row;
}

/** Drive the handler and wait for whichever exit it takes. */
function run(body, camera) {
  Camera.findOne.mockResolvedValue(camera);
  const out = { statusCode: 200, body: null };
  let err = null;
  let settle;
  const answered = new Promise((resolve) => { settle = resolve; });
  const res = {
    status(code) { out.statusCode = code; return res; },
    json(payload) { out.body = payload; settle(); return res; },
  };
  updateCameraAiLifecycle(
    { user: { id: 'owner-1' }, params: { id: 'cam-id' }, body, headers: {} },
    res,
    (e) => { err = e; settle(); },
  );
  return answered.then(() => ({ res: out, err, written: camera.written }));
}

const ENABLE = { enabled: true, mode: 'continuous' };

beforeEach(() => {
  jest.clearAllMocks();
  RestrictedZone.count.mockResolvedValue(0);
  RestrictedZone.findAll.mockResolvedValue([]);
});

/* ───────────────────── the ordinary case: as asked ─────────────────────── */

test('the flag is stored as false when nobody asked for it', async () => {
  const { written, res } = await run(ENABLE, cameraDouble());

  expect(written.ai.zoneBodyDetection).toBe(false);
  expect(res.body.notices).toEqual([]);
  // Nothing was forced, so the armed-zone query was not even needed.
  expect(RestrictedZone.count).not.toHaveBeenCalled();
});

test('an explicit true is stored', async () => {
  const { written, res } = await run({ ...ENABLE, zoneBodyDetection: true }, cameraDouble());

  expect(written.ai.zoneBodyDetection).toBe(true);
  expect(res.body.notices).toEqual([]);
});

test('an explicit false is honoured on a camera that recognises faces', async () => {
  // The face pipeline is a producer, so off is a legitimate choice here: a
  // lockout zone wants body detection, an allow-list zone is broken by it.
  const camera = cameraDouble({ faceRecognition: true, zoneBodyDetection: true });
  const { written, res } = await run({ ...ENABLE, zoneBodyDetection: false }, camera);

  expect(written.ai.zoneBodyDetection).toBe(false);
  expect(res.body.notices).toEqual([]);
});

test('a patch that does not mention it keeps what was stored', async () => {
  const camera = cameraDouble({ zoneBodyDetection: true });
  const { written } = await run({ ...ENABLE, fps: 6 }, camera);

  expect(written.ai.zoneBodyDetection).toBe(true);
});

/* ────────────────────── the exception: forced on ───────────────────────── */

test('switching face OFF on a camera with an armed zone forces it on', async () => {
  RestrictedZone.count.mockResolvedValue(1);
  const camera = cameraDouble();

  const { written, res } = await run({ ...ENABLE, faceRecognition: false }, camera);

  expect(written.ai.zoneBodyDetection).toBe(true);
  // And the operator is TOLD. A security control switched on for them without
  // a word is how a camera ends up doing something nobody expects.
  expect(res.body.notices).toEqual([NO_PRODUCER_REASON]);
});

test('the armed-zone query is scoped to this camera and this account', async () => {
  RestrictedZone.count.mockResolvedValue(1);
  await run({ ...ENABLE, faceRecognition: false }, cameraDouble());

  expect(RestrictedZone.count).toHaveBeenCalledWith({
    where: { userId: 'owner-1', monitorId: 'MON1', enabled: true },
  });
});

test('an explicit false is OVERRIDDEN when it would leave a zone blind', async () => {
  // The operator asked for both "no faces" and "no bodies" on a camera with a
  // zone. That combination has no valid meaning, so the zone wins.
  RestrictedZone.count.mockResolvedValue(2);
  const camera = cameraDouble();

  const { written, res } = await run(
    { ...ENABLE, faceRecognition: false, zoneBodyDetection: false },
    camera,
  );

  expect(written.ai.zoneBodyDetection).toBe(true);
  expect(res.body.notices).toEqual([NO_PRODUCER_REASON]);
});

test('an anonymous camera with NO armed zone is left alone', async () => {
  // Anonymous counting is a legitimate setup. With no zone there is nothing to
  // protect, and forcing a second detector on would be GPU nobody asked for.
  RestrictedZone.count.mockResolvedValue(0);
  const camera = cameraDouble();

  const { written, res } = await run({ ...ENABLE, faceRecognition: false }, camera);

  expect(written.ai.zoneBodyDetection).toBe(false);
  expect(res.body.notices).toEqual([]);
});

test('switching AI OFF entirely forces nothing', async () => {
  // Nothing runs because the operator said so, and the UI already reports a
  // drawn-but-dormant zone as needing setup. Forcing a detector onto a camera
  // whose AI is off would start work nobody asked for.
  RestrictedZone.count.mockResolvedValue(3);
  const camera = cameraDouble({ faceRecognition: false });

  const { written, res } = await run({ enabled: false, mode: 'off' }, camera);

  expect(written.ai.zoneBodyDetection).toBe(false);
  expect(res.body.notices).toEqual([]);
});

test('a camera already running body detection needs no forcing and says nothing', async () => {
  // The quiet path that matters for noise: an operator saving this camera
  // repeatedly must not be shown the same notice every time.
  RestrictedZone.count.mockResolvedValue(1);
  const camera = cameraDouble({ faceRecognition: false, zoneBodyDetection: true });

  const { written, res } = await run({ ...ENABLE, zoneBodyDetection: true }, camera);

  expect(written.ai.zoneBodyDetection).toBe(true);
  expect(res.body.notices).toEqual([]);
});

/* ──────────────── what the client is told about the camera ─────────────── */

test('the serialized row carries both zone flags and the armed-zone count', async () => {
  // `faceRecognition` was missing from this payload entirely, so the flag was
  // invisible to every client reader (all of which test `!== false`): a camera
  // with face switched OFF read back as ON. Nothing downstream can decide
  // anything about an anonymous camera until both are sent.
  RestrictedZone.findAll.mockResolvedValue([{ monitorId: 'MON1' }, { monitorId: 'MON1' }]);
  const camera = cameraDouble({ faceRecognition: false, zoneBodyDetection: true });

  const { res } = await run({ ...ENABLE, zoneBodyDetection: true }, camera);

  expect(res.body.data.ai.faceRecognition).toBe(false);
  expect(res.body.data.ai.zoneBodyDetection).toBe(true);
  expect(res.body.data.restrictedZones).toEqual({ armed: 2 });
});

test('a camera with no zones reports zero rather than omitting the field', async () => {
  RestrictedZone.findAll.mockResolvedValue([{ monitorId: 'OTHER' }]);
  const { res } = await run(ENABLE, cameraDouble());

  expect(res.body.data.restrictedZones).toEqual({ armed: 0 });
});

test('a camera saved before the face flag existed still reports face ON', async () => {
  const { res } = await run(ENABLE, cameraDouble());
  expect(res.body.data.ai.faceRecognition).toBe(true);
  expect(res.body.data.ai.zoneBodyDetection).toBe(false);
});
