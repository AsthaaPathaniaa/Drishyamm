import test from 'node:test';
import assert from 'node:assert/strict';

import { auditText, canEdit, itemFrom, timeline } from './case-model.js';

test('a search result becomes a person item', () => {
  const it = itemFrom.searchResult({ track_id: 't', camera_code: 'm1', camera_name: 'Gate 3', first_seen: 'a', last_seen: 'b', score: 0.8 });
  assert.deepEqual(it, { type: 'track', trackId: 't', monitorId: 'm1', from: 'a', to: 'b', score: 0.8, title: 'Person on Gate 3' });
});

test('a journey item spans its stops and is titled by its route', () => {
  const it = itemFrom.journey({ track_id: 's' }, [{ first_seen: '1' }, { last_seen: '9' }], ['Gate 3', 'Lobby']);
  assert.equal(it.title, 'Gate 3 → Lobby');
  assert.equal(it.from, '1');
  assert.equal(it.to, '9');
});

test('timeline orders by when things happened, not when they were pinned', () => {
  const t = timeline([{ id: 'b', from: '2026-11-24T10:05:00Z' }, { id: 'a', from: '2026-11-24T10:00:00Z' }, { id: 'n' }]);
  assert.deepEqual(t.map((i) => i.id), ['a', 'b']);
});

test('roles and audit wording', () => {
  assert.equal(canEdit('viewer'), false);
  assert.equal(canEdit('editor'), true);
  assert.equal(auditText('legal_hold_on'), 'turned legal hold on');
  assert.equal(auditText('something_new'), 'something new');
});
