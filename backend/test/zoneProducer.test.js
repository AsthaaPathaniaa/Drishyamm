/**
 * The zone producer rules, and the invariant they exist to hold.
 *
 * A restricted zone detects nothing itself: it applies its dwell / confirm
 * rules to boxes a PRODUCER publishes. There are two, and until this change
 * there was no per-camera choice between them -- zone-guard watched any camera
 * that had an enabled zone, an AI switch on and a plan, which is wrong in two
 * directions at once. An allow-list zone is broken by zone-guard's nameless
 * boxes; a camera with face recognition off needs them or its zone never fires.
 *
 * These tests pin the rules both write paths consult, including the default
 * that makes the new switch safe to add to a live fleet: ABSENT MEANS FALSE,
 * the opposite of faceRecognition, so no camera starts running a second
 * detector because this shipped.
 */

const {
  aiOn, faceProducerOn, bodyProducerOn, zoneProducers, zoneHasProducer,
  bodyDetectionRequired, nextZoneBodyFlag, NO_PRODUCER_REASON,
} = require('../src/services/zoneProducer.service');

const ai = (over = {}) => ({ enabled: true, mode: 'continuous', ...over });

describe('the master switch gates both producers', () => {
  test('AI off means no producer, whatever the feature flags say', () => {
    const off = ai({ enabled: false, mode: 'off', zoneBodyDetection: true });
    expect(aiOn(off)).toBe(false);
    expect(faceProducerOn(off)).toBe(false);
    expect(bodyProducerOn(off)).toBe(false);
    expect(zoneHasProducer(off)).toBe(false);
  });

  test("mode 'off' with enabled still true is also off", () => {
    // The same pair isAiEnabled tests, so the two can never disagree.
    const off = ai({ mode: 'off', zoneBodyDetection: true });
    expect(bodyProducerOn(off)).toBe(false);
    expect(faceProducerOn(off)).toBe(false);
  });

  test('a camera with no ai settings at all has no producer', () => {
    expect(zoneHasProducer(undefined)).toBe(false);
    expect(zoneHasProducer({})).toBe(false);
    expect(zoneHasProducer(null)).toBe(false);
  });
});

describe('face recognition: absent means ON', () => {
  test('a camera saved before the flag existed is still a producer', () => {
    // No migration ran. If this flips, every legacy camera silently loses the
    // producer its zones have always been fed by.
    expect(faceProducerOn(ai())).toBe(true);
    expect(zoneProducers(ai())).toEqual(['face']);
  });

  test('explicitly false is the anonymous camera', () => {
    expect(faceProducerOn(ai({ faceRecognition: false }))).toBe(false);
  });
});

describe('zone body detection: absent means OFF', () => {
  test('a camera that has never been told to run it does not', () => {
    // The whole point of the default. This switch costs GPU on every frame of
    // every camera it is on, so it is opted into, never inherited.
    expect(bodyProducerOn(ai())).toBe(false);
    expect(bodyProducerOn(ai({ zoneBodyDetection: undefined }))).toBe(false);
  });

  test('only an explicit true counts', () => {
    expect(bodyProducerOn(ai({ zoneBodyDetection: true }))).toBe(true);
    expect(bodyProducerOn(ai({ zoneBodyDetection: false }))).toBe(false);
    // Not truthiness: a stored string must not arm a detector.
    expect(bodyProducerOn(ai({ zoneBodyDetection: 'yes' }))).toBe(false);
    expect(bodyProducerOn(ai({ zoneBodyDetection: 1 }))).toBe(false);
  });
});

describe('both producers can run at once', () => {
  test('face on and body on is two producers, not a conflict', () => {
    // A lockout zone on a camera that also recognises faces is a legitimate
    // and common setup: the face pipeline names who it can, zone-guard catches
    // the person whose face it cannot read.
    const both = ai({ zoneBodyDetection: true });
    expect(zoneProducers(both)).toEqual(['face', 'body']);
    expect(zoneHasProducer(both)).toBe(true);
  });

  test('an anonymous camera with body detection has exactly one', () => {
    expect(zoneProducers(ai({ faceRecognition: false, zoneBodyDetection: true }))).toEqual(['body']);
  });
});

describe('bodyDetectionRequired: when it stops being a choice', () => {
  test('AI on with face off is the case that forces it', () => {
    expect(bodyDetectionRequired(ai({ faceRecognition: false }))).toBe(true);
  });

  test('face on leaves it a free choice', () => {
    // Both answers are legitimate here -- a lockout wants it, an allow-list
    // zone is broken by it -- so the product must not decide.
    expect(bodyDetectionRequired(ai())).toBe(false);
    expect(bodyDetectionRequired(ai({ faceRecognition: true }))).toBe(false);
  });

  test('AI off entirely is NOT this case', () => {
    // Nothing runs because the operator said so, and the UI already shows a
    // drawn-but-dormant feature as needing setup. Forcing a detector onto a
    // camera whose AI is off would start work nobody asked for.
    expect(bodyDetectionRequired(ai({ enabled: false, mode: 'off', faceRecognition: false }))).toBe(false);
    expect(bodyDetectionRequired(ai({ mode: 'off', faceRecognition: false }))).toBe(false);
  });

  test('a camera with face absent is not anonymous', () => {
    // Absent means on, so there IS a producer and nothing is forced.
    expect(bodyDetectionRequired({ enabled: true, mode: 'continuous' })).toBe(false);
  });
});

describe('nextZoneBodyFlag: what a patch asks for', () => {
  test('an explicit value in the patch wins', () => {
    expect(nextZoneBodyFlag({ zoneBodyDetection: true }, { zoneBodyDetection: false })).toBe(true);
    expect(nextZoneBodyFlag({ zoneBodyDetection: false }, { zoneBodyDetection: true })).toBe(false);
  });

  test('a patch that does not mention it keeps the stored value', () => {
    expect(nextZoneBodyFlag({ fps: 6 }, { zoneBodyDetection: true })).toBe(true);
    expect(nextZoneBodyFlag({ fps: 6 }, { zoneBodyDetection: false })).toBe(false);
  });

  test('neither saying means false', () => {
    expect(nextZoneBodyFlag({}, {})).toBe(false);
    expect(nextZoneBodyFlag(undefined, undefined)).toBe(false);
    expect(nextZoneBodyFlag(null, null)).toBe(false);
  });

  test('only a real boolean true turns it on', () => {
    expect(nextZoneBodyFlag({ zoneBodyDetection: 'true' }, {})).toBe(false);
  });
});

test('the reason names the switch an operator has to find', () => {
  // A refusal with no next step is how someone ends up deleting the zone
  // instead of fixing the camera.
  expect(NO_PRODUCER_REASON).toContain('Catch people with no visible face');
  expect(NO_PRODUCER_REASON).toContain('face recognition');
});
