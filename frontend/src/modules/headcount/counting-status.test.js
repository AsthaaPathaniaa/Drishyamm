/**
 * The two silent drops on the Head Count wall.
 *
 * Each test is one claim the page makes to an operator. The point of the
 * module is that a camera is never in a state the page cannot account for, so
 * most of these pin a SENTENCE: the wording is the fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_OFF, OFFLINE, WAITING,
  aiOn, wanted, notCountingReason, notCounting, notCountingSummary,
  andList, fixable, zonesPending,
} from './counting-status.js';

// A camera the way GET /ai/cameras serialises one. `ai.enabled` + mode are the
// master switch; `headcount.enabled` is this page's own tick.
const cam = (over = {}) => ({
  id: `c-${over.monitorId || '1'}`,
  monitorId: over.monitorId || '1',
  name: over.name || 'Camera 1',
  status: 'online',
  ai: { enabled: true, mode: 'continuous' },
  headcount: { enabled: true, threshold: 0, zones: [] },
  ...over,
});

const SHAPE = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]];

// ── the master switch, read exactly as the backend reads it ─────────────────

test('aiOn mirrors the backend: enabled must be true and the mode not off', () => {
  assert.equal(aiOn({ ai: { enabled: true, mode: 'continuous' } }), true);
  assert.equal(aiOn({ ai: { enabled: true, mode: 'off' } }), false);
  assert.equal(aiOn({ ai: { enabled: false, mode: 'continuous' } }), false);
  // Absent means OFF for the master, unlike the feature flags under it.
  assert.equal(aiOn({ ai: {} }), false);
  assert.equal(aiOn({}), false);
  assert.equal(aiOn(null), false);
});

test('wanted is this page\'s own tick, and nothing else', () => {
  assert.equal(wanted(cam()), true);
  assert.equal(wanted(cam({ headcount: { enabled: false } })), false);
  assert.equal(wanted(cam({ headcount: {} })), false);
});

// ── the gap, and only the gap ───────────────────────────────────────────────

test('a camera nobody asked to count has nothing to report', () => {
  assert.equal(notCountingReason(cam({ headcount: { enabled: false } }), false), null);
});

test('a camera that IS counting has nothing to report', () => {
  assert.equal(notCountingReason(cam(), true), null);
});

test('ticked here, AI off there: the reason is named and it is fixable', () => {
  const r = notCountingReason(cam({ ai: { enabled: false, mode: 'off' } }), false);
  assert.equal(r.code, AI_OFF);
  assert.equal(r.fixable, true);
  assert.match(r.line, /AI is switched off/);
  // The action is offered, because this is the one an operator can take here.
  assert.equal(r.fix, 'Turn AI on');
});

test('a camera whose AI mode was set to off is the same case as enabled:false', () => {
  const r = notCountingReason(cam({ ai: { enabled: true, mode: 'off' } }), false);
  assert.equal(r.code, AI_OFF);
});

test('an unreachable camera is the VMS\'s problem, and is not offered a fix', () => {
  const r = notCountingReason(cam({ status: 'Offline' }), false);
  assert.equal(r.code, OFFLINE);
  assert.equal(r.fixable, false);
  assert.equal(r.fix, '');
});

test('nothing visibly wrong is "not yet", not an error', () => {
  const r = notCountingReason(cam(), false);
  assert.equal(r.code, WAITING);
  assert.equal(r.fixable, false);
  // It must not claim the service is full or broken: from here the two are
  // indistinguishable.
  assert.doesNotMatch(r.line, /full|cap|error|fail/i);
});

test('AI off outranks offline — turning AI on is the thing to do either way', () => {
  const r = notCountingReason(
    cam({ status: 'offline', ai: { enabled: false, mode: 'off' } }), false,
  );
  assert.equal(r.code, AI_OFF);
});

// ── the list the page draws ─────────────────────────────────────────────────

test('notCounting returns only the selected cameras the detector is not serving', () => {
  const list = [
    cam({ monitorId: '1', name: 'Lobby' }),                                   // counting
    cam({ monitorId: '2', name: 'Server room', ai: { enabled: false } }),      // AI off
    cam({ monitorId: '3', name: 'Store', headcount: { enabled: false } }),     // not asked
    cam({ monitorId: '4', name: 'Dock' }),                                     // waiting
  ];
  const got = notCounting(list, new Set(['1']));
  assert.deepEqual(got.map(({ cam: c }) => c.name), ['Server room', 'Dock']);
  assert.deepEqual(got.map(({ reason }) => reason.code), [AI_OFF, WAITING]);
});

test('notCounting is empty when every selected camera is counted', () => {
  const list = [cam({ monitorId: '1' }), cam({ monitorId: '2' })];
  assert.deepEqual(notCounting(list, new Set(['1', '2'])), []);
});

test('notCounting survives a registry that has not loaded, and a plain array', () => {
  assert.deepEqual(notCounting(), []);
  assert.deepEqual(notCounting([cam()], undefined), [
    { cam: notCounting([cam()], undefined)[0].cam, reason: notCounting([cam()], undefined)[0].reason },
  ]);
  // A Set is what the page passes; anything without .has must not throw.
  assert.equal(notCounting([cam()], {}).length, 1);
});

// ── the sentence ────────────────────────────────────────────────────────────

test('nothing wrong says nothing at all', () => {
  assert.equal(notCountingSummary([]), null);
});

test('one camera is named, not tallied', () => {
  const items = notCounting(
    [cam({ monitorId: '2', name: 'Server room', ai: { enabled: false } })], new Set(),
  );
  const s = notCountingSummary(items);
  assert.match(s, /Server room is not counting because its AI is switched off/);
  assert.doesNotMatch(s, /\b1 camera\b/);
});

test('reasons are grouped, because they take different actions', () => {
  const items = notCounting([
    cam({ monitorId: '2', name: 'Server room', ai: { enabled: false } }),
    cam({ monitorId: '3', name: 'Vault', ai: { enabled: false } }),
    cam({ monitorId: '4', name: 'Dock' }),
  ], new Set());
  const s = notCountingSummary(items);
  assert.match(s, /Server room and Vault are not counting because its AI is switched off/);
  assert.match(s, /Dock is not counting because the detector has not started it yet/);
  assert.equal(s.split(';').length, 2);
});

test('past four cameras it becomes a tally — a sentence listing nine is not read', () => {
  const many = Array.from({ length: 5 }, (_, i) => cam({
    monitorId: String(i + 10), name: `Camera ${i + 10}`, ai: { enabled: false },
  }));
  const s = notCountingSummary(notCounting(many, new Set()));
  assert.match(s, /^5 cameras are not counting/);
  assert.doesNotMatch(s, /Camera 10/);
});

test('exactly four is still named — the boundary is inclusive', () => {
  const four = Array.from({ length: 4 }, (_, i) => cam({
    monitorId: String(i + 10), name: `Camera ${i + 10}`, ai: { enabled: false },
  }));
  const s = notCountingSummary(notCounting(four, new Set()));
  assert.match(s, /Camera 10, Camera 11, Camera 12 and Camera 13/);
});

test('a camera with no name is named by its monitor id rather than left blank', () => {
  const items = notCounting([cam({ monitorId: 'cam-9', name: '', ai: { enabled: false } })], new Set());
  assert.match(notCountingSummary(items), /cam-9 is not counting/);
});

test('andList reads as a person would write it', () => {
  assert.equal(andList([]), '');
  assert.equal(andList(['A']), 'A');
  assert.equal(andList(['A', 'B']), 'A and B');
  assert.equal(andList(['A', 'B', 'C']), 'A, B and C');
});

test('only the AI-switch cameras are offered the inline fix', () => {
  const items = notCounting([
    cam({ monitorId: '2', name: 'Server room', ai: { enabled: false } }),
    cam({ monitorId: '3', name: 'Dock' }),
    cam({ monitorId: '4', name: 'Gate', status: 'offline' }),
  ], new Set());
  assert.deepEqual(fixable(items).map((c) => c.name), ['Server room']);
});

// ── the zone drop, one level down ───────────────────────────────────────────

test('a camera with no zone drawn is not pending anything', () => {
  assert.equal(zonesPending({ zones: [], zone_counts: {} }), false);
  assert.equal(zonesPending({}), false);
});

test('a zone drawn but absent from the detector\'s breakdown is PENDING', () => {
  // The detector seeds every area at 0, so an empty breakdown is not "empty
  // room" -- it is "this camera has no areas".
  assert.equal(zonesPending({
    zones: [{ id: 'z1', name: 'Room', points: SHAPE }],
    zone_counts: {},
  }), true);
});

test('a zone the detector reports at 0 is COUNTING, not pending — 0 is an answer', () => {
  assert.equal(zonesPending({
    zones: [{ id: 'z1', name: 'Room', points: SHAPE }],
    zone_counts: { Room: 0 },
  }), false);
});

test('a disabled zone does not make the camera look pending for ever', () => {
  assert.equal(zonesPending({
    zones: [{ id: 'z1', name: 'Room', points: SHAPE, enabled: false }],
    zone_counts: {},
  }), false);
});

test('a missing breakdown is the same as an empty one', () => {
  assert.equal(zonesPending({ zones: [{ id: 'z1', name: 'Room', points: SHAPE }] }), true);
});
