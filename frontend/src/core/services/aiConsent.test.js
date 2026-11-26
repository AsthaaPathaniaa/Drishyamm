/**
 * The rule that a camera is never switched to AI without being asked.
 *
 * Each test is one claim made to an operator, or one reading of the server's
 * answer. The wording of the question belongs to whichever feature is asking
 * (head count's is pinned in modules/headcount/counting-status.test.js); what
 * is pinned here is the rule itself, which all of them share.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_CONSENT_REQUIRED, aiOn, needsAiConsent, isConsentRefusal, errorText,
} from './aiConsent.js';

// A camera the way GET /ai/cameras serialises one. `ai.enabled` + mode are the
// master switch; a feature's own tick sits under its own key.
const cam = (over = {}) => ({
  id: `c-${over.monitorId || '1'}`,
  monitorId: over.monitorId || '1',
  name: over.name || 'Camera 1',
  status: 'online',
  ai: { enabled: true, mode: 'continuous' },
  headcount: { enabled: true, threshold: 0, zones: [] },
  ...over,
});

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

// ── who has to be asked ─────────────────────────────────────────────────────
//
// A feature cannot start while the master AI switch is off, and something has
// to turn it on. These pin that the something ASKS. Telling an operator
// afterwards that their tick also switched AI on is the same fault as doing it
// silently, one step quieter: a change they did not choose.

test('a camera whose AI is off needs to be asked about', () => {
  assert.equal(needsAiConsent(cam({ ai: { enabled: false, mode: 'off' } })), true);
  assert.equal(needsAiConsent(cam({ ai: { enabled: true, mode: 'off' } })), true);
  assert.equal(needsAiConsent(cam({ ai: {} })), true);
});

test('a camera whose AI is already on is not asked about — nothing changes for it', () => {
  assert.equal(needsAiConsent(cam()), false);
});

test('the server asking is read from its CODE, never from its prose', () => {
  // A copy edit to the message must not stop the dialog appearing.
  assert.equal(isConsentRefusal({
    response: { status: 409, data: { code: AI_CONSENT_REQUIRED, message: 'anything at all' } },
  }), true);
  assert.equal(isConsentRefusal({
    response: { status: 409, data: { message: 'some other conflict' } },
  }), false);
  assert.equal(isConsentRefusal({
    response: { status: 500, data: { code: AI_CONSENT_REQUIRED } },
  }), false);
  assert.equal(isConsentRefusal(new Error('network down')), false);
  assert.equal(isConsentRefusal(undefined), false);
});

// ── the refusals that are NOT a consent question ────────────────────────────
//
// A save can be refused for reasons an operator can act on and cannot guess —
// an exhausted licence, a camera deleted in another tab, an unreachable
// backend. None of those opens the dialog, so a catch that says nothing puts
// the tick back in silence.

test('the server\'s own sentence is what the operator is shown', () => {
  assert.equal(
    errorText({ response: { data: { message: 'Your head-count licence covers 10 cameras.' } } }),
    'Your head-count licence covers 10 cameras.',
  );
});

test('a network error still says something true', () => {
  assert.equal(errorText(new Error('Network Error')), 'Network Error');
  assert.match(errorText(undefined), /gave no reason/);
  assert.match(errorText({}), /gave no reason/);
});
