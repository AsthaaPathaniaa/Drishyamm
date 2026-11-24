/**
 * When a restricted zone is on duty.
 *
 * This predicate used to live inside the intrusion engine, where only the
 * engine could reach it: it refused to ALERT outside a zone's window while
 * zone-guard went on decoding the camera and running YOLO on it around the
 * clock, posting boxes the engine then dropped. Moving it out is what lets the
 * camera selector ask the same question — so these tests pin the answer both
 * of them now depend on, including every case that must answer "watched"
 * because a security feature cannot fail quiet.
 *
 * Times are built in the window's own timezone, which is why ALERT_TIMEZONE is
 * pinned below: a test that passed in Asia/Kolkata and failed on a CI box in
 * UTC would be worse than no test.
 */

process.env.ALERT_TIMEZONE = 'UTC';

const { isArmed, withinArmWindow } = require('../src/services/zoneArming');

/** A Date at HH:MM UTC, which ALERT_TIMEZONE above makes the window's clock. */
const at = (hh, mm = 0) => new Date(Date.UTC(2026, 10, 23, hh, mm, 0));

const windowed = (from, to, over = {}) => ({
  enabled: true, schedule: 'custom', armWindow: { from, to }, ...over,
});

describe('withinArmWindow', () => {
  test('a day-shift window is on inside it and off outside it', () => {
    const z = windowed('09:00', '17:00');
    expect(withinArmWindow(z, at(9, 0))).toBe(true);
    expect(withinArmWindow(z, at(12, 30))).toBe(true);
    expect(withinArmWindow(z, at(17, 0))).toBe(true);
    expect(withinArmWindow(z, at(8, 59))).toBe(false);
    expect(withinArmWindow(z, at(17, 1))).toBe(false);
    expect(withinArmWindow(z, at(0, 0))).toBe(false);
  });

  test('a window that wraps past midnight is a night shift, not an empty set', () => {
    const z = windowed('22:00', '06:00');
    expect(withinArmWindow(z, at(23, 30))).toBe(true);
    expect(withinArmWindow(z, at(2, 0))).toBe(true);
    expect(withinArmWindow(z, at(6, 0))).toBe(true);
    expect(withinArmWindow(z, at(12, 0))).toBe(false);
    expect(withinArmWindow(z, at(21, 59))).toBe(false);
  });

  test('a zone with no window to be outside of is always on duty', () => {
    // Every zone that exists today: `schedule` defaults to 'always'.
    expect(withinArmWindow({ enabled: true, schedule: 'always' }, at(3))).toBe(true);
    expect(withinArmWindow({ enabled: true }, at(3))).toBe(true);
    expect(withinArmWindow({ enabled: true, armWindow: null }, at(3))).toBe(true);
    // 'always' wins even if a window was left behind by an earlier edit.
    expect(withinArmWindow(windowed('09:00', '17:00', { schedule: 'always' }), at(3))).toBe(true);
  });

  test('a schedule that cannot be read answers WATCHED, never silent', () => {
    // Half a window is not a schedule, and a feature that stops watching
    // because a field is malformed is the worst failure this code can have.
    expect(withinArmWindow(windowed('09:00', null), at(3))).toBe(true);
    expect(withinArmWindow(windowed(null, '17:00'), at(3))).toBe(true);
    expect(withinArmWindow(windowed('', ''), at(3))).toBe(true);
    expect(withinArmWindow({ enabled: true, schedule: 'custom', armWindow: {} }, at(3))).toBe(true);
    // A `now` that cannot be formatted at all.
    expect(withinArmWindow(windowed('09:00', '17:00'), null)).toBe(true);
    expect(withinArmWindow(null, at(12))).toBe(true);
  });
});

describe('isArmed', () => {
  test('is the window test plus enabled — the engine\'s question, unchanged', () => {
    expect(isArmed(windowed('09:00', '17:00'), at(12))).toBe(true);
    expect(isArmed(windowed('09:00', '17:00'), at(3))).toBe(false);
    expect(isArmed({ enabled: true, schedule: 'always' }, at(3))).toBe(true);
  });

  test('a disabled zone is never armed, whatever its window says', () => {
    expect(isArmed(windowed('09:00', '17:00', { enabled: false }), at(12))).toBe(false);
    expect(isArmed({ enabled: false, schedule: 'always' }, at(12))).toBe(false);
    expect(isArmed({ schedule: 'always' }, at(12))).toBe(false);
    expect(isArmed(null, at(12))).toBe(false);
  });

  test('the two differ ONLY on enabled, which is why the selector may use the window alone', () => {
    // The selector's SQL already filters `enabled: true`, so re-testing it in
    // JS would be a second copy of a condition the database just applied.
    const z = windowed('09:00', '17:00', { enabled: false });
    expect(withinArmWindow(z, at(12))).toBe(true);
    expect(isArmed(z, at(12))).toBe(false);
  });
});
