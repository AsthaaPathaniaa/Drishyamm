/**
 * What feeds a restricted zone its boxes — and the one rule that a zone must
 * never be armed with nothing feeding it.
 *
 * A zone does not detect anything itself. It subscribes to the overlay channel
 * and applies its dwell / confirm / cooldown rules to boxes some PRODUCER put
 * there. There are exactly two producers, and which one a camera should use is
 * a per-zone judgement the product now lets the operator make:
 *
 *   face pipeline   boxes carry a NAME, so an allow-list can excuse a person.
 *                   Needs `settings.ai.faceRecognition` (absent means on).
 *   zone-guard      boxes carry NO name, ever, by design. Catches the person
 *                   whose face is turned away, hooded, or too far to read.
 *                   Needs `settings.ai.zoneBodyDetection` (absent means OFF --
 *                   the opposite of faceRecognition, because a second detector
 *                   per camera is expensive and must be opted into).
 *
 * Why the choice is per camera rather than one deployment switch:
 *
 *   * a STRICT LOCKOUT zone wants zone-guard. Nobody is meant through, so
 *     nameless boxes are sufficient and a turned-away face is exactly the
 *     intruder it must catch.
 *   * an ALLOW-LIST zone is BROKEN by it: the engine excuses a person whose
 *     box carries a name on the list, and zone-guard's boxes carry none, so
 *     authorised staff raise a breach like an intruder. (That mode is not
 *     offered today for this reason — see access-data.js — but the switch
 *     must not silently re-break it when it returns.)
 *   * a camera with FACE RECOGNITION OFF needs it or the zone never fires at
 *     all: with no face pipeline there is no other producer.
 *
 * That last case is the INVARIANT this module exists to hold: an armed zone on
 * a camera with no producer is a security control that looks armed and watches
 * nothing. It is enforced at both places that can create it — the camera's AI
 * settings (which forces body detection on rather than refusing a save) and
 * the zone route (which refuses to arm) — and both ask the same functions here
 * so they cannot drift apart.
 *
 * The predicates are PURE and take `settings.ai` directly, so the rule can be
 * tested without a database and read without chasing a model.
 */

const { flag } = require('./aiFlags');

/**
 * Is this camera used by AI at all? Mirrors aiLifecycle's isAiEnabled.
 *
 * Reads the flag through aiFlags so what absent means lives in ONE table
 * rather than being restated here -- identical for every stored value, which
 * that file's tests assert directly.
 */
function aiOn(ai) {
  return flag(ai, 'enabled') && (ai || {}).mode !== 'off';
}

/**
 * Is the FACE pipeline producing boxes for this camera? Absent means on, so a
 * camera saved before the face flag existed still counts as a producer.
 */
function faceProducerOn(ai) {
  return aiOn(ai) && flag(ai, 'faceRecognition');
}

/**
 * Is ZONE-GUARD producing boxes for this camera? Absent means OFF: this one is
 * opt-in, so a camera that has never been told to run it does not.
 */
function bodyProducerOn(ai) {
  return aiOn(ai) && flag(ai, 'zoneBodyDetection');
}

/** Which producers would feed a zone on this camera, in display order. */
function zoneProducers(ai) {
  const out = [];
  if (faceProducerOn(ai)) out.push('face');
  if (bodyProducerOn(ai)) out.push('body');
  return out;
}

/** Would a zone armed on this camera have anything feeding it? */
function zoneHasProducer(ai) {
  return zoneProducers(ai).length > 0;
}

/**
 * Is body detection MANDATORY on this camera, rather than a choice?
 *
 * True when AI is on and face recognition is off: an anonymous camera has no
 * other producer, so a zone on it fires only if zone-guard is watching. AI
 * being off entirely is NOT this case — then nothing runs by the operator's
 * own instruction, which the UI already shows as "needs setup" rather than
 * silently arming something.
 */
function bodyDetectionRequired(ai) {
  return aiOn(ai) && !flag(ai, 'faceRecognition');
}

/** The reason shown wherever body detection is forced on or a zone refused. */
const NO_PRODUCER_REASON = 'This camera has face recognition off, so a restricted zone on it '
  + 'has nothing detecting people unless body detection is on. Switch on '
  + '"Catch people with no visible face" for this camera, or turn face recognition back on.';

/**
 * The `zoneBodyDetection` a patch is asking for, falling back to what is
 * stored. Absent means false at BOTH ends: an operator who has never seen this
 * switch has not opted in, and a patch that does not mention it is not asking
 * to change it.
 */
function nextZoneBodyFlag(patch, previousAi) {
  return (patch || {}).zoneBodyDetection !== undefined
    ? (patch || {}).zoneBodyDetection === true
    : (previousAi || {}).zoneBodyDetection === true;
}

module.exports = {
  aiOn,
  faceProducerOn,
  bodyProducerOn,
  zoneProducers,
  zoneHasProducer,
  bodyDetectionRequired,
  nextZoneBodyFlag,
  NO_PRODUCER_REASON,
};
