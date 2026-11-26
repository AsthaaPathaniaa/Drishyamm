/**
 * When a restricted zone is ARMED — the one copy of that question.
 *
 * It used to live inside zoneIntrusion.service.js alone, which meant the
 * ENGINE knew a zone armed 09:00–17:00 was off duty at midnight while the
 * thing FEEDING the engine did not. So zone-guard opened the camera, decoded
 * it, ran YOLO on it and posted boxes around the clock, and the engine threw
 * every one of them away for sixteen hours a day. The waste was invisible
 * because nothing was broken: the alerts were correct, they just cost three
 * times what they needed to.
 *
 * Two functions, because the two callers know different amounts:
 *
 *   withinArmWindow  is NOW inside the zone's window? The time maths, alone.
 *   isArmed          enabled AND within the window — the engine's question,
 *                    unchanged from the version this replaces.
 *
 * The camera selector (aiFeatureCameras.service.js) uses the first, because
 * `enabled: true` is already its SQL WHERE clause and re-testing it in JS
 * would be a second copy of a condition the database just applied.
 *
 * THE TIME MATHS ITSELF IS NO LONGER HERE. It moved to timeWindow.js when head
 * counting needed the same question for its own schedule, because the one
 * thing two features asking "is it on duty now?" must not do is answer it two
 * ways -- that is how 22:00-06:00 comes to mean a night shift in one file and
 * an empty set in another. What stays here is the zone's NAME for the
 * question and the fields it keeps the answer in; `withinArmWindow` is
 * identical to the version it replaces for every input, which is asserted
 * rather than claimed (zoneArming.test.js).
 */
const { withinWindow } = require('./timeWindow');

/**
 * Is `now` inside this zone's arm window?
 *
 * The three deliberate "yes"es -- no window, half a window, anything that
 * throws -- are documented where they are implemented, in timeWindow.js. For a
 * security feature they are all the safe answer: when the schedule cannot be
 * read, the zone is WATCHED.
 */
function withinArmWindow(zone, now = new Date()) {
  return withinWindow({ window: zone?.armWindow, schedule: zone?.schedule }, now);
}

/** Enabled, and inside its window. What the intrusion engine asks. */
function isArmed(zone, now = new Date()) {
  if (!zone || !zone.enabled) return false;
  return withinArmWindow(zone, now);
}

module.exports = { isArmed, withinArmWindow };
