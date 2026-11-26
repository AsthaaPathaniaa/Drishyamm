/**
 * ON means on, OFF means off — and introducing that rule changed nobody.
 *
 * The first block is the important one. aiFlags.flag() replaces two different
 * readings that were scattered across seven call sites:
 *
 *   absent-means-ON  flags were read `v !== false`
 *   absent-means-OFF flags were read `v === true`
 *
 * A flag module that quietly changed one camera's behaviour while being
 * introduced would be worse than the discrepancy it removes, so the
 * equivalence is asserted against every kind of value a JSON column can hand
 * back, not argued for in a comment.
 */
const {
  AI_FLAG_DEFAULTS, HEADCOUNT_FLAG_DEFAULTS, ON_BY_DEFAULT,
  flag, headcountFlag, explicitAi, explicitHeadcount, explicitSettings,
  ambiguousFlags,
} = require('../src/services/aiFlags');

const {
  isAiEnabled, faceRecognitionOn,
} = require('../src/services/aiLifecycle.service');
const {
  faceProducerOn, bodyProducerOn, bodyDetectionRequired,
} = require('../src/services/zoneProducer.service');

// Everything a JSON column can give back for a flag.
const VALUES = [
  undefined, null, true, false, 0, 1, '', 'true', 'false', 'yes', [], {}, NaN,
];
const label = (v) => (typeof v === 'string' ? `"${v}"` : String(v));

describe('flag() is identical to the readings it replaces', () => {
  test.each(VALUES)('absent-means-ON flag, stored %s, reads as `!== false` did', (v) => {
    expect(flag({ faceRecognition: v }, 'faceRecognition')).toBe(v !== false);
  });

  test.each(VALUES)('absent-means-OFF flag, stored %s, reads as `=== true` did', (v) => {
    expect(flag({ zoneBodyDetection: v }, 'zoneBodyDetection')).toBe(v === true);
  });

  test('an absent flag object reads as every default', () => {
    for (const [name, want] of Object.entries(AI_FLAG_DEFAULTS)) {
      expect(flag(undefined, name)).toBe(want);
      expect(flag(null, name)).toBe(want);
      expect(flag({}, name)).toBe(want);
    }
  });

  test('a flag nobody wrote down is OFF — it must not start anything', () => {
    expect(flag({}, 'somethingNew')).toBe(false);
    // An explicit value is still honoured, so a flag added to a writer before
    // this table is not silently ignored.
    expect(flag({ somethingNew: true }, 'somethingNew')).toBe(true);
  });

  test('the two default lists are what the docblock says they are', () => {
    expect([...ON_BY_DEFAULT].sort()).toEqual(
      ['faceRecognition', 'journeyMapping', 'unknownAlerts', 'watchlistAlerts'],
    );
    expect(AI_FLAG_DEFAULTS.enabled).toBe(false);
    expect(AI_FLAG_DEFAULTS.activityMonitoring).toBe(false);
    expect(AI_FLAG_DEFAULTS.zoneBodyDetection).toBe(false);
    expect(HEADCOUNT_FLAG_DEFAULTS.enabled).toBe(false);
  });

  test('the table cannot be edited at runtime — one copy means one copy', () => {
    // Frozen, so a caller cannot localise the rules by poking the table. The
    // guarantee is that the value does not change: a write to a frozen object
    // throws only under 'use strict', and these are CommonJS modules.
    AI_FLAG_DEFAULTS.faceRecognition = false;
    AI_FLAG_DEFAULTS.newFlag = true;
    expect(AI_FLAG_DEFAULTS.faceRecognition).toBe(true);
    expect(AI_FLAG_DEFAULTS.newFlag).toBeUndefined();
    expect(flag({}, 'faceRecognition')).toBe(true);
  });
});

describe('the readers that now share the table still answer as before', () => {
  const cam = (ai) => ({ settings: { ai } });

  test('isAiEnabled: the master needs true AND a mode that is not off', () => {
    expect(isAiEnabled(cam({ enabled: true, mode: 'continuous' }))).toBe(true);
    expect(isAiEnabled(cam({ enabled: true }))).toBe(true);
    expect(isAiEnabled(cam({ enabled: true, mode: 'off' }))).toBe(false);
    expect(isAiEnabled(cam({ enabled: false }))).toBe(false);
    expect(isAiEnabled(cam({}))).toBe(false);
    expect(isAiEnabled({ settings: {} })).toBe(false);
    expect(isAiEnabled({})).toBe(false);
  });

  test('faceRecognitionOn: absent still means ON', () => {
    expect(faceRecognitionOn(cam({}))).toBe(true);
    expect(faceRecognitionOn(cam({ faceRecognition: false }))).toBe(false);
    expect(faceRecognitionOn({})).toBe(true);
  });

  test('faceProducerOn needs the master AND face', () => {
    expect(faceProducerOn({ enabled: true, mode: 'continuous' })).toBe(true);
    expect(faceProducerOn({ enabled: true, faceRecognition: false })).toBe(false);
    expect(faceProducerOn({ enabled: false })).toBe(false);
    expect(faceProducerOn({})).toBe(false);
  });

  test('bodyProducerOn needs the master AND an explicit opt-in', () => {
    expect(bodyProducerOn({ enabled: true, zoneBodyDetection: true })).toBe(true);
    expect(bodyProducerOn({ enabled: true })).toBe(false);
    expect(bodyProducerOn({ zoneBodyDetection: true })).toBe(false);
    expect(bodyProducerOn({})).toBe(false);
  });

  test('bodyDetectionRequired is the anonymous camera: master on, face off', () => {
    expect(bodyDetectionRequired({ enabled: true, faceRecognition: false })).toBe(true);
    expect(bodyDetectionRequired({ enabled: true })).toBe(false);
    expect(bodyDetectionRequired({ enabled: false, faceRecognition: false })).toBe(false);
  });
});

