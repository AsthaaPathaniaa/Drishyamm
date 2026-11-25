/**
 * There is ONE way to switch a camera's AI on from this module, and this test
 * is what keeps it that way.
 *
 * WHY A TEST ABOUT IMPORTS
 *
 * The worst defect in this feature was not a wrong value, it was two routes to
 * the same outcome. The consent dialog promised, in so many words, "faces are
 * not matched, and no other AI feature is started". The repair button two
 * inches away went through the per-camera LIFECYCLE route with
 * `buildEnablePayload`, which carries `faceRecognition: ai.faceRecognition
 * !== false` -- TRUE for a camera that has never been configured. So the
 * button started face recognition and spent a face licence, while the dialog
 * promised the opposite. Both call sites were individually correct. Nothing
 * was testing that they agreed.
 *
 * Fixing the button fixed that instance. It did not stop the next person
 * reaching for the obvious helper, because the only thing standing in the way
 * was a comment. So:
 *
 *   The master AI switch is turned on from this module through ONE door --
 *   aiService.setHeadcount with `enableAi: true` -- which is the endpoint that
 *   applies masterOnForFeature: master on, face explicitly off, nothing else
 *   started. Reaching for the lifecycle route here fails this test.
 *
 * It is a source-text test, which is unusual and deliberate: the rule is about
 * which code may exist, not about what a function returns, and there is no
 * value to assert. The cost of that is listed at the bottom.
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
const FORBIDDEN = [
  {
    needle: 'updateCameraAiLifecycle',
    why: 'the Camera Setup lifecycle route decides the face flag from stored '
      + 'settings, where ABSENT MEANS ON — so it starts face recognition on a '
      + 'camera that has never been configured, and spends a face licence. '
      + 'Use aiService.setHeadcount({ enableAi: true }).',
  },
  {
    needle: 'buildEnablePayload',
    why: 'it carries `faceRecognition: ai.faceRecognition !== false`, which is '
      + 'true for an unconfigured camera. This is the exact line that made the '
      + 'consent dialog\'s promise false. Use aiService.setHeadcount({ enableAi: true }).',
  },
];

test('no file in this module reaches for the lifecycle route', () => {
  const offences = [];
  for (const { file, text } of sources()) {
    for (const { needle, why } of FORBIDDEN) {
      // Comments are allowed to NAME it — the fix's own comment explains why
      // the lifecycle route was wrong, and that explanation is worth keeping.
      // Only real code counts, so comment lines are stripped first.
      const code = text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      if (code.includes(needle)) offences.push(`${file} uses ${needle}: ${why}`);
    }
  }
  assert.deepEqual(offences, [], `\n${offences.join('\n\n')}\n`);
});

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
 * WHAT THIS TEST COSTS, SO THE NEXT PERSON CAN JUDGE IT
 *
 * It reads source text, so it is blind to anything indirect: a re-export, a
 * dynamic import, a helper in another module that calls the lifecycle route on
 * this module's behalf. It is a tripwire on the obvious mistake, not a proof.
 *
 * It also fails if the files are renamed, which is the intended trade: the rule
 * should be re-read when the module is restructured, not silently carried over.
 *
 * If this module ever legitimately needs the lifecycle route -- to switch AI
 * OFF, say, which has none of these problems -- add the call and the exemption
 * in the same commit, with the reason. Deleting the test to make it pass is
 * deleting the only thing holding the promise up.
 */
