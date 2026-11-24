/**
 * The master switch and the face switch come apart.
 *
 * `settings.ai.enabled` meant two things at once: "use this camera for AI" and
 * "run the face pipeline". That was harmless while face AI was the only thing
 * reading it. Once the master governs head count, zones and activity too, the
 * conflation costs a capability: there is no way to count people without
 * recognising them, which is exactly what the room settings' "Anonymous
 * counting only" promises.
 *
 * So `ai.faceRecognition` gates the face pipeline, with ABSENT MEANING ON. The
 * no-migration property is the thing to guard hardest: every camera in an
 * existing deployment carries no such key and must behave exactly as before.
 */

jest.mock('../src/models', () => ({ Camera: { findAll: jest.fn() } }));
jest.mock('../src/services/entitlements.service', () => ({
  getAiEntitledUserIds: jest.fn(),
}));
jest.mock('../src/services/aiClockSkew', () => ({ recordAiClock: jest.fn() }));
jest.mock('axios');

const axios = require('axios');
const { Camera } = require('../src/models');
const { getAiEntitledUserIds } = require('../src/services/entitlements.service');
const aiLifecycle = require('../src/services/aiLifecycle.service');
const { faceRecognitionOn, isAiEnabled, reconcile } = aiLifecycle;

const cam = (monitorId, ai) => ({
  id: `id-${monitorId}`,
  userId: 'owner-1',
  monitorId,
  name: monitorId,
  settings: { ai },
});

/** monitorIds the loop asked the AI service to START. */
const started = () => axios.post.mock.calls
  .filter(([url]) => String(url).endsWith('/set-camera'))
  .map(([, body]) => new URLSearchParams(body.toString()).get('monitor_id'))
  .sort();

/** monitorIds the loop asked the AI service to STOP. */
const stopped = () => axios.post.mock.calls
  .filter(([url]) => String(url).endsWith('/stop-camera'))
  .map(([, body]) => new URLSearchParams(body.toString()).get('monitor_id'))
  .sort();

beforeEach(() => {
  jest.clearAllMocks();
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
  // Nothing running yet, so anything eligible gets started.
  axios.get.mockResolvedValue({ data: { cameras: {} }, headers: {} });
  axios.post.mockResolvedValue({ data: { ok: true } });
});

/* ────────────────── the predicates, on their own ──────────────────────── */

describe('faceRecognitionOn', () => {
  test('absent means ON — the no-migration property', () => {
    expect(faceRecognitionOn(cam('a', { enabled: true, mode: 'continuous' }))).toBe(true);
  });

  test('explicit false means off', () => {
    expect(faceRecognitionOn(cam('a', { enabled: true, mode: 'continuous', faceRecognition: false }))).toBe(false);
  });

  test('explicit true means on', () => {
    expect(faceRecognitionOn(cam('a', { enabled: true, mode: 'continuous', faceRecognition: true }))).toBe(true);
  });

  test('it says nothing about the master — that is isAiEnabled\'s job', () => {
    // Deliberately independent: the loop ANDs them, and keeping each predicate
    // answering one question is what stopped them drifting in the first place.
    const faceOffMasterOff = cam('a', { enabled: false, mode: 'off', faceRecognition: true });
    expect(faceRecognitionOn(faceOffMasterOff)).toBe(true);
    expect(isAiEnabled(faceOffMasterOff)).toBe(false);
  });

  test('a camera with no settings at all does not throw', () => {
    expect(faceRecognitionOn({})).toBe(true);
    expect(faceRecognitionOn({ settings: {} })).toBe(true);
  });
});

/* ────────────── the reconcile loop, which is what matters ─────────────── */

describe('the reconcile loop starts the face pipeline', () => {
  test('master on, face flag absent: started, exactly as before the split', async () => {
    Camera.findAll.mockResolvedValue([cam('legacy', { enabled: true, mode: 'continuous' })]);
    await reconcile({ stopUnselected: false });
    expect(started()).toEqual(['legacy']);
  });

  test('master on, face OFF: not started — this is anonymous counting', async () => {
    Camera.findAll.mockResolvedValue([
      cam('anon', { enabled: true, mode: 'continuous', faceRecognition: false }),
      cam('normal', { enabled: true, mode: 'continuous' }),
    ]);
    await reconcile({ stopUnselected: false });
    expect(started()).toEqual(['normal']);
  });

  test('master OFF with face on: not started — the master still wins', async () => {
    Camera.findAll.mockResolvedValue([cam('off', { enabled: false, mode: 'off', faceRecognition: true })]);
    await reconcile({ stopUnselected: false });
    expect(started()).toEqual([]);
  });

  test('switching face off STOPS a running pipeline', async () => {
    axios.get.mockResolvedValue({ data: { cameras: { anon: { running: true } } }, headers: {} });
    Camera.findAll.mockResolvedValue([cam('anon', { enabled: true, mode: 'continuous', faceRecognition: false })]);
    await reconcile({ stopUnselected: true });
    expect(stopped()).toEqual(['anon']);
  });

  test('an un-entitled owner is still not started, face flag notwithstanding', async () => {
    getAiEntitledUserIds.mockResolvedValue(new Set());
    Camera.findAll.mockResolvedValue([cam('a', { enabled: true, mode: 'continuous', faceRecognition: true })]);
    await reconcile({ stopUnselected: false });
    expect(started()).toEqual([]);
  });

  test("mode 'off' still beats a true face flag", async () => {
    Camera.findAll.mockResolvedValue([cam('a', { enabled: true, mode: 'off', faceRecognition: true })]);
    await reconcile({ stopUnselected: false });
    expect(started()).toEqual([]);
  });
});
