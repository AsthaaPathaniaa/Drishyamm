/**
 * "Is now inside this window?" — the one copy of that time maths.
 *
 * WHY IT MOVED OUT OF zoneArming.js
 * ---------------------------------
 * Restricted zones have had an arm window for a long time: a zone armed
 * 09:00-17:00 is off duty at midnight, and `zoneArming.js` held both the maths
 * and the question. Head counting now needs the SAME question for a different
 * reason -- an entrance nobody walks through between 22:00 and 07:00 does not
 * need a decode and a YOLO worker held open for nine hours -- and the thing it
 * must not do is ask it a second way.
 *
 * A second reading of "is it on duty now?" is how 22:00-06:00 comes to mean a
 * night shift in one file and an empty set in another. So the maths is here,
 * once, and each feature keeps its own NAME for the question:
 *
 *   zoneArming.withinArmWindow    is this zone watching?
 *   aiFeatureCameras (headcount)  is this camera counting?
 *
 * Pure: no models, no logger, no bus, no env read at import. `now` is
 * injectable so a window can be tested at a time of day rather than at
 * whatever o'clock CI happens to run.
 */

/**
 * The timezone a window's "09:00" is stated in.
 *
 * Read per call, not at import, because tests and a deployment both change it
 * and a value captured at require() time would ignore them. Same env var the
 * alert engine uses: an operator reading "09:00" on a zone and "09:00" on a
 * camera must not be reading two different nine o'clocks.
 */
function windowZone() {
  return process.env.ALERT_TIMEZONE || 'Asia/Kolkata';
}

/**
 * Is `now` inside `window`?
 *
 * FOUR DELIBERATE "YES"ES. When the schedule cannot be read, the window is
 * OPEN -- the feature runs:
 *
 *   - no window at all: there is nothing to be outside of. This is what every
 *     camera and zone that exists today carries, so absent MUST mean always.
 *   - `schedule === 'always'`: an explicit override that keeps a stored window
 *     without obeying it, so switching the schedule off does not destroy the
 *     hours somebody typed in.
 *   - a window missing either end: half a window is not a schedule.
 *   - anything that throws (an unknown timezone, a malformed field).
 *
 * The direction of that default is the safe one for BOTH callers, for opposite
 * reasons, which is worth being explicit about since it is the only thing
 * these two features could have disagreed on:
 *
 *   a zone      an unreadable schedule must not leave an area UNWATCHED.
 *   counting    an unreadable schedule must not leave a gap in the numbers.
 *               Running when it need not costs GPU; NOT running when it should
 *               loses data that cannot be recovered afterwards. Money is
 *               recoverable, a missing hour is not.
 *
 * A window whose `from` is later than its `to` WRAPS past midnight: 22:00-06:00
 * is a night shift, not an empty set. This is the case a second implementation
 * would have got wrong.
 *
 * @param {{window?: {from?: string, to?: string}, schedule?: string}} spec
 * @param {Date} now
 */
function withinWindow({ window, schedule } = {}, now = new Date()) {
  if (!window || schedule === 'always') return true;
  try {
    const hhmm = now.toLocaleTimeString('en-GB', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: windowZone(),
    });
    const { from, to } = window;
    if (!from || !to) return true;
    // Zero-padded HH:MM compares correctly as a string, which is why the
    // window is stored in that form rather than as minutes-since-midnight.
    return from <= to ? (hhmm >= from && hhmm <= to) : (hhmm >= from || hhmm <= to);
  } catch {
    return true;
  }
}

/** A single HH:MM, zero-padded, 00:00-23:59. Anything else is not a time. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The window an operator asked for, or null if they did not ask for one.
 *
 * Validated HERE rather than in the route because "what a window is" and "is
 * now inside one?" are the same question asked twice, and a route that invented
 * its own idea of a valid time would be the second copy this file exists to
 * prevent.
 *
 * Returns null -- meaning "no window, run always" -- for absent input and for
 * any shape that is not two real times. A REFUSAL would be the wrong answer:
 * the field is optional, and failing a whole save because one end was typed
 * badly would lose the rest of the operator's work.
 *
 * `from === to` is rejected. A one-minute window reads as a typo far more
 * often than as an instruction, and the two readings of it ("only at 09:00"
 * and "always") are too far apart to guess between.
 */
function parseWindow(input) {
  if (!input || typeof input !== 'object') return null;
  const from = String(input.from ?? '').trim();
  const to = String(input.to ?? '').trim();
  if (!HHMM.test(from) || !HHMM.test(to)) return null;
  if (from === to) return null;
  return { from, to };
}

module.exports = { withinWindow, parseWindow, HHMM };
