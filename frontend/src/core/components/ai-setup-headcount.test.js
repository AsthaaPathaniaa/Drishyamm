/**
 * Tests for the AI setup drawer's decision about its head-count call.
 *
 * Runs on Node's built-in test runner (`npm test`). What is checked: the
 * combination that can only be refused is caught before any call is made, the
 * common case (one submit turns AI on AND ticks counting) still makes both
 * calls, un-ticking is never refused whatever the master is doing, and a
 * submit that does not touch counting is left alone.
 *
 * The decision is tested through `planHeadcountChange` rather than through the
 * drawer, because that function IS the decision -- the drawer does nothing
 * with it but set a sentence or make a call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADCOUNT_NEEDS_AI, aiOnAfterSave, planHeadcountChange,
} from './ai-setup-headcount.js';

/** One row as GET /ai/cameras serialises it (serializeAiCamera, backend). */
const row = ({ ai, headcount, ...over } = {}) => ({
  id: 'cam-db-uuid',
  monitorId: 'MON7',
  name: 'Front entrance',
  ...over,
  ai: { enabled: false, mode: 'off', faceRecognition: true, ...ai },
  headcount: { enabled: false, threshold: 0, zones: [], ...headcount },
});

/** What the drawer's Save button builds: AI on, continuous. */
const enablePayload = (over = {}) => ({ enabled: true, mode: 'continuous', fps: 4, ...over });
/** What its "Turn AI off" button builds. */
const disablePayload = (over = {}) => ({ enabled: false, mode: 'off', fps: 4, ...over });

test('AI left off while counting is ticked is refused, with nothing sent', () => {
  const plan = planHeadcountChange({
    camera: row(), payload: disablePayload(), headcountEnabled: true,
  });
  assert.equal(plan.send, false);
  assert.equal(plan.refuse, HEADCOUNT_NEEDS_AI);
});

test('the refusal says what to do, and names both ways out', () => {
  // The operator is standing in front of the two controls that disagree, so
  // the sentence has to point at them rather than at a failed request.
  assert.match(HEADCOUNT_NEEDS_AI, /needs this camera's AI on/);
  assert.match(HEADCOUNT_NEEDS_AI, /Switch AI on above/);
  assert.match(HEADCOUNT_NEEDS_AI, /untick counting/);
  // And it is not the old after-the-fact report, which described a request
  // that never had a chance of succeeding.
  assert.doesNotMatch(HEADCOUNT_NEEDS_AI, /could not be changed/);
});

test('the consent flag is never part of the answer', () => {
  // `enableAi: true` is the backend's consent token for switching a camera's
  // master AI on. This drawer must not hold it: the form itself is where an
  // operator turns the master on, and a flag sent behind that is the same
  // decision taken quietly. An absent key is the assertion -- see
  // aiLifecycle.service.js AI_CONSENT_REQUIRED.
  for (const headcountEnabled of [true, false]) {
    for (const payload of [enablePayload(), disablePayload()]) {
      const plan = planHeadcountChange({ camera: row(), payload, headcountEnabled });
      assert.equal('enableAi' in plan, false);
    }
  }
});

test('one submit that turns AI on and ticks counting still saves both', () => {
  // The common case, and the reason the refusal is read off the PAYLOAD and
  // not off the camera row: the row still says AI is off, and the save that is
  // about to go out is what turns it on.
  const plan = planHeadcountChange({
    camera: row(), payload: enablePayload(), headcountEnabled: true,
  });
  assert.equal(plan.send, true);
  assert.equal(plan.enabled, true);
  assert.equal(plan.refuse, null);
});

test('a camera already running AI ticks counting as before', () => {
  const plan = planHeadcountChange({
    camera: row({ ai: { enabled: true, mode: 'continuous' } }),
    payload: enablePayload(),
    headcountEnabled: true,
  });
  assert.equal(plan.send, true);
  assert.equal(plan.refuse, null);
});

test('un-ticking counting is never refused, even with AI off', () => {
  // The backend only asks about STARTING counting (`startAi = enabled &&
  // !isAiEnabled`). Refusing this would strand a camera ticked for counting
  // with its AI off and no way to untick it.
  const plan = planHeadcountChange({
    camera: row({ headcount: { enabled: true } }),
    payload: disablePayload(),
    headcountEnabled: false,
  });
  assert.equal(plan.send, true);
  assert.equal(plan.enabled, false);
  assert.equal(plan.refuse, null);
});

test('a tick that did not change makes no call and no complaint', () => {
  // Including the contradictory-looking case: counting is already on in the
  // database and this submit is not asking to change it, so there is nothing
  // to refuse and nothing to send.
  const unchangedOn = planHeadcountChange({
    camera: row({ headcount: { enabled: true } }),
    payload: disablePayload(),
    headcountEnabled: true,
  });
  assert.deepEqual(unchangedOn, { send: false, enabled: undefined, refuse: null });

  const unchangedOff = planHeadcountChange({
    camera: row(), payload: enablePayload(), headcountEnabled: false,
  });
  assert.deepEqual(unchangedOff, { send: false, enabled: undefined, refuse: null });
});

test('a submit that is not about counting is left entirely alone', () => {
  // "Turn AI off" passes no tick at all. It must not acquire a counting call,
  // and must not be refused for a question it never asked.
  const plan = planHeadcountChange({
    camera: row({ headcount: { enabled: true } }), payload: disablePayload(),
  });
  assert.deepEqual(plan, { send: false, enabled: undefined, refuse: null });
  assert.deepEqual(
    planHeadcountChange({ camera: row(), payload: enablePayload(), headcountEnabled: undefined }),
    { send: false, enabled: undefined, refuse: null },
  );
});

test('the master switch is read as the backend reads it: enabled AND not off', () => {
  // Mirrors isAiEnabled (aiLifecycle.service.js). `enabled: true` with
  // mode 'off' is not AI on, and reading only `enabled` would send the call
  // that cannot succeed.
  assert.equal(aiOnAfterSave(enablePayload(), row()), true);
  assert.equal(aiOnAfterSave(disablePayload(), row()), false);
  assert.equal(aiOnAfterSave({ enabled: true, mode: 'off' }, row()), false);
  // Truthy-but-not-true is not consent to anything: the lifecycle route reads
  // `patch.enabled === true`, so anything else saves the master OFF.
  assert.equal(aiOnAfterSave({ enabled: 1, mode: 'continuous' }, row()), false);
  assert.equal(aiOnAfterSave({ enabled: 'true', mode: 'continuous' }, row()), false);
  assert.equal(aiOnAfterSave(undefined, row()), false);
  assert.equal(aiOnAfterSave({}, undefined), false);
});

test('a payload with no mode resolves it the way the save will', () => {
  // The controller writes `mode: patch.mode || previousAi.mode ||
  // 'continuous'`. So a payload that omits `mode` leaves a camera stored as
  // 'off' still off -- and counting on it still cannot start.
  assert.equal(aiOnAfterSave({ enabled: true }, row({ ai: { mode: 'off' } })), false);
  assert.equal(aiOnAfterSave({ enabled: true }, row({ ai: { mode: 'continuous' } })), true);
  // No stored mode at all: the controller's own default applies.
  assert.equal(aiOnAfterSave({ enabled: true }, { ai: {} }), true);
  // And the refusal follows that reading rather than guessing.
  assert.equal(
    planHeadcountChange({
      camera: row({ ai: { mode: 'off' } }), payload: { enabled: true }, headcountEnabled: true,
    }).refuse,
    HEADCOUNT_NEEDS_AI,
  );
});
