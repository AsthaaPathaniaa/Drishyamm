/**
 * What the zone editor tells an operator about a lockout zone's coverage, and
 * the inline switch that changes it.
 *
 * Off is a legitimate choice. A SILENT off on a security control is not: a
 * strict-lockout zone with face-only detection misses the person with their
 * back to the camera, the hooded face, the one too far away to read — which is
 * precisely the intruder the zone was drawn for. So the editor says what the
 * zone will and will not catch, and offers the switch where it stands rather
 * than sending the operator to another screen to find it.
 *
 * The blocked case is different in kind: a camera with face recognition off
 * and body detection off has NO producer, the backend refuses to arm a zone on
 * it with a 409, and `zoneDetectorProblem` is the client half of that so the
 * operator never has to send a save to find out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_TURNED_ON, bodyProducing, bodyRequired, enableBodyDetection, faceProducing,
  hasProducer, zoneCoverage, zoneDetectorProblem,
} from './zone-detector.js';

const row = (ai = {}) => ({ id: 'cam-1', name: 'Server room', ai: { enabled: true, mode: 'continuous', ...ai } });

const FACE_ONLY = row();
const BODY_ON = row({ zoneBodyDetection: true });
const BOTH = row({ faceRecognition: true, zoneBodyDetection: true });
const ANON = row({ faceRecognition: false });
const ANON_COVERED = row({ faceRecognition: false, zoneBodyDetection: true });
const AI_OFF = row({ enabled: false, mode: 'off' });

/* ──────────────────────── the producer rules ───────────────────────────── */

test('face recognition absent means ON; body detection absent means OFF', () => {
  assert.equal(faceProducing(FACE_ONLY), true);
  assert.equal(bodyProducing(FACE_ONLY), false);
  assert.equal(hasProducer(FACE_ONLY), true);
});

test('an anonymous camera with no body detection has NO producer', () => {
  assert.equal(faceProducing(ANON), false);
  assert.equal(bodyProducing(ANON), false);
  assert.equal(hasProducer(ANON), false);
  assert.equal(bodyRequired(ANON), true);
});

test('AI off means no producer at all, flags notwithstanding', () => {
  assert.equal(hasProducer(row({ enabled: false, mode: 'off', zoneBodyDetection: true })), false);
  assert.equal(hasProducer(row({ mode: 'off', zoneBodyDetection: true })), false);
  // ...but it is not the "needs body detection" case: nothing runs because the
  // operator said so.
  assert.equal(bodyRequired(AI_OFF), false);
});

test('both producers can run at once', () => {
  assert.equal(faceProducing(BOTH), true);
  assert.equal(bodyProducing(BOTH), true);
});

/* ─────────────── the warning, and when it stays quiet ──────────────────── */

test('a face-only LOCKOUT zone is warned about, and the switch offered', () => {
  const c = zoneCoverage(FACE_ONLY, 'lockout');
  assert.equal(c.level, 'warning');
  assert.equal(c.offer, true);
  // The misses are the point: this is what the operator is actually deciding.
  assert.ok(c.misses.length >= 3);
  assert.ok(c.misses.some((m) => /back or side/i.test(m)));
  assert.ok(c.misses.some((m) => /hooded|covered|masked/i.test(m)));
  assert.ok(c.misses.some((m) => /too far/i.test(m)));
  // And what it DOES catch, so the warning is not read as "this is broken".
  assert.ok(c.catches.length >= 1);
});

test('the warning explains why a nameless body still matters here', () => {
  const c = zoneCoverage(FACE_ONLY, 'lockout');
  assert.match(c.reason, /nobody is permitted/i);
});

test('body detection on silences the lockout warning', () => {
  assert.equal(zoneCoverage(BODY_ON, 'lockout'), null);
  assert.equal(zoneCoverage(BOTH, 'lockout'), null);
  assert.equal(zoneCoverage(ANON_COVERED, 'lockout'), null);
});

test('a PUBLIC zone is never warned about', () => {
  // It alarms on nobody, so its coverage is not a security question.
  assert.equal(zoneCoverage(FACE_ONLY, 'public'), null);
});

test('a RESTRICTED (allow-list) zone is not warned about here', () => {
  // That mode is not offered today precisely because zone-guard's nameless
  // boxes break it, and it carries its own explanation in access-data.js.
  // Two warnings saying different things about one zone is worse than one.
  assert.equal(zoneCoverage(FACE_ONLY, 'restricted'), null);
});

/* ───────────────────────── the blocked case ────────────────────────────── */

test('an anonymous camera blocks the zone outright, whatever the mode', () => {
  for (const mode of ['public', 'lockout', 'restricted']) {
    const c = zoneCoverage(ANON, mode);
    assert.equal(c.level, 'blocked', mode);
    assert.equal(c.offer, true, mode);
    assert.match(c.reason, /cannot be armed/i);
    assert.ok(c.misses.some((m) => /everyone/i.test(m)));
  }
});

test("a camera whose AI is off says so, and does NOT offer the detector switch", () => {
  // Offering it here would be a control that saves and changes nothing: with
  // the master off, no detector runs whatever this flag says.
  const c = zoneCoverage(AI_OFF, 'lockout');
  assert.equal(c.level, 'blocked');
  assert.equal(c.offer, false);
  assert.match(c.reason, /Camera Setup/);
});

