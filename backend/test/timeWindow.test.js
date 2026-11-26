/**
 * "Is now inside this window?" — the maths two features share.
 *
 * It was zone-guard's alone until head counting needed the same question for
 * its own schedule. These tests exist because the alternative was a second
 * implementation, and the case a second implementation gets wrong is the
 * commonest one anybody actually configures: 22:00-07:00, which WRAPS past
 * midnight and reads as an empty set to a naive `from <= now && now <= to`.
 *
 * Every "the window is OPEN when the schedule cannot be read" case is pinned
 * here too, because that default is load-bearing in opposite directions for
 * the two callers -- an unreadable zone schedule must not leave an area
 * unwatched, and an unreadable counting schedule must not leave a hole in the
 * numbers -- and a change to it would be silent in both.
 *
 * ALERT_TIMEZONE is pinned so the times below are the window's own clock. A
 * test that passed in Asia/Kolkata and failed on a UTC CI box would be worse
 * than no test.
 */

process.env.ALERT_TIMEZONE = 'UTC';

const { withinWindow, parseWindow } = require('../src/services/timeWindow');

/** A Date at HH:MM UTC, which ALERT_TIMEZONE above makes the window's clock. */
const at = (hh, mm = 0) => new Date(Date.UTC(2026, 10, 23, hh, mm, 0));
const win = (from, to, over = {}) => ({ window: { from, to }, ...over });

describe('withinWindow — a day shift', () => {
  test('open inside it', () => {
    expect(withinWindow(win('09:00', '17:00'), at(12))).toBe(true);
  });
  test('shut before it and after it', () => {
    expect(withinWindow(win('09:00', '17:00'), at(3))).toBe(false);
    expect(withinWindow(win('09:00', '17:00'), at(21))).toBe(false);
  });
  test('both ends are inclusive, so a window never has a dead minute', () => {
    expect(withinWindow(win('09:00', '17:00'), at(9, 0))).toBe(true);
    expect(withinWindow(win('09:00', '17:00'), at(17, 0))).toBe(true);
  });
  test('one minute outside each end is outside', () => {
    expect(withinWindow(win('09:00', '17:00'), at(8, 59))).toBe(false);
    expect(withinWindow(win('09:00', '17:00'), at(17, 1))).toBe(false);
  });
});

describe('withinWindow — a night shift wraps past midnight', () => {
  // The case a second copy of this maths gets wrong, and the commonest reason
  // anybody sets counting hours at all.
  test('open on both sides of midnight', () => {
    expect(withinWindow(win('22:00', '06:00'), at(23))).toBe(true);
    expect(withinWindow(win('22:00', '06:00'), at(0, 30))).toBe(true);
    expect(withinWindow(win('22:00', '06:00'), at(2))).toBe(true);
  });
  test('shut through the middle of the day', () => {
    expect(withinWindow(win('22:00', '06:00'), at(12))).toBe(false);
    expect(withinWindow(win('22:00', '06:00'), at(7))).toBe(false);
  });
  test('it is not read as an empty set', () => {
    // 24 hourly samples: a wrapping window must be open for SOME of them.
    const open = Array.from({ length: 24 }, (_, h) => withinWindow(win('22:00', '06:00'), at(h)));
    expect(open.filter(Boolean).length).toBe(9); // 22,23,0..6
  });
});

describe('withinWindow — when the schedule cannot be read, it is OPEN', () => {
  // All four of these are the safe answer for both callers, for opposite
  // reasons. See the module header.
  test('no window at all — what every existing camera and zone carries', () => {
    expect(withinWindow({}, at(3))).toBe(true);
    expect(withinWindow(undefined, at(3))).toBe(true);
    expect(withinWindow({ window: null }, at(3))).toBe(true);
  });
  test("schedule 'always' ignores a stored window without destroying it", () => {
    const spec = win('09:00', '17:00', { schedule: 'always' });
    expect(withinWindow(spec, at(3))).toBe(true);
    // The hours are still there to go back to.
    expect(spec.window).toEqual({ from: '09:00', to: '17:00' });
  });
  test('half a window is not a schedule', () => {
    expect(withinWindow({ window: { from: '09:00' } }, at(3))).toBe(true);
    expect(withinWindow({ window: { to: '17:00' } }, at(3))).toBe(true);
    expect(withinWindow({ window: {} }, at(3))).toBe(true);
  });
  test('an unreadable timezone does not shut the window', () => {
    const prev = process.env.ALERT_TIMEZONE;
    process.env.ALERT_TIMEZONE = 'Not/AZone';
    try {
      expect(withinWindow(win('09:00', '17:00'), at(3))).toBe(true);
    } finally {
      process.env.ALERT_TIMEZONE = prev;
    }
  });
});

describe('parseWindow', () => {
  test('two real times come back as a window', () => {
    expect(parseWindow({ from: '09:00', to: '17:00' })).toEqual({ from: '09:00', to: '17:00' });
    expect(parseWindow({ from: '22:00', to: '06:00' })).toEqual({ from: '22:00', to: '06:00' });
    expect(parseWindow({ from: '00:00', to: '23:59' })).toEqual({ from: '00:00', to: '23:59' });
  });
  test('whitespace is trimmed, since a time input can send it', () => {
    expect(parseWindow({ from: ' 09:00 ', to: '17:00' })).toEqual({ from: '09:00', to: '17:00' });
  });
  test('anything that is not two zero-padded 24h times is NO window', () => {
    // Null is the answer, never a throw: the field is optional and arrives
    // beside the tick, the threshold and the zones, so refusing the whole save
    // over a mistyped time would throw away work the operator can see.
    for (const bad of [
      { from: '9:00', to: '17:00' },     // not padded
      { from: '09:00', to: '5pm' },      // not 24h
      { from: '24:00', to: '06:00' },    // no such hour
      { from: '09:60', to: '17:00' },    // no such minute
      { from: '09:00' },                 // half a window
      { to: '17:00' },
      {}, null, undefined, 'always', 42, [],
    ]) {
      expect(parseWindow(bad)).toBeNull();
    }
  });
  test('a zero-length window is refused rather than guessed at', () => {
    // "Only at 09:00" and "always" are too far apart to pick between, and the
    // shape reads as a typo far more often than as an instruction.
    expect(parseWindow({ from: '09:00', to: '09:00' })).toBeNull();
  });
});
