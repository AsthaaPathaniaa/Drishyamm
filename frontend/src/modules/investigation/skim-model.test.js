import test from 'node:test';
import assert from 'node:assert/strict';

import { shades, skimTarget, skimTotals, toRanges } from './skim-model.js';

const R = toRanges([['2026-11-24T10:00:10Z', '2026-11-24T10:00:20Z'], ['2026-11-24T10:05:00Z', '2026-11-24T10:05:30Z']]);
const at = (s) => Date.parse(`2026-11-24T10:${s}Z`);

test('inside a busy stretch the playhead stays; between them it jumps to the next', () => {
  assert.equal(skimTarget(R, at('00:15')), at('00:15'));
  assert.equal(skimTarget(R, at('00:25')), at('05:00'));
  assert.equal(skimTarget(R, at('00:00')), at('00:10'));
  assert.equal(skimTarget(R, at('06:00')), null);
});

test('totals say how much skimming saves', () => {
  assert.deepEqual(skimTotals(R, at('00:00'), at('10:00')), { busyMs: 40_000, spanMs: 600_000 });
});

test('density shades: empty bins clear, busiest full', () => {
  assert.deepEqual(shades([0, 2, 4]), [0, 0.625, 1]);
  assert.deepEqual(shades([0, 0]), [0, 0]);
});
