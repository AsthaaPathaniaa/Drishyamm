/**
 * Tests for keeping a gate editor in step with the saved gate.
 *
 * Runs on Node's built-in test runner (`npm test`). The bug being pinned: a
 * saved gate did not reappear when reopened. The gate was on disk and the
 * service returned it; the editor had copied `gate` into state once, on
 * mount, and gates arrive after the camera list the editor mounts with.
 *
 * What is checked: a gate arriving after mount is adopted, an operator's
 * unsaved line is never overwritten by it, the 5-second poll returning the
 * same gate changes nothing, and a line that only LOOKS the same is still
 * treated as a change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHANGED_ELSEWHERE, storedGate, storedKey, syncAction } from './gate-sync.js';

const DEFAULTS = { line: { a: [0.1, 0.6], b: [0.9, 0.6] }, direction: 'right_is_in' };
const SAVED_LINE = { a: [0.2, 0.42], b: [0.77, 0.51] };

/** A gate row as gate-model.js's gateFromCamera builds it. */
const gate = (over = {}) => ({
  monitorId: 'MON7',
  cameraId: 'ff-uuid-1',
  name: 'Front entrance',
  enabled: true,
  line: SAVED_LINE,
  direction: 'left_is_in',
  in: 40,
  out: 38,
  net: 2,
  ...over,
});

const keyOf = (g) => storedKey(storedGate(g, DEFAULTS));

test('a camera with no gate yet reads as off, on the default line', () => {
  // This is the state the editor used to freeze into: the footfall call had
  // not answered, so every camera looked like a camera with no gate.
  assert.deepEqual(storedGate(undefined, DEFAULTS), {
    enabled: false, line: DEFAULTS.line, direction: DEFAULTS.direction,
  });
  assert.deepEqual(storedGate(null, DEFAULTS), storedGate(undefined, DEFAULTS));
  // A gate the service knows but is not counting keeps its saved line.
  assert.deepEqual(storedGate(gate({ enabled: false }), DEFAULTS), {
    enabled: false, line: SAVED_LINE, direction: 'left_is_in',
  });
});

test('a gate that arrives after mount is adopted', () => {
  // The whole bug, in one assertion: mount with nothing, then the saved gate
  // lands. Untouched, so the editor takes it.
  const atMount = keyOf(undefined);
  const arrived = keyOf(gate());
  assert.notEqual(arrived, atMount);
  assert.equal(syncAction({ key: arrived, seen: atMount, touched: false }), 'adopt');
});

test('unsaved edits are not overwritten', () => {
  const atMount = keyOf(undefined);
  const arrived = keyOf(gate());
  assert.equal(syncAction({ key: arrived, seen: atMount, touched: true }), 'conflict');
  // ...and the operator is told, rather than silently kept out of step.
  assert.match(CHANGED_ELSEWHERE, /changed elsewhere/);
});

test('the same gate coming back from the poll changes nothing', () => {
  // The footfall poll builds a fresh object every 5 seconds. Comparing by
  // object identity would re-seed the draft on each one and fight the
  // operator for the cursor.
  const first = keyOf(gate());
  const second = keyOf(gate());
  assert.equal(first, second);
  assert.equal(syncAction({ key: second, seen: first, touched: false }), 'none');
  assert.equal(syncAction({ key: second, seen: first, touched: true }), 'none');
});

test('a save in gate mode is a change the Entry line tool picks up', () => {
  // Both editors share this hook. Gate mode saves a moved line, onSaved
  // refreshes the gates, and the other editor for the same camera sees a
  // different fingerprint.
  const before = keyOf(gate({ line: { a: [0.2, 0.42], b: [0.77, 0.51] } }));
  const after = keyOf(gate({ line: { a: [0.2, 0.60], b: [0.77, 0.60] } }));
  assert.notEqual(after, before);
  assert.equal(syncAction({ key: after, seen: before, touched: false }), 'adopt');
});

test('every field the editor owns counts as a change on its own', () => {
  const base = keyOf(gate());
  assert.notEqual(keyOf(gate({ enabled: false })), base);
  assert.notEqual(keyOf(gate({ direction: 'right_is_in' })), base);
  assert.notEqual(keyOf(gate({ line: { a: [0.2, 0.42], b: [0.77, 0.52] } })), base);
  // Counts and names are not the editor's business and must not re-seed it
  // mid-drag: today's IN/OUT move every few seconds.
  assert.equal(keyOf(gate({ in: 999, out: 998, net: 1, name: 'Renamed' })), base);
});

test('a stopped gate and a gate with no line are told apart', () => {
  // Both read "not counting", but one has a line worth keeping on screen.
  assert.notEqual(keyOf(gate({ enabled: false })), keyOf(undefined));
});

test('a malformed line does not throw on the way to a fingerprint', () => {
  // The fingerprint runs on every render; it must survive a gate row that
  // has lost its line rather than take the page down with it.
  assert.equal(typeof storedKey({ enabled: true, direction: 'right_is_in', line: null }), 'string');
  assert.equal(typeof storedKey({ enabled: true, direction: 'right_is_in', line: {} }), 'string');
  assert.equal(typeof storedKey(storedGate({ enabled: true }, DEFAULTS)), 'string');
});
