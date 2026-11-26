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
  wanted, notCountingReason, notCounting, notCountingSummary,
  andList, fixable, zonesPending,
  consentCopy, saveFailureSummary,
  AT_CAPACITY, atCapacity, detectorCapacity, capacityCopy,
  OUTSIDE_HOURS, faults, paused,
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

// ── the page's own tick ─────────────────────────────────────────────────────
//
// The master switch itself is read by core/services/aiConsent.js and pinned
// there; this is the only switch the page owns.

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

// ── what the consent question SAYS ─────────────────────────────────────────
//
// That it is asked at all is the shared rule, pinned in
// core/services/aiConsent.test.js. These pin head count's WORDING of it, which
// is this module's own: an operator deciding needs to be told what is off,
// what will start, and what will not.

test('the question names what is off, what starts, and what does NOT', () => {
  const copy = consentCopy(cam({ name: 'Server room', ai: { enabled: false } }));
  assert.match(copy.title, /Switch AI on for this camera\?/);
  assert.match(copy.body, /Server room/);
  assert.match(copy.body, /AI switched off/);
  // The obvious worry about "turn AI on" is face recognition. Answer it.
  assert.match(copy.body, /faces are not matched/);
  assert.match(copy.body, /no other AI feature is started/);
  // And that it is reversible, which is what makes yes an easy answer.
  assert.match(copy.body, /switch it off again/i);
});

test('several cameras are ONE question, not a queue of identical dialogs', () => {
  const copy = consentCopy([
    cam({ monitorId: '2', name: 'Dock' }),
    cam({ monitorId: '3', name: 'Vault' }),
  ]);
  assert.match(copy.title, /2 cameras/);
  assert.match(copy.body, /Dock and Vault/);
  assert.match(copy.body, /they cannot/);
  assert.equal(copy.cameras.length, 2);
});

test('past four cameras the question counts them instead of listing them', () => {
  const many = Array.from({ length: 5 }, (_, i) => cam({ monitorId: String(i), name: `C${i}` }));
  const copy = consentCopy(many);
  assert.match(copy.body, /^5 cameras have AI switched off/);
  assert.doesNotMatch(copy.body, /C0/);
});

test('the confirm button says what pressing it does, not "OK"', () => {
  assert.equal(consentCopy(cam()).confirmLabel, 'Switch AI on and count');
  assert.match(consentCopy([cam(), cam({ monitorId: '2' })]).confirmLabel, /^Switch AI on for 2 and count$/);
});

test('consentCopy survives being handed nothing', () => {
  const copy = consentCopy(null);
  assert.match(copy.body, /this camera/);
  assert.deepEqual(copy.cameras, []);
});

// ── a save that does not land ──────────────────────────────────────────────
//
// A tick that springs back with no message is this module's own complaint,
// committed by the page written to fix it. The licence running out is the
// common case and is not guessable from a bouncing tick.

test('nothing failed says nothing at all', () => {
  assert.equal(saveFailureSummary([]), null);
  assert.equal(saveFailureSummary(), null);
  assert.equal(saveFailureSummary([null, undefined]), null);
});

test('one failure names the camera and the reason', () => {
  const note = saveFailureSummary([
    { cam: cam({ name: 'Dock' }), message: 'Your head-count licence covers 10 cameras.' },
  ]);
  assert.match(note, /^Not saved — Dock: Your head-count licence covers 10 cameras\.$/);
});

test('many cameras refused for ONE reason is one fact, not twenty copies', () => {
  // The licence runs out part way through a bulk turn-on. Twenty copies of the
  // same sentence would hide a second reason underneath it.
  const failures = ['Dock', 'Vault', 'Gate'].map((name) => ({
    cam: cam({ name }), message: 'Licence exhausted.',
  }));
  const note = saveFailureSummary(failures);
  assert.match(note, /Dock, Vault and Gate: Licence exhausted/);
  assert.equal(note.split(';').length, 1);
});

test('two different reasons are two clauses, so neither hides the other', () => {
  const note = saveFailureSummary([
    { cam: cam({ name: 'Dock' }), message: 'Licence exhausted.' },
    { cam: cam({ name: 'Gate' }), message: 'Camera not found' },
  ]);
  assert.equal(note.split(';').length, 2);
  assert.match(note, /Dock: Licence exhausted/);
  assert.match(note, /Gate: Camera not found/);
});

test('past four cameras on one reason it counts them', () => {
  const failures = Array.from({ length: 6 }, (_, i) => ({
    cam: cam({ name: `C${i}` }), message: 'Licence exhausted.',
  }));
  assert.match(saveFailureSummary(failures), /6 cameras: Licence exhausted/);
});

test('a camera with no name is still accounted for', () => {
  const note = saveFailureSummary([{ cam: { monitorId: 'cam-9' }, message: 'nope' }]);
  assert.match(note, /cam-9: nope/);
  assert.match(saveFailureSummary([{ cam: null, message: 'nope' }]), /a camera: nope/);
});

