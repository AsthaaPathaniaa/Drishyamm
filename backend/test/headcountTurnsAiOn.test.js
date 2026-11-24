/**
 * Ticking a camera for head count is the whole switch.
 *
 * Counting is gated on the camera's master AI switch, and the only switch an
 * operator is given for counting is the tick that reaches
 * PUT /ai/cameras/:id/headcount. Before this, the two could disagree: ticked
 * for counting, excluded by the master, counting nothing, with no page able to
 * say why.
 *
 * These tests pin the settings object the tick produces, because that object
 * is what every feature selector reads. Each feature is asserted OFF
 * explicitly: switching the master on is switching on the thing they all hang
 * off, so "only counting starts" has to be a test and not a comment.
 */
const {
  isAiEnabled, faceRecognitionOn, countingOnlyAi, AI_TURNED_ON_FOR_COUNTING,
} = require('../src/services/aiLifecycle.service');

const asCamera = (ai) => ({ settings: { ai } });

describe('countingOnlyAi — the master switch, for counting', () => {
  test('a camera that has never had AI configured comes out counted', () => {
    const ai = countingOnlyAi(undefined, 'NOW');
    expect(isAiEnabled(asCamera(ai))).toBe(true);
    expect(ai.mode).toBe('continuous');
  });

  test('called with nothing at all it still produces a usable master switch', () => {
    const ai = countingOnlyAi();
    expect(isAiEnabled(asCamera(ai))).toBe(true);
    expect(typeof ai.updatedAt).toBe('string');
  });

  // ── counting only. One assertion per feature that hangs off the master. ──

  test('FACE stays off: absent means ON, so it is set explicitly false', () => {
    const ai = countingOnlyAi({}, 'NOW');
    expect(ai.faceRecognition).toBe(false);
    expect(faceRecognitionOn(asCamera(ai))).toBe(false);
  });

  test('an explicit faceRecognition:true is overridden, not honoured', () => {
    // Nothing was running -- the master was off -- and honouring it would
    // spend a face licence that can be REFUSED, failing a tick the Head Count
    // page cannot act on. Turning it back on in Camera Setup is additive.
    const ai = countingOnlyAi({ faceRecognition: true }, 'NOW');
    expect(ai.faceRecognition).toBe(false);
  });

  test('ACTIVITY stays off — it needs activityMonitoring === true', () => {
    const ai = countingOnlyAi({}, 'NOW');
    expect(ai.activityMonitoring).toBeUndefined();
    expect(ai.activityMonitoring === true).toBe(false);
  });

  test('ZONE-GUARD stays off — it needs zoneBodyDetection === true', () => {
    const ai = countingOnlyAi({}, 'NOW');
    expect(ai.zoneBodyDetection).toBeUndefined();
    expect(ai.zoneBodyDetection === true).toBe(false);
  });

  test('a camera that had asked for zone-guard keeps it; this adds nothing', () => {
    const ai = countingOnlyAi({ zoneBodyDetection: true }, 'NOW');
    expect(ai.zoneBodyDetection).toBe(true);
  });

  // ── what it carries over ────────────────────────────────────────────────

  test('every unrelated setting the camera already had is carried over', () => {
    const ai = countingOnlyAi({
      fps: 12, detectionInputSize: 1280, purpose: 'entrance', priority: 'high',
      detectionZones: [{ id: 'z1' }], unknownAlerts: false,
    }, 'NOW');
    expect(ai.fps).toBe(12);
    expect(ai.detectionInputSize).toBe(1280);
    expect(ai.purpose).toBe('entrance');
    expect(ai.priority).toBe('high');
    expect(ai.detectionZones).toEqual([{ id: 'z1' }]);
    expect(ai.unknownAlerts).toBe(false);
  });

  test('a stored mode is kept; only the off state we are leaving is replaced', () => {
    expect(countingOnlyAi({ mode: 'scheduled' }, 'NOW').mode).toBe('scheduled');
    expect(countingOnlyAi({ mode: 'off' }, 'NOW').mode).toBe('continuous');
    expect(countingOnlyAi({ mode: '' }, 'NOW').mode).toBe('continuous');
  });

  test('createdAt is preserved and disabledAt / lastError are cleared', () => {
    const ai = countingOnlyAi({
      createdAt: 'FIRST', disabledAt: 'WHEN-OFF', lastError: 'something old',
    }, 'NOW');
    expect(ai.createdAt).toBe('FIRST');
    expect(ai.updatedAt).toBe('NOW');
    expect(ai.disabledAt).toBe(null);
    expect(ai.lastError).toBe(null);
  });

  test('a camera with no createdAt gets this moment as its first', () => {
    expect(countingOnlyAi({}, 'NOW').createdAt).toBe('NOW');
  });

  test('it does not mutate the settings it was given', () => {
    const prev = { enabled: false, mode: 'off', faceRecognition: true };
    countingOnlyAi(prev, 'NOW');
    expect(prev).toEqual({ enabled: false, mode: 'off', faceRecognition: true });
  });

  test('the notice says counting started AND that faces are not matched', () => {
    // The tick did more than it said, so it says so. Both halves matter: the
    // second is the one that stops this reading as a privacy surprise.
    expect(AI_TURNED_ON_FOR_COUNTING).toMatch(/switched on so it can be counted/);
    expect(AI_TURNED_ON_FOR_COUNTING).toMatch(/faces are not matched/i);
    expect(AI_TURNED_ON_FOR_COUNTING).toMatch(/Camera Setup/);
  });
});

describe('the gate the endpoint applies', () => {
  // The endpoint runs countingOnlyAi only when `enabled && !isAiEnabled(camera)`.
  // These pin that condition, because "already on" must be left completely
  // alone -- its settings are its own and counting needs nothing changed.
  const startAi = (enabled, camera) => enabled && !isAiEnabled(camera);

  test('a camera whose master is already on is not touched', () => {
    expect(startAi(true, asCamera({ enabled: true, mode: 'continuous' }))).toBe(false);
  });

  test('a camera with face recognition running is not touched — that would turn it OFF', () => {
    const running = asCamera({ enabled: true, mode: 'continuous', faceRecognition: true });
    expect(startAi(true, running)).toBe(false);
    expect(faceRecognitionOn(running)).toBe(true);
  });

  test('a camera whose master is off is switched on', () => {
    expect(startAi(true, asCamera({ enabled: false }))).toBe(true);
    expect(startAi(true, asCamera({ enabled: true, mode: 'off' }))).toBe(true);
    expect(startAi(true, asCamera({}))).toBe(true);
    expect(startAi(true, { settings: {} })).toBe(true);
  });

  test('turning counting OFF never touches the master — other features hang off it', () => {
    expect(startAi(false, asCamera({ enabled: false }))).toBe(false);
    expect(startAi(false, asCamera({ enabled: true, mode: 'continuous' }))).toBe(false);
  });
});
