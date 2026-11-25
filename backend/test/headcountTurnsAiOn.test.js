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
  isAiEnabled, faceRecognitionOn, masterOnForFeature, AI_TURNED_ON_FOR_COUNTING,
} = require('../src/services/aiLifecycle.service');

const asCamera = (ai) => ({ settings: { ai } });

describe('masterOnForFeature — the master switch, for one feature', () => {
  test('a camera that has never had AI configured comes out counted', () => {
    const ai = masterOnForFeature(undefined, 'NOW');
    expect(isAiEnabled(asCamera(ai))).toBe(true);
    expect(ai.mode).toBe('continuous');
  });

  test('called with nothing at all it still produces a usable master switch', () => {
    const ai = masterOnForFeature();
    expect(isAiEnabled(asCamera(ai))).toBe(true);
    expect(typeof ai.updatedAt).toBe('string');
  });

  // ── counting only. One assertion per feature that hangs off the master. ──

  test('FACE stays off: absent means ON, so it is set explicitly false', () => {
    const ai = masterOnForFeature({}, 'NOW');
    expect(ai.faceRecognition).toBe(false);
    expect(faceRecognitionOn(asCamera(ai))).toBe(false);
  });

  test('an explicit faceRecognition:true is overridden, not honoured', () => {
    // Nothing was running -- the master was off -- and honouring it would
    // spend a face licence that can be REFUSED, failing a tick the Head Count
    // page cannot act on. Turning it back on in Camera Setup is additive.
    const ai = masterOnForFeature({ faceRecognition: true }, 'NOW');
    expect(ai.faceRecognition).toBe(false);
  });

  test('ACTIVITY stays off — it needs activityMonitoring === true', () => {
    const ai = masterOnForFeature({}, 'NOW');
    expect(ai.activityMonitoring).toBeUndefined();
    expect(ai.activityMonitoring === true).toBe(false);
  });

  test('ZONE-GUARD stays off — it needs zoneBodyDetection === true', () => {
    const ai = masterOnForFeature({}, 'NOW');
    expect(ai.zoneBodyDetection).toBeUndefined();
    expect(ai.zoneBodyDetection === true).toBe(false);
  });

  test('a camera that had asked for zone-guard keeps it; this adds nothing', () => {
    const ai = masterOnForFeature({ zoneBodyDetection: true }, 'NOW');
    expect(ai.zoneBodyDetection).toBe(true);
  });

  // ── what it carries over ────────────────────────────────────────────────

  test('every unrelated setting the camera already had is carried over', () => {
    const ai = masterOnForFeature({
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
    expect(masterOnForFeature({ mode: 'scheduled' }, 'NOW').mode).toBe('scheduled');
    expect(masterOnForFeature({ mode: 'off' }, 'NOW').mode).toBe('continuous');
    expect(masterOnForFeature({ mode: '' }, 'NOW').mode).toBe('continuous');
  });

  test('createdAt is preserved and disabledAt / lastError are cleared', () => {
    const ai = masterOnForFeature({
      createdAt: 'FIRST', disabledAt: 'WHEN-OFF', lastError: 'something old',
    }, 'NOW');
    expect(ai.createdAt).toBe('FIRST');
    expect(ai.updatedAt).toBe('NOW');
    expect(ai.disabledAt).toBe(null);
    expect(ai.lastError).toBe(null);
  });

  test('a camera with no createdAt gets this moment as its first', () => {
    expect(masterOnForFeature({}, 'NOW').createdAt).toBe('NOW');
  });

  test('it does not mutate the settings it was given', () => {
    const prev = { enabled: false, mode: 'off', faceRecognition: true };
    masterOnForFeature(prev, 'NOW');
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
  // The endpoint runs masterOnForFeature only when `enabled && !isAiEnabled(camera)`.
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

/**
 * Consent: switching the master on is ASKED FOR, not reported afterwards.
 *
 * An earlier version of this change switched the master on by itself and said
 * so in the response. That made the feature work and took a decision that is
 * not the endpoint's to take -- using a camera for AI at all is a privacy and
 * a cost choice, and "I ticked counting" is not the same sentence as "yes, run
 * AI on this camera".
 *
 * These pin the ENDPOINT'S rule, so the question cannot be skipped by any
 * caller: the dialog, Zone Setup, a script, or a page written next year.
 */
describe('consent before the master switch is touched', () => {
  const { AI_CONSENT_REQUIRED, aiConsentQuestion } = require('../src/services/aiLifecycle.service');

  // The exact condition the endpoint applies, as a pure function of the
  // request. `refuse` means: do not write ANYTHING and ask instead.
  const decide = (camera, body) => {
    const enabled = body.enabled === true;
    const startAi = enabled && !isAiEnabled(camera);
    if (startAi && body.enableAi !== true) return 'refuse';
    return startAi ? 'turn-master-on' : 'write-as-asked';
  };

  const off = asCamera({ enabled: false, mode: 'off' });
  const on = asCamera({ enabled: true, mode: 'continuous' });

  test('ticking a camera whose AI is off is REFUSED, not quietly obeyed', () => {
    expect(decide(off, { enabled: true })).toBe('refuse');
  });

  test('the same tick WITH consent turns the master on', () => {
    expect(decide(off, { enabled: true, enableAi: true })).toBe('turn-master-on');
  });

  test('consent is `true` and nothing else — no truthy strings', () => {
    expect(decide(off, { enabled: true, enableAi: 'yes' })).toBe('refuse');
    expect(decide(off, { enabled: true, enableAi: 1 })).toBe('refuse');
    expect(decide(off, { enabled: true, enableAi: false })).toBe('refuse');
  });

  test('a camera whose AI is on never asks — consent is irrelevant there', () => {
    expect(decide(on, { enabled: true })).toBe('write-as-asked');
    expect(decide(on, { enabled: true, enableAi: true })).toBe('write-as-asked');
  });

  test('UN-ticking is never refused, with or without consent', () => {
    // Turning a feature off cannot need permission to touch a switch it does
    // not touch.
    expect(decide(off, { enabled: false })).toBe('write-as-asked');
    expect(decide(on, { enabled: false })).toBe('write-as-asked');
  });

  test('a refusal writes NOTHING — a half-landed save is the state this prevents', () => {
    // The whole point: refusing after storing `headcount.enabled` would leave
    // the camera ticked and still not counting, which is the exact state this
    // path exists to make impossible.
    expect(decide(off, { enabled: true })).toBe('refuse');
    expect(off.settings.ai.enabled).toBe(false);
    expect(off.settings.headcount).toBeUndefined();
  });

  test('the refusal carries a code a client can branch on', () => {
    expect(AI_CONSENT_REQUIRED).toBe('AI_CONSENT_REQUIRED');
  });

  test('the question names the camera, what starts, and what does not', () => {
    const q = aiConsentQuestion('counted', 'Server room');
    expect(q).toMatch(/^Server room has AI switched off/);
    expect(q).toMatch(/cannot be counted yet/);
    expect(q).toMatch(/faces are not matched/);
    expect(q).toMatch(/no other AI feature is started/);
  });

  test('with no camera name it still reads as a sentence', () => {
    expect(aiConsentQuestion('counted')).toMatch(/^this camera has AI switched off/);
  });
});