describe('explicitAi — writing the flags out changes no answer', () => {
  test('a camera with nothing stored comes out all-default and readable', () => {
    const ai = explicitAi(undefined);
    expect(ai).toMatchObject({
      enabled: false, faceRecognition: true, journeyMapping: true,
      unknownAlerts: true, watchlistAlerts: true,
      activityMonitoring: false, zoneBodyDetection: false, mode: 'off',
    });
    for (const name of Object.keys(AI_FLAG_DEFAULTS)) {
      expect(typeof ai[name]).toBe('boolean');
    }
  });

  test('every reader gives the same answer before and after', () => {
    const before = { enabled: true, faceRecognition: undefined, zoneBodyDetection: 'yes' };
    const after = explicitAi(before);
    expect(faceProducerOn(after)).toBe(faceProducerOn(before));
    expect(bodyProducerOn(after)).toBe(bodyProducerOn(before));
    expect(bodyDetectionRequired(after)).toBe(bodyDetectionRequired(before));
    expect(isAiEnabled({ settings: { ai: after } }))
      .toBe(isAiEnabled({ settings: { ai: before } }));
  });

  test('non-flag settings are carried through untouched', () => {
    const ai = explicitAi({
      enabled: true, fps: 12, detectionInputSize: 1280, purpose: 'gate',
      priority: 'high', detectionZones: [{ id: 'z' }], createdAt: 'T0',
    });
    expect(ai.fps).toBe(12);
    expect(ai.detectionInputSize).toBe(1280);
    expect(ai.purpose).toBe('gate');
    expect(ai.priority).toBe('high');
    expect(ai.detectionZones).toEqual([{ id: 'z' }]);
    expect(ai.createdAt).toBe('T0');
  });

  test('mode is only normalised in the direction both writers already store', () => {
    expect(explicitAi({ enabled: false, mode: 'continuous' }).mode).toBe('off');
    expect(explicitAi({ enabled: true, mode: 'off' }).mode).toBe('continuous');
    expect(explicitAi({ enabled: true, mode: 'scheduled' }).mode).toBe('scheduled');
  });

  test('it does not mutate its input', () => {
    const before = { enabled: true };
    explicitAi(before);
    expect(before).toEqual({ enabled: true });
  });

  test('explicitHeadcount writes its one flag and keeps the rest', () => {
    expect(explicitHeadcount({ threshold: 20, zones: [1] })).toEqual({
      enabled: false, threshold: 20, zones: [1],
    });
    expect(explicitHeadcount({ enabled: true }).enabled).toBe(true);
  });
});

describe('explicitSettings — what the migration writes, and what it skips', () => {
  test('a camera already fully explicit is SKIPPED, not rewritten', () => {
    const explicit = {
      ai: explicitAi({ enabled: true }),
      headcount: explicitHeadcount({ enabled: true }),
    };
    expect(explicitSettings(explicit)).toBe(null);
  });

  test('a camera with one ambiguous flag is rewritten', () => {
    const next = explicitSettings({ ai: { enabled: true }, headcount: { enabled: true } });
    expect(next).not.toBe(null);
    expect(next.ai.faceRecognition).toBe(true);
    expect(next.ai.zoneBodyDetection).toBe(false);
  });

  test('settings unrelated to AI survive the rewrite', () => {
    const next = explicitSettings({ ai: {}, transcode: { enabled: true }, recording: { days: 30 } });
    expect(next.transcode).toEqual({ enabled: true });
    expect(next.recording).toEqual({ days: 30 });
  });

  test('running it twice is a no-op the second time', () => {
    const once = explicitSettings({ ai: { enabled: true } });
    expect(explicitSettings(once)).toBe(null);
  });

  test('ambiguousFlags names exactly what is not a boolean', () => {
    expect(ambiguousFlags({ ai: explicitAi({}), headcount: explicitHeadcount({}) })).toEqual([]);
    expect(ambiguousFlags({ ai: { enabled: true, faceRecognition: false } })).toEqual([
      'ai.journeyMapping', 'ai.unknownAlerts', 'ai.watchlistAlerts',
      'ai.activityMonitoring', 'ai.zoneBodyDetection', 'headcount.enabled',
    ]);
  });
});
