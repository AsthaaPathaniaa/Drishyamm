/**
 * ON means on. OFF means off. Absent means neither, so nothing stays absent.
 *
 * WHY THERE WAS A DISCREPANCY AT ALL
 * ---------------------------------
 * Each AI feature flag was added after cameras already existed, and each one
 * had to ship without changing what was already running on an operator's site.
 * That single rule produced two opposite defaults, because what was already
 * running differed per feature:
 *
 *   faceRecognition, journeyMapping, unknownAlerts, watchlistAlerts
 *       ABSENT MEANT ON. These were things every camera already did, under
 *       `ai.enabled` alone, before the flag split them out. Had absent meant
 *       off, the deploy would have stopped face recognition on every camera in
 *       every account at once.
 *
 *   activityMonitoring, zoneBodyDetection, headcount.enabled
 *       ABSENT MEANT OFF. These were new detectors that cost GPU per camera
 *       per frame. Had absent meant on, the deploy would have started a second
 *       and third model on every camera in every account at once.
 *
 * So the real rule was consistent -- "absent means whatever was happening
 * before this flag existed" -- and it LOOKED inconsistent because the previous
 * state was different for each feature. Both choices were right at the time.
 * Neither is right to keep: the cost is that a camera's stored settings do not
 * say what is running on it. You cannot read the row and know. You have to
 * know which of the two lists each flag is on, and there is nowhere that list
 * is written down. Seven readers each restated their own half of it.
 *
 * THIS FILE IS THAT LIST, AND IT IS THE ONLY COPY
 * -----------------------------------------------
 * `AI_FLAG_DEFAULTS` is what absent means, per flag, once and nowhere else.
 * Every reader goes through `flag()`. Migration 040 writes the effective value
 * onto every existing camera, so after it runs nothing is absent and the
 * defaults are a safety net rather than load-bearing.
 *
 * `flag()` is behaviour-identical to the two readings it replaces, for every
 * possible stored value -- that is asserted directly in aiFlags.test.js,
 * because a flag module that changes one camera's behaviour while being
 * introduced would be worse than the discrepancy it removes:
 *
 *   absent-means-ON  flags were read `v !== false`
 *   absent-means-OFF flags were read `v === true`
 *
 * A boolean reads as itself under both. Anything else (absent, null, a string,
 * a number) reads as the default under both. There is no input where they
 * differ.
 */

/**
 * What absent means, per flag. The ONLY copy of this table.
 *
 * `mode` is not here: it is not a boolean, and `isAiEnabled` tests it
 * separately ('off' is a third state the master switch can be parked in).
 */
const AI_FLAG_DEFAULTS = Object.freeze({
  // The master switch. Absent means off: a camera nobody has configured for AI
  // is not an AI camera.
  enabled: false,

  // Features every camera already did before the flags split them out.
  faceRecognition: true,
  journeyMapping: true,
  unknownAlerts: true,
  watchlistAlerts: true,

  // Detectors that cost GPU per camera, so they are opted into.
  activityMonitoring: false,
  zoneBodyDetection: false,
});

/** The same table for `settings.headcount`, which is its own object. */
const HEADCOUNT_FLAG_DEFAULTS = Object.freeze({
  enabled: false,
});

/** Flags whose absent value is ON — the ones that need no migration to keep working. */
const ON_BY_DEFAULT = Object.freeze(
  Object.keys(AI_FLAG_DEFAULTS).filter((k) => AI_FLAG_DEFAULTS[k] === true),
);

/**
 * Read one flag, explicitly.
 *
 * A stored boolean is the answer. Anything else -- absent, null, a string, a
 * number, a migration half-done -- is the documented default. See the file
 * docblock for why this is identical to what it replaces.
 *
 * @param stored the flag object (`settings.ai`, or `settings.headcount`)
 * @param name   the flag
 * @param table  which default table to use
 */
function flag(stored, name, table = AI_FLAG_DEFAULTS) {
  const value = (stored || {})[name];
  if (typeof value === 'boolean') return value;
  if (!Object.prototype.hasOwnProperty.call(table, name)) {
    // An unknown flag has no documented default, and guessing one here is how
    // an eighth reading of the rules gets invented. Off is the safe guess for
    // a flag nobody has written down: it starts nothing.
    return false;
  }
  return table[name];
}

/** One `settings.headcount` flag, explicitly. */
function headcountFlag(stored, name) {
  return flag(stored, name, HEADCOUNT_FLAG_DEFAULTS);
}

/**
 * `settings.ai` with every flag written out, so the object says what is on.
 *
 * Non-flag settings (fps, mode, purpose, detectionZones, timestamps…) are
 * carried through untouched: this makes the flags explicit and decides nothing
 * else. `mode` is normalised only in the one direction that cannot change
 * behaviour -- a camera whose master is off is parked at 'off', which is what
 * both writers already store.
 */
function explicitAi(ai) {
  const out = { ...(ai || {}) };
  for (const name of Object.keys(AI_FLAG_DEFAULTS)) {
    out[name] = flag(ai, name);
  }
  if (!out.enabled) out.mode = 'off';
  else if (!out.mode || out.mode === 'off') out.mode = 'continuous';
  return out;
}

/** `settings.headcount` with every flag written out. */
function explicitHeadcount(headcount) {
  const out = { ...(headcount || {}) };
  for (const name of Object.keys(HEADCOUNT_FLAG_DEFAULTS)) {
    out[name] = headcountFlag(headcount, name);
  }
  return out;
}

/**
 * A whole camera's `settings`, with every AI flag explicit.
 *
 * Returns null when there is nothing to change, so a backfill can skip the row
 * rather than rewrite it -- which keeps the migration's own report honest
 * about how many cameras were ambiguous.
 */
function explicitSettings(settings) {
  const current = settings || {};
  const ai = explicitAi(current.ai);
  const headcount = explicitHeadcount(current.headcount);
  const next = { ...current, ai, headcount };
  return JSON.stringify(next) === JSON.stringify(current) ? null : next;
}

/** Which flags on this camera are not stored as booleans — what the fix fixes. */
function ambiguousFlags(settings) {
  const current = settings || {};
  const out = [];
  for (const name of Object.keys(AI_FLAG_DEFAULTS)) {
    if (typeof (current.ai || {})[name] !== 'boolean') out.push(`ai.${name}`);
  }
  for (const name of Object.keys(HEADCOUNT_FLAG_DEFAULTS)) {
    if (typeof (current.headcount || {})[name] !== 'boolean') out.push(`headcount.${name}`);
  }
  return out;
}

module.exports = {
  AI_FLAG_DEFAULTS,
  HEADCOUNT_FLAG_DEFAULTS,
  ON_BY_DEFAULT,
  flag,
  headcountFlag,
  explicitAi,
  explicitHeadcount,
  explicitSettings,
  ambiguousFlags,
};
