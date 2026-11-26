/**
 * Tests for what a partial zone save tells the operator.
 *
 * Runs on Node's built-in test runner (`npm test`). These are sentences, not
 * maths, and they are tested for one reason: a save that reached the browser
 * but not the camera is the failure most likely to go unnoticed, because the
 * zone IS saved and the page says so. What the rest of the sentence names is
 * the only thing standing between an operator and a zone that reads 0 for
 * ever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { andList, cameraFailures, partialNote } from './room-messages.js';

const NAMES = { m1: 'Lobby cam', m9: 'Server room cam', m8: 'Dock cam' };
const nameOf = (m) => NAMES[m] || m;

test('a camera whose row never loaded is NAMED in the save message', () => {
  const failures = cameraFailures({ unknown: ['m9'], touched: ['m1', 'm9'], cameraName: nameOf });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Server room cam/);
  assert.match(failures[0], /head counting was not switched on/);
  // Singular: one camera is "it".
  assert.match(failures[0], /record for it yet/);

  // And it reads as one sentence in the message the panel shows.
  const note = partialNote('Saved on this browser, but', failures);
  assert.equal(
    note,
    'Saved on this browser, but head counting was not switched on for Server room cam'
    + ' — this browser has no camera record for it yet, so the save never reached the detector.'
    + ' Save again once the camera list has loaded.',
  );
});

test('several unnamed-to-the-browser cameras are listed, not counted', () => {
  const failures = cameraFailures({ unknown: ['m9', 'm8'], touched: ['m1', 'm9', 'm8'], cameraName: nameOf });
  assert.match(failures[0], /for Server room cam and Dock cam/);
  assert.match(failures[0], /record for them yet/);
});

test('with no resolver the monitor id is still said, rather than skipped', () => {
  // The callers that can name a camera pass a resolver; one that cannot is
  // better off printing an id the operator can search for than a bare count.
  const failures = cameraFailures({ unknown: ['m9'], touched: ['m9'] });
  assert.match(failures[0], /for m9 /);
});

test('a camera that was asked and refused keeps the count it always had', () => {
  // Unchanged wording: these cameras are known and listed on the page, so the
  // shape of the message is the useful one it already was.
  assert.deepEqual(
    cameraFailures({ failed: ['m1'], touched: ['m1'], cameraName: nameOf }),
    ['the boundary and capacity could not be pushed to the camera'],
  );
  assert.deepEqual(
    cameraFailures({ failed: ['m1'], touched: ['m1', 'm9'], cameraName: nameOf }),
    ['1 of 2 cameras could not be updated'],
  );
});

test('both failures at once are two clauses, the named one first', () => {
  const failures = cameraFailures({
    unknown: ['m9'], failed: ['m1'], touched: ['m1', 'm9'], cameraName: nameOf,
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /Server room cam/);
  assert.equal(failures[1], '1 of 2 cameras could not be updated');
  assert.match(partialNote('Saved on this browser, but', failures), /; and 1 of 2 cameras/);
});

test('a save that landed everywhere says nothing', () => {
  assert.deepEqual(cameraFailures({}), []);
  assert.deepEqual(cameraFailures({ unknown: [], failed: [], touched: ['m1'] }), []);
  assert.equal(partialNote('Saved on this browser, but', []), null);
  assert.equal(partialNote('Saved on this browser, but'), null);
  // A falsy entry is not a failure, so it cannot produce a dangling clause.
  assert.equal(partialNote('Deleted here, but', [null, undefined, '']), null);
});

test('the delete message is composed the same way', () => {
  assert.equal(
    partialNote('Deleted here, but', ['the access rule could not be removed from the server']),
    'Deleted here, but the access rule could not be removed from the server.',
  );
});

test('andList is a list inside a sentence', () => {
  assert.equal(andList([]), '');
  assert.equal(andList(['A']), 'A');
  assert.equal(andList(['A', 'B']), 'A and B');
  assert.equal(andList(['A', 'B', 'C']), 'A, B and C');
});

// ── the camera whose AI is off ─────────────────────────────────────────────
//
// This is the third cause, split out of `failed` because it was being reported
// as "1 of 3 cameras could not be updated" -- a sentence that names no cause
// and suggests no action, for the one refusal the operator can actually fix.
// The write IS sent and IS refused (409 AI_CONSENT_REQUIRED, because nothing
// counts a camera whose master AI switch is off), so it is not `unknown`
// either: it is its own event with its own answer.

test('a camera that refused for want of AI is named, with where to switch it on', () => {
  const failures = cameraFailures({
    needsAi: ['m9'], touched: ['m1', 'm9'], cameraName: nameOf,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Server room cam/);
  // The cause, said as a cause rather than as a count.
  assert.match(failures[0], /its AI is switched off/);
  // And the place to go. A sentence that names the problem and not the remedy
  // leaves the operator exactly as stuck as the generic count did.
  assert.match(failures[0], /Camera Setup → AI Detection/);
  assert.match(failures[0], /save this zone again/);
  // It must NOT come out as a tally of cameras.
  assert.doesNotMatch(failures[0], /\d of \d cameras/);
});

test('several are listed and read as plural', () => {
  const failures = cameraFailures({
    needsAi: ['m9', 'm8'], touched: ['m1', 'm9', 'm8'], cameraName: nameOf,
  });
  assert.match(failures[0], /for Server room cam and Dock cam/);
  assert.match(failures[0], /their AI is switched off/);
  assert.match(failures[0], /Switch them on/);
});

test('it is said FIRST, because it is the only one with an action in it', () => {
  // Ordering is not cosmetic: the operator reads the first clause, and this is
  // the clause they can finish. The other two are "save again later" and "we
  // do not know why".
  const failures = cameraFailures({
    unknown: ['m8'], failed: ['m1'], needsAi: ['m9'], touched: ['m1', 'm8', 'm9'], cameraName: nameOf,
  });
  assert.equal(failures.length, 3);
  assert.match(failures[0], /Server room cam/);
  assert.match(failures[0], /AI is switched off/);
  assert.match(failures[1], /Dock cam/);
  assert.match(failures[1], /no camera record/);
  assert.equal(failures[2], '1 of 3 cameras could not be updated');
});

test('a mixed save: one camera needs AI, another is simply unreachable', () => {
  // The case the three-way split exists for. Both were refused writes; one has
  // a cause and a remedy, the other does not. Reported as ONE bucket, the
  // remedy was lost -- and the count implied both were the same problem.
  const failures = cameraFailures({
    needsAi: ['m9'], failed: ['m1'], touched: ['m1', 'm9'], cameraName: nameOf,
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /Server room cam — its AI is switched off/);
  // The unreachable one keeps the generic shape, and does NOT inherit the AI
  // explanation: saying "switch its AI on" about a camera with a dead backend
  // would send the operator to a switch that was already on.
  assert.equal(failures[1], '1 of 2 cameras could not be updated');
  assert.doesNotMatch(failures[1], /AI/);

  const note = partialNote('Saved on this browser, but', failures);
  assert.match(note, /^Saved on this browser, but head counting was not switched on for Server room cam/);
  assert.match(note, /; and 1 of 2 cameras could not be updated\.$/);
});

test('the generic count still counts only the cameras it is about', () => {
  // `touched` is every camera the save wrote to, so the denominator is right;
  // the numerator must not quietly include the AI refusals now that they are
  // reported on their own. Two clauses each claiming the same camera would
  // double-count a three-camera zone into four problems.
  const failures = cameraFailures({
    needsAi: ['m9', 'm8'], failed: ['m1'], touched: ['m1', 'm8', 'm9'], cameraName: nameOf,
  });
  assert.equal(failures[1], '1 of 3 cameras could not be updated');
});

test('every camera refused for want of AI is not "the camera could not be pushed"', () => {
  // When `failed` is empty the old wording for an all-cameras failure must not
  // appear -- nothing was unexplained, so there is nothing to say generically.
  const failures = cameraFailures({
    needsAi: ['m1'], touched: ['m1'], cameraName: nameOf,
  });
  assert.equal(failures.length, 1);
  assert.doesNotMatch(failures[0], /could not be pushed to the camera/);
});

test('with no resolver an AI refusal still says which monitor it was', () => {
  assert.match(cameraFailures({ needsAi: ['m9'], touched: ['m9'] })[0], /for m9 /);
});

test('no AI refusals says nothing about AI', () => {
  assert.deepEqual(cameraFailures({ needsAi: [], failed: [], unknown: [], touched: ['m1'] }), []);
  // And the two older buckets are untouched by the new one existing.
  assert.deepEqual(
    cameraFailures({ failed: ['m1'], touched: ['m1'], cameraName: nameOf }),
    ['the boundary and capacity could not be pushed to the camera'],
  );
});
