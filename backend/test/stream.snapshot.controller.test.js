// The editor picks its message from the snapshot endpoints' status and body:
// never connected vs picture expired, queued vs refused vs saved.

jest.mock('../src/models', () => ({ Camera: { findOne: jest.fn() } }));
jest.mock('../src/services/stream.service', () => ({}));
jest.mock('../src/services/recordingSync.service', () => ({}));
jest.mock('../src/services/liveSnapshot.service', () => ({ getSnapshot: jest.fn(), refreshByHand: jest.fn() }));

const { Camera } = require('../src/models');
const liveSnapshot = require('../src/services/liveSnapshot.service');
const ctrl = require('../src/controllers/stream.controller');

function call(handler) {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
  return new Promise((resolve) => {
    const next = (err) => resolve({ res, err });
    const done = res.json.bind(res);
    res.json = (b) => { done(b); resolve({ res }); return res; };
    res.send = (b) => { res.body = b; resolve({ res }); return res; };
    handler({ params: { monitorId: 'a' }, user: { id: 'u1' } }, res, next);
  });
}

const offline = (reason, lastSeenAt) => Object.assign(new Error('offline'), { code: 'OFFLINE', reason, lastSeenAt });

beforeEach(() => Camera.findOne.mockResolvedValue({ monitorId: 'a' }));

describe('GET /snapshot/:monitorId', () => {
  test('sends the picture with its age', async () => {
    liveSnapshot.getSnapshot.mockResolvedValue({ jpeg: Buffer.from('j'), at: Date.parse('2026-11-01T10:00:00Z'), stale: true });
    const { res } = await call(ctrl.getSnapshot);
    expect(res.headers).toMatchObject({ 'X-Snapshot-At': '2026-11-01T10:00:00.000Z', 'X-Snapshot-Stale': '1' });
    expect(res.headers['Access-Control-Expose-Headers']).toMatch(/X-Snapshot-At.*X-Snapshot-Stale/);
  });

  test('409 says whether the camera never connected', async () => {
    liveSnapshot.getSnapshot.mockRejectedValue(offline('never_connected', null));
    const { res } = await call(ctrl.getSnapshot);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ reason: 'never_connected', lastSeenAt: null });
  });

  test('409 says the picture expired and when the camera was last seen', async () => {
    liveSnapshot.getSnapshot.mockRejectedValue(offline('expired', '2026-10-01T00:00:00.000Z'));
    const { res } = await call(ctrl.getSnapshot);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ reason: 'expired', lastSeenAt: '2026-10-01T00:00:00.000Z' });
  });
});

describe('POST /snapshot/:monitorId/refresh', () => {
  test('200 with the new capturedAt', async () => {
    liveSnapshot.refreshByHand.mockResolvedValue({ capturedAt: '2026-11-11T08:00:00.000Z' });
    const { res } = await call(ctrl.refreshSnapshot);
    expect(res.statusCode).toBe(200);
    expect(res.body.capturedAt).toBe('2026-11-11T08:00:00.000Z');
  });

  test('202 queued when the NVR is at its limit', async () => {
    liveSnapshot.refreshByHand.mockResolvedValue({ queued: true });
    const { res } = await call(ctrl.refreshSnapshot);
    expect(res.statusCode).toBe(202);
    expect(res.body.queued).toBe(true);
  });

  test('409 for an offline camera', async () => {
    liveSnapshot.refreshByHand.mockRejectedValue(offline('expired', '2026-10-01T00:00:00.000Z'));
    const { res } = await call(ctrl.refreshSnapshot);
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('expired');
  });

  test('429 with Retry-After within the manual window', async () => {
    liveSnapshot.refreshByHand.mockRejectedValue(Object.assign(new Error('soon'), { code: 'TOO_SOON', retryAfterSec: 120 }));
    const { res } = await call(ctrl.refreshSnapshot);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('120');
    expect(res.body.retryAfter).toBe(120);
  });

  test('a failed grab is a 502 for the error handler', async () => {
    liveSnapshot.refreshByHand.mockRejectedValue(new Error('ffmpeg exited 1'));
    const { err } = await call(ctrl.refreshSnapshot);
    expect(err.statusCode).toBe(502);
  });
});
