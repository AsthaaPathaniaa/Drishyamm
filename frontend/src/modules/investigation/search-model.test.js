import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readSearchState, writeSearchState, removeChip, visibleChips, scoreLabel, summarise, playbackLink, colourLabel, highlight, searchOverrides, isBrowse, matchBadge,
} from './search-model.js';

test('search state round-trips through the URL and drops unknown chip kinds', () => {
  const p = writeSearchState({ q: 'red top, gate 3', clear: ['time', 'time', 'bogus'] });
  assert.equal(p.toString(), 'q=red+top%2C+gate+3&clear=time');
  assert.deepEqual(readSearchState(p), { q: 'red top, gate 3', clear: ['time'], cams: [], unknown: false });
  assert.equal(writeSearchState({ q: '' }).toString(), '');
});

test('removing a chip hides it and is remembered', () => {
  const parsed = { chips: [{ kind: 'time', label: '1 PM – 4 PM' }, { kind: 'top_colour', label: 'Red top' }] };
  const s = removeChip({ q: 'x', clear: [] }, 'time');
  assert.deepEqual(s.clear, ['time']);
  assert.deepEqual(visibleChips(parsed, s.clear).map((c) => c.kind), ['top_colour']);
});

test('score label is a clamped percentage', () => {
  assert.equal(scoreLabel(0.914), '91%');
  assert.equal(scoreLabel(3), '100%');
  assert.equal(scoreLabel(undefined), '0%');
});

test('summary counts cameras once', () => {
  assert.deepEqual(summarise([{ camera_code: 'a' }, { camera_code: 'a' }, { camera_code: 'b' }]), { count: 3, cameras: 2 });
});

test('a result opens Recordings on its camera with 10 s either side', () => {
  const url = playbackLink({ camera_code: 'm1', first_seen: '2026-11-24T08:00:00Z', last_seen: '2026-11-24T08:00:20Z' });
  const p = new URLSearchParams(url.split('?')[1]);
  assert.equal(p.get('monitor'), 'm1');
  assert.equal(p.get('from'), '2026-11-24T07:59:50.000Z');
  assert.equal(p.get('to'), '2026-11-24T08:00:30.000Z');
});

test('an imported video plays in its own player at that moment', () => {
  assert.equal(playbackLink({ camera_code: 'file:abc', first_seen: '2018-05-09T15:45:40Z' }),
    '/investigate/imports/abc?at=2018-05-09T15%3A45%3A40Z');
});

test('vehicles show their colour and type', () => {
  assert.equal(colourLabel({ object_class: 'vehicle', attributes: { vehicle_colour: 'white', vehicle_type: 'car' } }), 'white car');
  assert.equal(colourLabel({ object_class: 'vehicle', attributes: {} }), 'vehicle');
});

test('night tracks say colour is not available', () => {
  assert.equal(colourLabel({ ir: true, attributes: { top_colour: 'red' } }), 'Colour not available (night)');
  assert.equal(colourLabel({ attributes: { top_colour: 'red', bottom_colour: 'blue' } }), 'red top, blue bottom');
});

test('searched words are highlighted, any case', () => {
  assert.deepEqual(highlight('Ask what your Country can do', 'country ask'), [
    { hit: 'Ask' }, { text: ' what your ' }, { hit: 'Country' }, { text: ' can do' },
  ]);
  assert.deepEqual(highlight('नमस्ते दुनिया', 'दुनिया'), [{ text: 'नमस्ते ' }, { hit: 'दुनिया' }]);
});

test('URL state keeps hand-picked cameras and "show unread colours", and drops junk', () => {
  const st = readSearchState(new URLSearchParams('q=movement+at+gate+7&cams=fe26,abc:1&unknown=1&clear=gender,nope'));
  assert.deepEqual(st, { q: 'movement at gate 7', clear: ['gender'], cams: ['fe26', 'abc:1'], unknown: true });
  assert.equal(writeSearchState(st).toString(), 'q=movement+at+gate+7&clear=gender&cams=fe26%2Cabc%3A1&unknown=1');
  assert.deepEqual(readSearchState(new URLSearchParams('cams=<script>,ok')).cams, ['ok']);
  assert.equal(writeSearchState({ q: 'x' }).toString(), 'q=x');
});

test('removing the camera chip also forgets hand-picked cameras', () => {
  assert.deepEqual(removeChip({ q: 'x', clear: [], cams: ['a'] }, 'camera'), { q: 'x', clear: ['camera'], cams: [] });
  assert.deepEqual(removeChip({ q: 'x', clear: [], cams: ['a'] }, 'gender').cams, ['a']);
});

test('overrides sent with a search', () => {
  assert.deepEqual(searchOverrides({ clear: ['time'] }), { clear: ['time'] });
  assert.deepEqual(searchOverrides({ clear: [], cams: ['a'], unknown: true }), { clear: [], camera_codes: ['a'], include_unknown_colour: true });
  assert.deepEqual(searchOverrides(), { clear: [] });
});

test('browse results (nothing described) have no score to show', () => {
  assert.equal(isBrowse({ parsed: { browse: true }, results: [] }), true);
  assert.equal(isBrowse({ parsed: {}, results: [{ score: null }, { score: undefined }] }), true);
  assert.equal(isBrowse({ parsed: {}, results: [{ score: 0.5 }] }), false);
  assert.equal(isBrowse({ parsed: {}, results: [] }), false);
  assert.equal(isBrowse(null), false);
});

test('text results show a match label, never a fake percentage; photo results keep the percentage', () => {
  assert.equal(matchBadge({ match: 'strong', score: 1 }), 'Strong match');
  assert.equal(matchBadge({ match: 'good', score: 1 }), 'Good match');
  assert.equal(matchBadge({ match: 'possible', score: 0.2 }), 'Possible match');
  assert.equal(matchBadge({ match: null, score: 1 }), null);          // nothing described: no badge
  assert.equal(matchBadge({ score: null }), null);                     // browse
  assert.equal(matchBadge({ match: 'weird' }), null);
  assert.equal(matchBadge({ score: 0.83 }, { photo: true }), '83% match');
  assert.equal(matchBadge({ score: null }, { photo: true }), null);
  assert.equal(matchBadge(undefined), null);
});
