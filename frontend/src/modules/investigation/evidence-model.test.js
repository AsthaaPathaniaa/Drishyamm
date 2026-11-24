import test from 'node:test';
import assert from 'node:assert/strict';

import { exportProblem, rangeAround, sizeLabel, verdict } from './evidence-model.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const ok = { start: '2026-11-24T10:00:00Z', end: '2026-11-24T10:05:00Z', reason: 'theft at gate 3, FIR 123' };

test('export needs a real reason and a recorded range of at most 30 min', () => {
  assert.equal(exportProblem(ok, NOW), null);
  assert.match(exportProblem({ ...ok, reason: 'because' }, NOW), /why/);
  assert.match(exportProblem({ ...ok, end: '2026-11-24T09:00:00Z' }, NOW), /after/);
  assert.match(exportProblem({ ...ok, end: '2026-11-24T10:31:00Z' }, NOW), /30 minutes/);
  assert.match(exportProblem({ ...ok, end: '2026-11-24T13:00:00Z', start: '2026-11-24T12:50:00Z' }, NOW), /recorded/);
});

test('range around a result pads 10 s each side', () => {
  const r = rangeAround({ first_seen: '2026-11-24T08:00:00Z', last_seen: '2026-11-24T08:00:30Z' });
  assert.equal(r.start.toISOString(), '2026-11-24T07:59:50.000Z');
  assert.equal(r.end.toISOString(), '2026-11-24T08:00:40.000Z');
});

test('sizes read like a person would say them', () => {
  assert.equal(sizeLabel(512), '512 B');
  assert.equal(sizeLabel(1536), '1.5 KB');
  assert.equal(sizeLabel(48 * 1024 * 1024), '48 MB');
});

test('verdicts name what was changed', () => {
  assert.equal(verdict({ ok: true, madeHere: true }).tone, 'ok');
  assert.match(verdict({ ok: true, madeHere: false }).text, /somewhere else/);
  assert.match(verdict({ ok: false, signatureOk: false, files: [] }).text, /signature/);
  const v = verdict({ ok: false, signatureOk: true, files: [{ path: 'video/original.mp4', ok: false }], missing: [], unlisted: ['x.mp4'] });
  assert.equal(v.tone, 'bad');
  assert.match(v.text, /changed: video\/original\.mp4; added: x\.mp4/);
});
