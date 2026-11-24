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