// ── the detector is full ───────────────────────────────────────────────────
//
// The service opens a fixed number of streams and SKIPS the rest with a log
// line nobody reads. From the page's side that was indistinguishable from
// "not started yet", so a camera ticked ten minutes ago reported "the detector
// has not started it yet" — true, and useless. /health now reports the cap.

const DET = { max: 8, perHost: 4, counting: 8 };

test('atCapacity needs a known cap — absent means unknown, not unlimited', () => {
  assert.equal(atCapacity({ max: 8, counting: 8 }), true);
  assert.equal(atCapacity({ max: 8, counting: 9 }), true);
  assert.equal(atCapacity({ max: 8, counting: 7 }), false);
  // An older detector sends no caps. Reporting "no limit" would be worse than
  // reporting nothing.
  assert.equal(atCapacity({ counting: 99 }), false);
  assert.equal(atCapacity({}), false);
  assert.equal(atCapacity(), false);
});

test('detectorCapacity reads the health payload the page already polls', () => {
  assert.deepEqual(
    detectorCapacity({ max_streams: 8, max_streams_per_host: 4 }, 5),
    { max: 8, perHost: 4, counting: 5 },
  );
  assert.deepEqual(detectorCapacity(null, 0), { max: 0, perHost: 0, counting: 0 });
});

test('a ticked camera the FULL detector cannot open says exactly that', () => {
  const r = notCountingReason(cam({ monitorId: '9' }), false, DET);
  assert.equal(r.code, AT_CAPACITY);
  assert.match(r.line, /already counting 8 cameras/);
  // Not fixable from this page: the limit is a server setting.
  assert.equal(r.fixable, false);
});

test('with room to spare the same camera is just early, not blocked', () => {
  const r = notCountingReason(cam({ monitorId: '9' }), false, { max: 8, counting: 3 });
  assert.equal(r.code, WAITING);
});

test('AI off still outranks a full detector — it is the blocking problem', () => {
  const r = notCountingReason(cam({ ai: { enabled: false } }), false, DET);
  assert.equal(r.code, AI_OFF);
});

test('a camera the detector IS counting reports nothing, full or not', () => {
  assert.equal(notCountingReason(cam(), true, DET), null);
});

test('the full-detector note names the limit, the count, and who to ask', () => {
  const copy = capacityCopy(cam({ name: 'Dock 9' }), DET);
  assert.match(copy.title, /already full/);
  assert.match(copy.body, /counts up to 8 cameras/);
  assert.match(copy.body, /is counting 8/);
  assert.match(copy.body, /Dock 9/);
  // It must say the tick is NOT lost — that is why warning beats refusing.
  assert.match(copy.body, /until one of the others is turned off/);
  // The per-recorder cap is protective, so it is explained, not offered.
  assert.match(copy.body, /single recorder is limited to 4/);
  assert.doesNotMatch(copy.body, /raise it here|increase the limit here/i);
  assert.match(copy.body, /ask whoever runs this deployment/);
});

test('the button says the tick still happens', () => {
  assert.equal(capacityCopy(cam(), DET).confirmLabel, 'Tick it anyway');
});

test('notCounting threads the cap through to every row', () => {
  const list = [cam({ monitorId: '1' }), cam({ monitorId: '9' })];
  const got = notCounting(list, new Set(['1']), DET);
  assert.deepEqual(got.map(({ reason }) => reason.code), [AT_CAPACITY]);
});

test('and with no cap known it still reports the rows, just not the reason', () => {
  const got = notCounting([cam({ monitorId: '9' })], new Set(), {});
  assert.deepEqual(got.map(({ reason }) => reason.code), [WAITING]);
});

// ── the promise, said ──────────────────────────────────────────────────────
//
// The other end of contracts/headcount-camera-row.json `countingOnlyPromise`.
// The backend test asserts masterOnForFeature HONOURS it; this asserts the
// dialog SAYS it. The worst defect in this feature was these two drifting
// apart: the dialog promised faces were not matched while a button two inches
// away started face recognition.
import { readFileSync } from 'node:fs';

const PROMISE = JSON.parse(readFileSync(
  new URL('../../../../contracts/headcount-camera-row.json', import.meta.url), 'utf8',
)).countingOnlyPromise;

test('the dialog says, in the contract\'s own words, what will not happen', () => {
  assert.ok(PROMISE?.saidToTheOperator, 'the contract states no promise to check');
  assert.ok(
    consentCopy(cam()).body.includes(PROMISE.saidToTheOperator),
    `the consent dialog no longer says "${PROMISE.saidToTheOperator}", which the `
    + 'backend is still being held to by headcountTurnsAiOn.test.js',
  );
});

test('the bulk wording keeps the promise too — it is the same switch', () => {
  const many = consentCopy([cam(), cam({ monitorId: '2' })]).body;
  assert.ok(many.includes(PROMISE.saidToTheOperator));
});

// ── counting hours: the one reason that is not a fault ──────────────────────
//
// A camera outside its own counting hours is not broken -- it is the system
// obeying the operator. It still has to be ACCOUNTED FOR, because the wall is
// built from the detector's streams so a paused camera has no tile, and "8
// cameras selected" over six tiles is the gap this whole module closes. What
// these tests pin is that it is accounted for in the right REGISTER: a quiet
// confirmation, never the amber strip, because a warning that fires every
// night at ten o'clock teaches an operator to stop reading warnings.

