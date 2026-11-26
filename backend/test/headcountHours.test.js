/**
 * The endpoint half of counting hours.
 *
 * `withinCountWindow` decides when a camera is on duty and is pinned in
 * timeWindow.test.js; the camera selector drops the off-duty ones, which is
 * pinned in aiFeatureCameras.test.js. This file pins the third thing, and it is
 * the one an operator actually loses work to: that PUT /ai/cameras/:id/headcount
 * STORES the hours they typed, clears them when they ask, and does not throw
 * them away while doing something unrelated.
 *
 * That last one is the whole risk. The hours arrive on the same endpoint as the
 * tick, the threshold, the detail level and the zones -- an endpoint that
 * rebuilds its settings object is how an operator's schedule disappears because
 * they nudged a slider, and this page has spent a week fixing exactly that
 * class of silent loss.
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
jest.mock('axios', () => ({
  get: jest.fn(async () => ({ data: {} })),
  post: jest.fn(async () => ({ data: {} })),
}));

const { Camera } = require('../src/models');
const { setCameraHeadcount } = require('../src/controllers/ai.controller');
const { withinCountWindow } = require('../src/services/headcountWindow');

/**
 * A camera already ticked for counting with its AI on, so no consent question
 * stands between the test and the thing being tested.
 */
function cameraDouble(headcount = {}) {
  const row = {
    id: 'cam-id',
    monitorId: 'MON1',
    name: 'Reception',
    status: 'online',
    settings: {
      ai: { enabled: true, mode: 'continuous' },
      headcount: { enabled: true, threshold: 0, zones: [], ...headcount },
    },
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
  setCameraHeadcount(
    { user: { id: 'owner-1' }, params: { id: 'cam-id' }, body, headers: {} },
    res,
    (e) => { err = e; settle(); },
  );
  return answered.then(() => ({ res: out, err, written: camera.written }));
}

const TICK = { enabled: true, threshold: 0 };
/** 03:00 UTC — the middle of the night for a 09:00-18:00 camera. */
const NIGHT = new Date(Date.UTC(2026, 10, 23, 3));

beforeEach(() => jest.clearAllMocks());

/* ─────────────────────────── storing the hours ─────────────────────────── */

test('the hours an operator typed are stored, and marked to be obeyed', async () => {
  const { written } = await run(
    { ...TICK, countWindow: { from: '09:00', to: '18:00' } }, cameraDouble(),
  );
  expect(written.headcount.countWindow).toEqual({ from: '09:00', to: '18:00' });
  // Storing a window and then ignoring it is the odd case and has to be asked
  // for, so a window that has just been set is a window to obey.
  expect(written.headcount.schedule).toBe('window');
});

test('a night shift is stored exactly as typed, wrap and all', async () => {
  const { written } = await run(
    { ...TICK, countWindow: { from: '22:00', to: '07:00' } }, cameraDouble(),
  );
  expect(written.headcount.countWindow).toEqual({ from: '22:00', to: '07:00' });
});

test('null CLEARS the hours, so the camera goes back to counting always', async () => {
  const had = cameraDouble({ countWindow: { from: '09:00', to: '18:00' }, schedule: 'window' });
  const { written } = await run({ ...TICK, countWindow: null }, had);

  // Left to `...prev` a removed window would survive its own deletion, and the
  // camera would keep going off duty for hours the operator had deleted.
  expect(written.headcount.countWindow).toBeUndefined();
  expect(written.headcount.schedule).toBeUndefined();
  expect(withinCountWindow(written.headcount, NIGHT)).toBe(true);
});

test('schedule always keeps the hours on the record but stops obeying them', async () => {
  const { written } = await run({
    ...TICK, countWindow: { from: '09:00', to: '18:00' }, schedule: 'always',
  }, cameraDouble());

  expect(written.headcount.countWindow).toEqual({ from: '09:00', to: '18:00' });
  expect(written.headcount.schedule).toBe('always');
  // Which is the point of it: the hours are still there to go back to.
  expect(withinCountWindow(written.headcount, NIGHT)).toBe(true);
});

/* ────────────── not losing them while doing something else ─────────────── */

test('nudging the detail level does NOT wipe the hours', async () => {
  // The silent-loss case. Detail, the tick, the threshold and the zones all
  // arrive on this endpoint, and the hours must survive every one of them.
  const had = cameraDouble({ countWindow: { from: '09:00', to: '18:00' }, schedule: 'window' });
  const { written } = await run({ ...TICK, imgsz: 1280 }, had);

  expect(written.headcount.imgsz).toBe(1280);
  expect(written.headcount.countWindow).toEqual({ from: '09:00', to: '18:00' });
  expect(written.headcount.schedule).toBe('window');
});

test('un-ticking and ticking again gives the operator their hours back', async () => {
  // Un-ticking says "do not count this"; a window says "count this, during
  // these hours". Different sentences, so neither clears the other.
  const had = cameraDouble({ countWindow: { from: '09:00', to: '18:00' }, schedule: 'window' });
  const off = await run({ enabled: false, threshold: 0 }, had);
  expect(off.written.headcount.enabled).toBe(false);
  expect(off.written.headcount.countWindow).toEqual({ from: '09:00', to: '18:00' });

  const on = await run(TICK, had);
  expect(on.written.headcount.enabled).toBe(true);
  expect(on.written.headcount.countWindow).toEqual({ from: '09:00', to: '18:00' });
});

test('saving zones does not wipe the hours either', async () => {
  const had = cameraDouble({ countWindow: { from: '09:00', to: '18:00' }, schedule: 'window' });
  const { written } = await run({
    ...TICK,
    zones: [{ id: 'z1', name: 'Lobby', points: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]] }],
  }, had);

  expect(written.headcount.zones).toHaveLength(1);
  expect(written.headcount.countWindow).toEqual({ from: '09:00', to: '18:00' });
});

/* ──────────────────────── a bad window is no window ────────────────────── */

test('a mistyped time does not fail the save, it just sets no hours', async () => {
  // The rest of the payload is work the operator can see. Refusing all of it to
  // protect a field they may not have touched would be the worse answer -- and
  // counting always is the recoverable direction, since spending GPU can be
  // undone and a missing hour of numbers cannot.
  const { written, err, res } = await run(
    { ...TICK, imgsz: 960, countWindow: { from: '9am', to: '5pm' } }, cameraDouble(),
  );
  expect(err).toBeNull();
  expect(res.statusCode).toBe(200);
  expect(written.headcount.imgsz).toBe(960);
  expect(written.headcount.countWindow).toBeUndefined();
});

test('a zero-length window is refused rather than guessed at', async () => {
  const { written } = await run(
    { ...TICK, countWindow: { from: '09:00', to: '09:00' } }, cameraDouble(),
  );
  expect(written.headcount.countWindow).toBeUndefined();
});

/* ───────────────── what the page is told, on the way back ──────────────── */

test('the response carries the stored hours back for the page to render', async () => {
  const { res } = await run(
    { ...TICK, countWindow: { from: '09:00', to: '18:00' } }, cameraDouble(),
  );
  expect(res.body.data.headcount.countWindow).toEqual({ from: '09:00', to: '18:00' });
});
