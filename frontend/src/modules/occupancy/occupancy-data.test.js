/**
 * Tests for the gate status derivation — whether a gate's 0 / 0 means "nobody
 * walked through" or "nothing is watching".
 *
 * Runs on Node's built-in test runner (`npm test`). The fixtures are shaped
 * exactly like GET /ai/footfall/cameras rows (see the AI service's
 * api/routes/footfall.py), including the detail that `session` is always
 * present and it is `last_update_age_sec` that goes null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GATE_STALE_SEC, buildLineZones, gateStatus } from './occupancy-data.js';

/** One row of GET /ai/footfall/cameras. */
const cam = ({ session, today, ...over } = {}) => ({
  camera_id: 'ff-uuid-1',
  camera_code: 'MON7',
  camera_name: 'Front entrance',
  camera_status: 'online',
  footfall_enabled: true,
  line: { a: [0.1, 0.6], b: [0.9, 0.6] },
  direction: 'right_is_in',
  ...over,
  today: { in: 0, out: 0, falls: 0, ...today },
  // What the AI service sends for a camera the pipeline has never fed: the
  // block is there, the age is null.
  session: {
    in: 0, out: 0, falls: 0, active_tracks: 0, last_update_age_sec: null, ...session,
  },
});

test('a counter that has never been fed is not counting, and says why', () => {
  const s = gateStatus(cam());
  assert.equal(s.state, 'off');
  assert.equal(s.counting, false);
  assert.equal(s.label, 'Not counting');
  assert.equal(s.detail, 'AI is off for this camera');
  assert.equal(s.ageSec, null);
});

test('a missing session block reads the same way as a null age', () => {
  // Nothing sends this today, but a gate must never be called "counting"
  // because a field it depends on was absent.
  assert.equal(gateStatus({ camera_id: 'x' }).state, 'off');
  assert.equal(gateStatus({ camera_id: 'x', session: undefined }).state, 'off');
  assert.equal(gateStatus(null).state, 'off');
  assert.equal(gateStatus(undefined).state, 'off');
});

test('a fed counter is counting, and age 0 is not mistaken for no age', () => {
  // Number(null) is 0, so a null age and a just-updated one are one keystroke
  // apart. They mean opposite things.
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: 0 } })).state, 'counting');
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: 0 } })).counting, true);
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: 1.4 } })).state, 'counting');
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: 59.9 } })).state, 'counting');
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: 12 } })).detail, '');
});

test('the stale boundary is exactly GATE_STALE_SEC, inclusive', () => {
  assert.equal(GATE_STALE_SEC, 60);
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: GATE_STALE_SEC } })).state, 'counting');
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: GATE_STALE_SEC + 0.1 } })).state, 'stale');
});

test('a stale counter says how long it has been, in a readable unit', () => {
  const soon = gateStatus(cam({ session: { last_update_age_sec: 75 } }));
  assert.equal(soon.state, 'stale');
  assert.equal(soon.counting, false);
  assert.equal(soon.label, 'No recent picture');
  assert.match(soon.detail, /75s/);
  assert.equal(soon.ageSec, 75);
  assert.match(gateStatus(cam({ session: { last_update_age_sec: 240 } })).detail, /4 min/);
});

test('a non-numeric age is treated as no age, never as fresh', () => {
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: 'soon' } })).state, 'off');
  assert.equal(gateStatus(cam({ session: { last_update_age_sec: NaN } })).state, 'off');
});

test('buildLineZones carries the status onto every gate row', () => {
  const zones = buildLineZones({
    cameras: [
      cam({ camera_id: 'a', camera_code: 'A', today: { in: 40, out: 38 }, session: { last_update_age_sec: 3 } }),
      cam({ camera_id: 'b', camera_code: 'B', today: { in: 12, out: 9 } }),
      cam({ camera_id: 'c', camera_code: 'C', today: { in: 1, out: 0 }, session: { last_update_age_sec: 600 } }),
    ],
  }, {
    A: { name: 'Front door', groupName: 'Main block' },
  });
  const by = Object.fromEntries(zones.map((z) => [z.monitorId, z]));
  assert.equal(by.A.status.state, 'counting');
  assert.equal(by.B.status.state, 'off');
  assert.equal(by.C.status.state, 'stale');
  // The numbers themselves are untouched: the All-gates total and the
  // dashboard tiles still add up today's real history.
  assert.equal(by.B.in, 12);
  assert.equal(by.B.out, 9);
  assert.equal(by.B.inside, 3);
  assert.equal(by.A.label, 'Front door');
});

test('a gate that is switched off is still not listed at all', () => {
  // Unchanged behaviour, pinned because the status work is next to it: the
  // matrix is gates, and a camera with footfall off is not a gate.
  const zones = buildLineZones({ cameras: [cam({ footfall_enabled: false })] });
  assert.equal(zones.length, 0);
});
