/**
 * This module asks before it switches a camera's AI on, and these tests are
 * what keep that promise.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS NOT
 *
 * The consent dialog promises, in so many words, "faces are not matched, and
 * no other AI feature is started". The repair button two inches away went
 * through the per-camera LIFECYCLE route with `buildEnablePayload`, which
 * carried `faceRecognition: ai.faceRecognition !== false` -- TRUE for a camera
 * that had never been configured. So the button started face recognition and
 * spent a face licence while the dialog promised the opposite.
 *
 * This file used to guard that by READING SOURCE TEXT: it scanned every file
 * in the module for `buildEnablePayload` and `updateCameraAiLifecycle` and
 * failed if either appeared. It was honest about its own cost -- blind to a
 * re-export, a dynamic import, or a helper in another module calling on this
 * module's behalf -- and both of those blind spots turned out to be real:
 * ZoneSetup hands `buildEnablePayload` to zone-detector as `buildPayload`,
 * which calls it later, and a text scan could never have seen it.
 *
 * So the rule moved into the function. `buildEnablePayload` now THROWS unless
 * the caller states `faceRecognition`, which no re-export or indirect call can
 * walk past, and the proof lives beside it in core/services/aiCamera.test.js.
 * The scan is gone rather than kept alongside: a source-text test maintained
 * for a rule it no longer protects is worse than no test, because it still
 * fails on a rename and still looks like the guard.
 *
 * WHAT REMAINS, AND WHY
 *
 * Consent is a different promise from the face flag, and nothing enforces it
 * but these two assertions: that `enableAi: true` is sent from at most the two
 * places entitled to send it, and that it is still sent from somewhere at all.
 * They are source-text tests for the same reason as before -- the rule is
 * about which code may exist -- and that trade is still worth making here,
 * because there is no value to assert and no signature to put it in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every source file in this module, test files excluded. */
function sources() {
  return readdirSync(HERE)
    .filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'))
    .map((f) => ({ file: f, text: readFileSync(join(HERE, f), 'utf8') }));
}

// The doors that turn a camera's AI on, and must not be used here.
//
// `updateCameraAiLifecycle` is the Camera Setup → AI Detection route. It is
// right there and wrong here: it decides the face flag from what is stored,
// and absent means ON.
//
// `buildEnablePayload` is its body builder, and is the specific thing that
// made the promise false.
test('and the one door it does use is the head-count endpoint with consent', () => {
  // The positive half. Without it, deleting the only correct call site would
  // leave the test above passing on a module that cannot switch AI on at all.
  const page = sources().find((s) => s.file === 'HeadCount.jsx');
  assert.ok(page, 'HeadCount.jsx is gone — this test needs rewriting, not deleting');
  assert.match(page.text, /setHeadcount\(/, 'nothing calls the head-count endpoint');
  assert.match(page.text, /enableAi:\s*true/, 'nothing ever sends consent, so a camera '
    + 'whose AI is off can no longer be switched on at all');
});

test('the module asks before it consents — the dialog is not bypassed', () => {
  // `enableAi: true` must never be sent on a path that did not ask. The two
  // places allowed to send it are the consent dialog's own retry and the
  // repair button, which IS the question (it is labelled "Turn AI on").
  const page = sources().find((s) => s.file === 'HeadCount.jsx');
  const sends = (page.text.match(/enableAi:\s*true/g) || []).length;
  assert.ok(sends <= 2, `enableAi: true is sent from ${sends} places; only the consent `
    + 'dialog retry and the labelled "Turn AI on" button may send it. A third means '
    + 'something switches a camera\'s AI on without asking.');
});

/*
 * WHAT THESE TESTS COST, SO THE NEXT PERSON CAN JUDGE THEM
 *
 * They read source text, so they are blind to anything indirect, and they fail
 * if the files are renamed. That is the intended trade for the consent rule:
 * it is about which code may exist, there is no return value to assert, and no
 * function signature to hide it in -- unlike the face flag, which had one and
 * now uses it.
 *
 * If this module ever legitimately needs a third place to send `enableAi`,
 * raise the count and say why in the same commit. Deleting the assertion to
 * make it pass is deleting the only thing holding the promise up.
 */