/** A ticked camera the server says is outside its hours. */
const paused_cam = (from, to, over = {}) => cam({
  headcount: {
    enabled: true, threshold: 0, zones: [],
    countWindow: { from, to }, schedule: 'window', countingNow: false,
  },
  ...over,
});

test('outside its hours, the reason names the hours it does count', () => {
  const r = notCountingReason(paused_cam('09:00', '18:00'), false);
  assert.equal(r.code, OUTSIDE_HOURS);
  assert.match(r.line, /09:00/);
  assert.match(r.line, /18:00/);
  // Nothing to press: the fix is to change the hours, and those live on the
  // camera's own card, not on a page-wide strip.
  assert.equal(r.fixable, false);
  assert.equal(r.fix, '');
});

test('it is marked normal, which is what keeps it out of the amber strip', () => {
  assert.equal(notCountingReason(paused_cam('09:00', '18:00'), false).normal, true);
  // And every other reason is NOT, or they would all go quiet together.
  assert.ok(!notCountingReason(cam({ ai: { enabled: false, mode: 'off' } }), false).normal);
  assert.ok(!notCountingReason(cam({ status: 'offline' }), false).normal);
  assert.ok(!notCountingReason(cam(), false).normal);
});

test('it says when counting resumes, which is always the window start', () => {
  // True for a day shift read at midnight and for a night shift read at noon:
  // outside a window, the next opening is its start.
  assert.equal(notCountingReason(paused_cam('09:00', '18:00'), false).resumesAt, '09:00');
  assert.equal(notCountingReason(paused_cam('22:00', '06:00'), false).resumesAt, '22:00');
});

test('the AI switch still outranks the hours', () => {
  // AI off means this camera will not count when its window opens either, so
  // that is the bigger fact and the only one with an action attached.
  const c = paused_cam('09:00', '18:00', { ai: { enabled: false, mode: 'off' } });
  assert.equal(notCountingReason(c, false).code, AI_OFF);
});

test('the hours outrank offline, capacity and waiting', () => {
  // All three are true-but-irrelevant about a camera that is off duty on
  // purpose, and the first of them would send an operator to check a camera
  // that is working perfectly.
  const off = paused_cam('09:00', '18:00', { status: 'offline' });
  assert.equal(notCountingReason(off, false).code, OUTSIDE_HOURS);
  const full = paused_cam('09:00', '18:00');
  assert.equal(notCountingReason(full, false, { max: 8, counting: 8 }).code, OUTSIDE_HOURS);
});

test('countingNow ABSENT means unknown, not paused', () => {
  // An older backend or a cached response does not carry it. Reading absent as
  // paused would explain away a genuinely broken camera as a schedule nobody
  // set -- so the page falls through to the reasons it can stand behind.
  const noFlag = cam({
    headcount: {
      enabled: true, threshold: 0, zones: [], countWindow: { from: '09:00', to: '18:00' },
    },
  });
  assert.equal(notCountingReason(noFlag, false).code, WAITING);
});

test('countingNow true is counted, hours or no hours', () => {
  const onDuty = cam({
    headcount: {
      enabled: true, threshold: 0, zones: [],
      countWindow: { from: '09:00', to: '18:00' }, countingNow: true,
    },
  });
  // Inside its hours and running: nothing to say at all.
  assert.equal(notCountingReason(onDuty, true), null);
  // Inside its hours and not yet running: early, not paused.
  assert.equal(notCountingReason(onDuty, false).code, WAITING);
});

test('faults and paused split the list, and together they lose nobody', () => {
  // The split is the whole mechanism: one strip asks for something, the other
  // confirms. A camera in neither would be a camera with no tile and no
  // sentence, which is the original defect.
  const list = [
    cam({ monitorId: '1', name: 'Lobby', ai: { enabled: false, mode: 'off' } }),
    paused_cam('22:00', '06:00', { monitorId: '2', name: 'Night Bay' }),
    cam({ monitorId: '3', name: 'Dock' }),
  ];
  const stranded = notCounting(list, new Set());
  assert.equal(stranded.length, 3);
  assert.deepEqual(faults(stranded).map((x) => x.cam.name), ['Lobby', 'Dock']);
  assert.deepEqual(paused(stranded).map((x) => x.cam.name), ['Night Bay']);
  assert.equal(faults(stranded).length + paused(stranded).length, stranded.length);
});

test('the paused sentence reads as a confirmation, not a failure', () => {
  const list = [paused_cam('22:00', '06:00', { monitorId: '2', name: 'Night Bay' })];
  const note = notCountingSummary(paused(notCounting(list, new Set())));
  assert.match(note, /Night Bay/);
  assert.match(note, /22:00 and 06:00/);
});

test('a paused camera never reaches the fixable list', () => {
  // `fixable` drives the "Turn AI on" button. Offering it for a camera that is
  // merely off duty would switch nothing on and explain nothing.
  const stranded = notCounting([paused_cam('09:00', '18:00')], new Set());
  assert.deepEqual(fixable(stranded), []);
});
