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
  zoneEntry, applyZoneEntry, USE_FACE, USE_BODY, hasProducer,
} from './zoneDetector.js';

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

test('a camera is named by its own row, and falls back to a sentence', () => {
  // The row carries the name, so the caller does not have to pass one.
  assert.match(zoneEntry(anonymous()).title, /Nothing is detecting people on Server room/);
  // Nothing knows what it is called: still a sentence, not a blank or an id.
  assert.match(
    zoneEntry({ id: 'c9', ai: { enabled: true, faceRecognition: false } }).title,
    /Nothing is detecting people on this camera/,
  );
});

test('the operator\'s own label wins over the row name when one is given', () => {
  // ZoneSetup resolves a monitor id to the label shown in the rail and the
  // canvas bar. The dialog must name the camera the same way the page does.
  const entry = zoneEntry([anonymous()], () => 'Loading bay (east)');
  assert.match(entry.title, /Loading bay \(east\)/);
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

// ── the whole zone, not one camera ─────────────────────────────────────────
//
// A zone writes its counting config to EVERY camera it is drawn on (`touched`
// in room-settings' saveRoom), and the master AI switch gates that write. So
// checking only the camera the operator happened to be looking at let a
// three-camera zone sail through the door and die at the save -- which is the
// exact round trip this dialog exists to prevent, one camera along.

test('a zone whose every camera has a producer asks nothing', () => {
  assert.equal(zoneEntry([cam(), cam({ zoneBodyDetection: true })]), null);
});

test('an empty camera list asks nothing — a zone with no cameras is not this question', () => {
  // The editor reports "this zone has no camera" itself; answering it with a
  // detector dialog would be the wrong question about a real problem.
  assert.equal(zoneEntry([]), null);
});

test('one bad camera in a three-camera zone is caught, and only it is named', () => {
  const rows = [
    cam({}),                                                   // fine
    { id: 'c2', name: 'Vault', ai: { enabled: false } },        // master off
    cam({ zoneBodyDetection: true }),                           // fine
  ];
  const entry = zoneEntry(rows);
  assert.ok(entry, 'the zone cannot be carried, so it must ask');
  // The cameras that are already fine are NOT in the dialog: changing them
  // would be switching detectors on nobody asked about.
  assert.deepEqual(entry.cameras.map((c) => c.name), ['Vault']);
  assert.match(entry.title, /Vault is not being used by AI yet/);
});

test('two blocked cameras are ONE dialog that names both', () => {
  const entry = zoneEntry([
    { id: 'c1', name: 'Dock', ai: { enabled: true, faceRecognition: false } },
    { id: 'c2', name: 'Gate', ai: { enabled: true, faceRecognition: false } },
  ]);
  assert.equal(entry.code, 'no-detector');
  assert.match(entry.body, /both off on Dock and Gate/);
  // The count is said, so "all of them" is never ambiguous.
  assert.match(entry.body, /applied to all 2/);
  assert.match(entry.title, /2 of this zone's cameras/);
  assert.equal(entry.cameras.length, 2);
});

test('three are listed as a person would write them', () => {
  const entry = zoneEntry(['Dock', 'Vault', 'Gate'].map((name, i) => ({
    id: `c${i}`, name, ai: { enabled: true, faceRecognition: false },
  })));
  assert.match(entry.body, /Dock, Vault and Gate/);
});

test('one camera with AI off among several makes it the AI-off question', () => {
  // Mixed: one needs the master switch, one only needs a detector. The master
  // is the bigger fact, and the wording has to cover both without claiming
  // every camera is off.
  const entry = zoneEntry([
    { id: 'c1', name: 'Dock', ai: { enabled: true, faceRecognition: false } },
    { id: 'c2', name: 'Vault', ai: { enabled: false, mode: 'off' } },
  ]);
  assert.equal(entry.code, 'ai-off');
  assert.match(entry.body, /switches AI on where it is off/);
  assert.match(entry.body, /Dock and Vault/);
  assert.equal(entry.cameras.length, 2);
});

test('a single row still works, because the door only ever has one', () => {
  // The side panel's "Draw a zone" gates the camera the drawer is open on.
  const entry = zoneEntry(cam({ faceRecognition: false }));
  assert.equal(entry.code, 'no-detector');
  assert.equal(entry.cameras.length, 1);
});

test('no option asks the backend for consent — this dialog IS the consent', () => {
  // The lifecycle route may switch the master on because the operator is
  // choosing here. `enableAi` is the head-count route's retry flag and has no
  // business in this payload; a stray one would be a second, quieter way to
  // turn AI on.
  for (const option of zoneEntry(anonymous()).options) {
    assert.equal('enableAi' in option.overrides, false, `${option.id} must not send enableAi`);
  }
});

test('the face option no longer recommends a mode that cannot be chosen', () => {
  // `allow-list` is `unavailable` in access-data.js: with a nameless body box
  // it excuses nobody, so the mode is not offered. A hint pointing at it would
  // point an operator at a choice the editor does not let them make.
  const face = zoneEntry(anonymous()).options.find((o) => o.id === USE_FACE);
  assert.equal(face.recommendedFor, undefined);
  // Body keeps its hint: strict lockout IS selectable, and is the case where
  // the wrong detector means a zone that misses the person it was drawn for.
  const body = zoneEntry(anonymous()).options.find((o) => o.id === USE_BODY);
  assert.equal(body.recommendedFor, 'lockout');
});

// ── applying the answer to every camera it named ───────────────────────────

/** Records what the lifecycle route was asked for, per camera. */
const recorder = (behaviour = () => ({})) => {
  const calls = [];
  return {
    calls,
    buildPayload: (row, overrides) => ({ forCamera: row.id, ...overrides }),
    enableCamera: async (id, payload) => {
      calls.push({ id, payload });
      return behaviour(id);
    },
  };
};

const twoBlocked = () => zoneEntry([
  { id: 'c1', name: 'Dock', ai: { enabled: true, faceRecognition: false } },
  { id: 'c2', name: 'Gate', ai: { enabled: false, mode: 'off' } },
]);

test('the choice is applied to EVERY camera the dialog named', () => {
  const entry = twoBlocked();
  const option = entry.options.find((o) => o.id === USE_BODY);
  const api = recorder();

  return applyZoneEntry({ entry, option, ...api }).then((res) => {
    assert.deepEqual(api.calls.map((c) => c.id), ['c1', 'c2']);
    // Each camera gets the option's overrides, built against its OWN row.
    for (const call of api.calls) {
      assert.equal(call.payload.faceRecognition, false);
      assert.equal(call.payload.zoneBodyDetection, true);
      assert.equal(call.payload.enabled, true);
      assert.equal(call.payload.forCamera, call.id);
    }
    assert.equal(res.failed.length, 0);
    assert.equal(res.applied.length, 2);
    assert.equal(res.note, '');
  });
});

test('one camera failing does not leave the others unchanged', async () => {
  // Stopping at the first failure would switch one camera on, leave the rest
  // off, and report neither -- the worst of the three outcomes.
  const entry = twoBlocked();
  const api = recorder((id) => {
    if (id === 'c1') throw new Error('the camera is unreachable');
    return {};
  });

  const res = await applyZoneEntry({ entry, option: entry.options[0], ...api });
  assert.deepEqual(api.calls.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(res.applied.map((a) => a.name), ['Gate']);
  assert.deepEqual(res.failed, [{ name: 'Dock', why: 'the camera is unreachable' }]);
  // The note names the camera and the reason, and says the drawing is safe.
  assert.match(res.note, /^Dock could not be changed: the camera is unreachable\./);
  assert.match(res.note, /nothing is lost/);
});

test('the server\'s own sentence is what the operator is shown', async () => {
  const entry = twoBlocked();
  const api = recorder(() => {
    const err = new Error('Request failed');
    err.response = { data: { message: 'Your face recognition licence is used up.' } };
    throw err;
  });
  const res = await applyZoneEntry({ entry, option: entry.options[0], ...api });
  // Both failed for ONE reason: said once, with both cameras named.
  assert.match(res.note, /Dock and Gate could not be changed: Your face recognition licence is used up\./);
});

test('a camera missing from the AI registry is reported, not skipped silently', async () => {
  const entry = zoneEntry([{ name: 'Nowhere', ai: { enabled: false } }]);
  const api = recorder();
  const res = await applyZoneEntry({ entry, option: entry.options[0], ...api });
  assert.deepEqual(api.calls, [], 'there is no camera id to call with');
  assert.match(res.note, /Nowhere could not be changed: it is not in the AI camera list/);
});

test('a flag saved but a camera not started is a notice, not a failure', async () => {
  // The setting is right and the service retries, so the zone is not refused
  // -- but nothing is detected until it starts, so it is said.
  const entry = zoneEntry([{ id: 'c1', name: 'Dock', ai: { enabled: true, faceRecognition: false } }]);
  const api = recorder(() => ({ reconcile: { ok: false, error: 'the AI service timed out' } }));
  const res = await applyZoneEntry({ entry, option: entry.options[0], ...api });
  assert.equal(res.failed.length, 0);
  assert.equal(res.applied.length, 1);
  assert.match(res.notices[0], /Dock: saved, but the AI service did not start it \(the AI service timed out\)/);
});

test('applying never throws, whatever the API does', async () => {
  const entry = twoBlocked();
  const api = recorder(() => { throw new Error('boom'); });
  const res = await applyZoneEntry({ entry, option: entry.options[0], ...api });
  assert.equal(res.failed.length, 2);
  // And called with nothing at all it still answers rather than crashing the
  // dialog the operator is looking at.
  const empty = await applyZoneEntry({});
  assert.deepEqual(empty.applied, []);
  assert.deepEqual(empty.failed, []);
});
