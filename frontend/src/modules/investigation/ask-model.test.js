import test from 'node:test';
import assert from 'node:assert/strict';

import { langOf, splitCitations } from './ask-model.js';

test('citations split out of the answer text', () => {
  assert.deepEqual(splitCitations('Seen at 10:00 [2][3]. Done.'), [
    { text: 'Seen at 10:00 ' }, { ref: 2 }, { ref: 3 }, { text: '. Done.' },
  ]);
  assert.deepEqual(splitCitations('No refs'), [{ text: 'No refs' }]);
  assert.deepEqual(splitCitations(''), []);
});

test('voice language follows the script', () => {
  assert.equal(langOf('कल रात कितने लोग आए?'), 'hi-IN');
  assert.equal(langOf('how many people'), 'en-IN');
});
