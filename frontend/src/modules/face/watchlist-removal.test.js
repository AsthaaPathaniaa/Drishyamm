/**
 * Taking a face off the watchlist must never LOOK done when it is not.
 *
 * The defect these pin: the page swallowed the server's refusal and removed the
 * row anyway, so a failed removal was indistinguishable from a successful one.
 * The person disappeared from the screen and went on being recognised.
 *
 * The direction of failure is the whole point. Showing someone as still
 * watch-listed when they are not is a tidy-up problem. Showing them as removed
 * when the system is still matching their face is a privacy control that lies.
 * Several of these assert that asymmetry directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOVED, ALREADY_GONE, REFUSED,
  removalOutcome, mayForget, removalMessage,
} from './watchlist-removal.js';

const refusal = (status, message) => ({ response: { status, data: { message } } });

test('no error means the gallery confirmed it', () => {
  assert.equal(removalOutcome(undefined), REMOVED);
  assert.equal(removalOutcome(null), REMOVED);
});

test('a 404 is success — the gallery not having it IS what we asked for', () => {
  assert.equal(removalOutcome(refusal(404, 'not found')), ALREADY_GONE);
});

test('every other refusal is a refusal, including no response at all', () => {
  assert.equal(removalOutcome(refusal(500, 'boom')), REFUSED);
  assert.equal(removalOutcome(refusal(403, 'not yours')), REFUSED);
  assert.equal(removalOutcome(refusal(409, 'busy')), REFUSED);
  // A network error has no `response`. Guessing optimistically here is the
  // original defect, so it must land on REFUSED.
  assert.equal(removalOutcome(new Error('Network Error')), REFUSED);
  assert.equal(removalOutcome({}), REFUSED);
});

test('the list may only forget a face the gallery has actually let go', () => {
  assert.equal(mayForget(REMOVED), true);
  assert.equal(mayForget(ALREADY_GONE), true);
  // THE defect, in one assertion.
  assert.equal(mayForget(REFUSED), false);
  assert.equal(mayForget(undefined), false);
});

test('a refusal says it did NOT happen before it says anything else', () => {
  const { kind, msg } = removalMessage('Aastha', REFUSED, refusal(500, 'AI service is down.'));
  assert.equal(kind, 'error');
  // Reading stops early, so the two load-bearing facts come first and last.
  assert.match(msg, /^"Aastha" was NOT removed/);
  assert.match(msg, /still being matched/);
  assert.match(msg, /try again/);
  // And the server's own reason is carried, between them.
  assert.match(msg, /AI service is down\./);
});

test('a refusal with no reason from the server still reads as a sentence', () => {
  const { msg } = removalMessage('Aastha', REFUSED, new Error('Network Error'));
  assert.match(msg, /^"Aastha" was NOT removed: the AI service did not respond\./);
  assert.match(msg, /still being matched/);
});

test('success says the thing the operator actually cares about', () => {
  const { kind, msg } = removalMessage('Aastha', REMOVED);
  assert.equal(kind, 'success');
  // "Deleted" describes a row. "No longer being matched" describes the world.
  assert.match(msg, /no longer being matched/);
});

test('already-gone is not an error, because nothing is wrong', () => {
  const { kind, msg } = removalMessage('Aastha', ALREADY_GONE);
  assert.equal(kind, 'success');
  assert.match(msg, /already gone/);
  assert.match(msg, /not being matched/);
  assert.doesNotMatch(msg, /NOT removed|failed|error/i);
});

test('an unnamed face is still accounted for rather than quoted empty', () => {
  assert.match(removalMessage('', REFUSED, {}).msg, /^"That face" was NOT removed/);
  assert.match(removalMessage(undefined, REMOVED).msg, /^"That face"/);
});

test('no outcome is ever both forgettable and reported as an error', () => {
  // A consistency check across the whole set: the list may forget a face
  // exactly when the operator is told it is gone.
  for (const outcome of [REMOVED, ALREADY_GONE, REFUSED]) {
    const { kind } = removalMessage('X', outcome, {});
    assert.equal(
      mayForget(outcome), kind === 'success',
      `${outcome}: the screen and the message disagree about whether it is gone`,
    );
  }
});
