/**
 * The question is asked at the door, not at the save.
 *
 * Drawing a zone on a camera with no detector used to be a round trip: the
 * side panel navigated, the operator drew a shape, named it, set its rules,
 * pressed Save -- and learned from a 409 that none of it could ever fire.
 * Everything in between was wasted, and the message arrived at the point where
 * it reads as "your work is lost" rather than "choose a detector first".
 *
 * These pin the decision `zoneEntry` makes before anything is navigated. The
 * two that matter most are the LAST two: what each option switches on, because
 * an option that quietly left face recognition enabled would spend a licence
 * the operator did not agree to, and that is the exact defect that appeared on
 * the head-count page one commit earlier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  zoneEntry, USE_FACE, USE_BODY, hasProducer,
} from './zone-detector.js';

/** A camera's GET /ai/cameras row. AI on, face on, body off by default. */
const cam = (ai = {}) => ({
  id: 'c1',
  name: 'Server room',
  ai: { enabled: true, mode: 'continuous', ...ai },
});

const anonymous = () => cam({ faceRecognition: false });            // face off, body off
const masterOff = () => cam({ enabled: false, mode: 'off', faceRecognition: false });

// ── when nothing needs deciding ────────────────────────────────────────────

test('a camera with face recognition on sails through — no dialog', () => {
  assert.equal(zoneEntry(cam()), null);
  assert.equal(hasProducer(cam()), true);
});

test('a camera with body detection on sails through too', () => {
  assert.equal(zoneEntry(cam({ faceRecognition: false, zoneBodyDetection: true })), null);
});

test('and one with BOTH on, obviously', () => {
  assert.equal(zoneEntry(cam({ zoneBodyDetection: true })), null);
});

// ── the two cases that stop at the door ────────────────────────────────────

test('face off and body off is stopped, and says nothing is detecting people', () => {
  const entry = zoneEntry(anonymous(), 'Server room');
  assert.equal(entry.code, 'no-detector');
  assert.match(entry.title, /Nothing is detecting people on Server room/);
  assert.match(entry.body, /both off/);
  // It must say what the zone would do, not just what is missing.
  assert.match(entry.body, /never set anything off/);
});

test('the master AI being off is the same question, worded for that case', () => {
  const entry = zoneEntry(masterOff(), 'Server room');
  assert.equal(entry.code, 'ai-off');
  assert.match(entry.title, /not being used by AI yet/);
  // One dialog, not two: it says the master comes on with the choice.
  assert.match(entry.body, /switches the camera's AI on/);
});

test('both cases offer the same two choices — the decision is the same one', () => {
  for (const row of [anonymous(), masterOff()]) {
    const ids = zoneEntry(row).options.map((o) => o.id);
    assert.deepEqual(ids, [USE_BODY, USE_FACE]);
  }
});

test('body is offered FIRST and marked for lockout', () => {
  // Order is the recommendation. A strict lockout permits nobody, so the
  // person who matters is the one avoiding the camera -- which only body
  // detection sees. Listing face first would recommend the wrong one by
  // default for the commonest reason people draw a zone.
  const [first, second] = zoneEntry(anonymous()).options;
  assert.equal(first.id, USE_BODY);
  assert.equal(first.recommendedFor, 'lockout');
  assert.equal(second.id, USE_FACE);
});

test('with no camera name it still reads as a sentence', () => {
  assert.match(zoneEntry(anonymous()).title, /Nothing is detecting people on this camera/);
});

test('a missing row is treated as having no producer, not as fine', () => {
  // Failing open here would navigate an operator to a zone they cannot arm.
  assert.ok(zoneEntry(null));
  assert.ok(zoneEntry(undefined));
  assert.ok(zoneEntry({}));
});

// ── what each choice actually switches on ──────────────────────────────────

test('each option says what it costs, so a licence is never spent unseen', () => {
  const [body, face] = zoneEntry(anonymous()).options;
  assert.equal(body.costsFaceLicence, false);
  assert.equal(face.costsFaceLicence, true);
  // And the expensive one says so in words too, not only in a flag.
  assert.match(face.detail, /face recognition licence/i);
});

test('the BODY option switches face recognition explicitly OFF', () => {
  // The whole point. `faceRecognition` absent means ON, so an option promising
  // "it never tells you who" must set it false rather than leave it out --
  // otherwise it starts face matching and spends a licence, which is the
  // defect that reached the head-count page one commit earlier.
  const [body] = zoneEntry(anonymous()).options;
  assert.equal(body.overrides.faceRecognition, false);
  assert.equal(body.overrides.zoneBodyDetection, true);
  assert.equal(body.overrides.enabled, true);
});

test('the FACE option switches face on and leaves body alone', () => {
  const face = zoneEntry(anonymous()).options.find((o) => o.id === USE_FACE);
  assert.equal(face.overrides.faceRecognition, true);
  assert.equal(face.overrides.enabled, true);
  // Not mentioned, so buildEnablePayload keeps whatever the camera had. This
  // option is not a request to turn a second detector off.
  assert.equal('zoneBodyDetection' in face.overrides, false);
});

test('every option turns the master on, because both cases may need it', () => {
  for (const row of [anonymous(), masterOff()]) {
    for (const option of zoneEntry(row).options) {
      assert.equal(option.overrides.enabled, true, `${option.id} must switch the master on`);
    }
  }
});

test('what each option promises matches what it sets', () => {
  // The consistency check: an option whose words say faces are not matched
  // must not set a flag that matches them. This is the broken-promise class of
  // defect, caught across the whole set rather than one option at a time.
  for (const option of zoneEntry(anonymous()).options) {
    const promisesNoNames = /never tells you WHO|detects a body, not a face/i.test(option.detail);
    if (promisesNoNames) {
      assert.equal(
        option.overrides.faceRecognition, false,
        `${option.id} promises no face matching but does not switch face off`,
      );
    }
  }
});
