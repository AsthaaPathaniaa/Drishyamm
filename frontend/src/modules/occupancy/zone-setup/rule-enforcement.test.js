/**
 * Working rules above the ones that only save.
 *
 * The drawer offered four sections of settings and they did not all do
 * something. Three are read by nothing — StepBehaviour already wraps their
 * controls in `NotEnforced`, so the codebase knew — but they sat interleaved
 * with the two that work, in the same accordion, under the same confident
 * summary lines. A control that looks armed and is not is the failure mode to
 * design against on a security page.
 *
 * These pin the classification against the one narrow point that decides it:
 * `toApi` in restricted-zones-api.js sends monitorId, cameraName, name, shape,
 * points, rect, priority, alertOnEntry, allowed, schedule, window, dwellSec
 * and maxOccupancy. A rule whose field is not in that list CANNOT be enforced,
 * whatever the UI implies — so the last test reads the real file and checks it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  RULE_SECTIONS, ENFORCED, STORED_ONLY,
  isEnforced, ruleSection, groupSections, PENDING_HEADING, PENDING_NOTE,
} from './rule-enforcement.js';

test('capacity and access are the two that reach the engine', () => {
  assert.deepEqual(
    RULE_SECTIONS.filter((s) => s.status === ENFORCED).map((s) => s.id),
    ['capacity', 'access'],
  );
});

test('schedule, staffing and identity save and do nothing yet', () => {
  assert.deepEqual(
    RULE_SECTIONS.filter((s) => s.status === STORED_ONLY).map((s) => s.id),
    ['schedule', 'staffing', 'identity'],
  );
});

test('working sections come FIRST, in declared order', () => {
  const { working, pending } = groupSections();
  assert.deepEqual(working.map((s) => s.id), ['capacity', 'access']);
  assert.deepEqual(pending.map((s) => s.id), ['schedule', 'staffing', 'identity']);
});

test('grouping only ever returns sections it was given', () => {
  const { working, pending } = groupSections(['capacity', 'staffing']);
  assert.deepEqual(working.map((s) => s.id), ['capacity']);
  assert.deepEqual(pending.map((s) => s.id), ['staffing']);
});

test('isEnforced is false for an id nobody classified — never true by accident', () => {
  assert.equal(isEnforced('capacity'), true);
  assert.equal(isEnforced('staffing'), false);
  // The important one: a section added later is treated as unproven, not as
  // working, so a new rule cannot claim to be armed by being unlisted.
  assert.equal(isEnforced('something-new'), false);
  assert.equal(isEnforced(undefined), false);
  assert.equal(ruleSection('something-new'), null);
});

test('every pending section says why, and never promises an alert', () => {
  for (const sec of RULE_SECTIONS.filter((s) => s.status === STORED_ONLY)) {
    assert.ok(sec.why, `${sec.id} has no reason`);
    assert.match(sec.why, /not|nothing|no service/i, `${sec.id}'s reason does not say it is inert`);
  }
});

test('the heading and note tell an operator why an inert control is shown', () => {
  assert.match(PENDING_HEADING, /Not enforced yet/);
  // It must answer "then why is it here?" -- the setting is kept.
  assert.match(PENDING_NOTE, /kept/);
  assert.match(PENDING_NOTE, /nothing here will raise an alert/);
});

test('the schedule section warns about the OTHER schedule, which does work', () => {
  // Two schedules on one page, one inert, is the trap worth naming: the arm
  // window that is enforced lives inside Access.
  assert.match(ruleSection('schedule').why, /Access/);
});

test('every ENFORCED field really is one `toApi` sends', () => {
  // The check that keeps this file honest rather than aspirational. If someone
  // marks a section enforced without the payload carrying it, this fails.
  const api = readFileSync(
    new URL('./restricted-zones-api.js', import.meta.url), 'utf8',
  );
  const sent = api.slice(api.indexOf('export function toApi'), api.indexOf('export function fromApi'));

  // capacity -> maxOccupancy; access -> the mode/roles/schedule/severity set.
  assert.match(sent, /maxOccupancy/);
  assert.match(sent, /alertOnEntry/);
  assert.match(sent, /allowed/);
  assert.match(sent, /dwellSec/);
  assert.match(sent, /priority/);
  assert.match(sent, /schedule/);

  // And the inert ones are genuinely absent from the payload.
  for (const field of ['offHoursLock', 'minCapacity', 'privacy']) {
    assert.ok(
      !sent.includes(field),
      `toApi now sends \`${field}\` — its section may no longer belong under "${PENDING_HEADING}"`,
    );
  }
});
