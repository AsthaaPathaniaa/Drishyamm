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
 * Pure: no models, no logger, no bus. `now` is injectable so the window can be
 * tested at a time of day rather than at whatever o'clock CI runs.
 */

/**
 * Is `now` inside this zone's arm window?
 *
 * Three deliberate "yes"es, every one of them the safe answer for a security
 * feature — when the schedule cannot be read, the zone is WATCHED:
 *
 *   - no `armWindow`, or `schedule === 'always'`: there is no window to be
 *     outside of.
 *   - a window missing either end: half a window is not a schedule.
 *   - anything that throws (an unknown timezone, a malformed field).
 *
 * A window whose `from` is later than its `to` wraps past midnight
 * (22:00–06:00 is a night shift, not an empty set).
 */
function withinArmWindow(zone, now = new Date()) {
  if (!zone || !zone.armWindow || zone.schedule === 'always') return true;
  try {
    const hhmm = now.toLocaleTimeString('en-GB', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.ALERT_TIMEZONE || 'Asia/Kolkata',
    });
    const { from, to } = zone.armWindow;
    if (!from || !to) return true;
    return from <= to ? (hhmm >= from && hhmm <= to) : (hhmm >= from || hhmm <= to);
  } catch {
    return true;
  }
}

/** Enabled, and inside its window. What the intrusion engine asks. */
function isArmed(zone, now = new Date()) {
  if (!zone || !zone.enabled) return false;
  return withinArmWindow(zone, now);
}

module.exports = { isArmed, withinArmWindow };