test('AI off wins over the anonymous case, so one message is shown', () => {
  const c = zoneCoverage(row({ enabled: false, mode: 'off', faceRecognition: false }), 'lockout');
  assert.equal(c.offer, false);
  assert.match(c.headline, /AI is off/i);
});

/* ────────────────── the save guard (the client half of 409) ────────────── */

test('a zone cannot be saved armed on a producerless camera', () => {
  const problem = zoneDetectorProblem(ANON, 'Lobby cam');
  assert.ok(problem);
  assert.match(problem, /Lobby cam/);
  // Names the switch, or the operator deletes the zone instead of fixing it.
  assert.match(problem, /Catch people with no visible face/);
});

test('a camera with either producer saves fine', () => {
  assert.equal(zoneDetectorProblem(FACE_ONLY, 'Cam'), null);
  assert.equal(zoneDetectorProblem(BODY_ON, 'Cam'), null);
  assert.equal(zoneDetectorProblem(ANON_COVERED, 'Cam'), null);
});

test('AI off is not reported as a detector problem', () => {
  // The editor already says the camera's AI is off, in its own words. Adding
  // a second sentence about detectors would bury the one that matters.
  assert.equal(zoneDetectorProblem(AI_OFF, 'Cam'), null);
});

test('a camera the registry has not loaded is not blocked', () => {
  // The server is the authority. Blocking on a missing row would make a
  // registry hiccup look like a rejected zone.
  assert.equal(zoneDetectorProblem(null, 'Cam'), null);
  assert.equal(zoneDetectorProblem(undefined, 'Cam'), null);
});

/* ─────────────────────── the inline switch ─────────────────────────────── */

const mocks = (over = {}) => {
  const calls = [];
  return {
    calls,
    buildPayload: (r, overrides) => ({ enabled: true, carried: r.ai?.fps ?? null, ...overrides }),
    enableCamera: async (id, payload) => { calls.push({ id, payload }); return over.result ?? { success: true }; },
  };
};

test('it sends zoneBodyDetection true through the lifecycle route', async () => {
  const m = mocks();
  const res = await enableBodyDetection({ row: row({ fps: 6 }), ...m });

  assert.equal(res.status, 'turned-on');
  assert.equal(res.note, BODY_TURNED_ON);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].id, 'cam-1');
  assert.equal(m.calls[0].payload.zoneBodyDetection, true);
  // Built from the camera's OWN settings, so turning this on cannot reset
  // anything else the camera had.
  assert.equal(m.calls[0].payload.carried, 6);
});

test('turning body detection on does NOT switch face recognition on', async () => {
  // The defect: buildEnablePayload defaults faceRecognition to `!== false`, so
  // a camera nobody had configured got face recognition -- and a face licence
  // -- from a button that only offered body detection.
  const m = mocks();
  await enableBodyDetection({ row: AI_OFF, ...m });
  assert.equal(m.calls[0].payload.zoneBodyDetection, true);
  assert.equal(m.calls[0].payload.faceRecognition, false,
    'a camera whose AI was off must not start matching faces because a zone was drawn');
});

test('nor does it switch face recognition OFF on a camera already matching', async () => {
  // The opposite mistake, and just as bad: absent means ON, so FACE_ONLY is
  // matching faces right now. Adding body detection must not stop it.
  const m = mocks();
  await enableBodyDetection({ row: FACE_ONLY, ...m });
  assert.equal(m.calls[0].payload.faceRecognition, true);
});

test('an anonymous camera stays anonymous', async () => {
  const m = mocks();
  await enableBodyDetection({ row: ANON, ...m });
  assert.equal(m.calls[0].payload.faceRecognition, false);
  assert.equal(m.calls[0].payload.zoneBodyDetection, true);
});

test('a camera already running it is left alone, and nothing is said', async () => {
  const m = mocks();
  const res = await enableBodyDetection({ row: BODY_ON, ...m });

  assert.equal(res.status, 'already-on');
  assert.equal(res.note, '');
  assert.equal(m.calls.length, 0);
});

test('a reconcile the AI service refused is reported, not swallowed', async () => {
  const m = mocks({ result: { reconcile: { ok: false, error: 'no GPU capacity' } } });
  const res = await enableBodyDetection({ row: FACE_ONLY, ...m });

  assert.equal(res.status, 'failed');
  assert.match(res.note, /no GPU capacity/);
  assert.match(res.note, /Nothing is detected until it does/);
});

test('a thrown request never escapes: the operator is mid-edit', async () => {
  const res = await enableBodyDetection({
    row: FACE_ONLY,
    buildPayload: () => ({}),
    enableCamera: async () => { throw new Error('network down'); },
  });

  assert.equal(res.status, 'failed');
  assert.match(res.note, /network down/);
  // Always a way forward.
  assert.match(res.note, /Camera Setup/);
});

test("a server message is preferred over the generic one", async () => {
  const res = await enableBodyDetection({
    row: FACE_ONLY,
    buildPayload: () => ({}),
    enableCamera: async () => {
      const err = new Error('Request failed');
      err.response = { data: { message: 'Your plan does not include AI' } };
      throw err;
    },
  });
  assert.match(res.note, /Your plan does not include AI/);
});

test('no camera row means nothing is called and the operator is told', async () => {
  const m = mocks();
  const res = await enableBodyDetection({ row: null, ...m });

  assert.equal(res.status, 'unknown');
  assert.equal(m.calls.length, 0);
  assert.match(res.note, /not in the AI camera list/);
});
