/**
 * Tests for who a zone-intrusion row says was in the zone (intruders.js).
 *
 * The point of the change these cover: the detector knew the name — it had
 * just checked it against the zone's allow-list — and threw it away, so every
 * breach read "1 person". The three states that matter are "recognised",
 * "there but not recognised", and "we never recorded names at all", and the
 * last two must not look the same.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { intruderText, intruders } from './intruders.js';

/** A normalized event as the table receives it. */
const row = (payload, over = {}) => ({
  type: 'zone.intrusion',
  count: payload?.count ?? null,
  raw: { payload },
  ...over,
});

test('one recognised and one unknown person reads as the name plus the tally', () => {
  const evt = row({ zoneName: 'Switch room', count: 2, names: ['Asha Patel'], unidentified: 1 });
  assert.equal(intruderText(evt), 'Asha Patel + 1 unidentified');
  assert.deepEqual(intruders(evt), { names: ['Asha Patel'], unidentified: 1, recorded: true });
});

test('everyone recognised: just the names, in the order the detector gave them', () => {
  assert.equal(
    intruderText(row({ count: 2, names: ['Asha Patel', 'Ravi Kumar'], unidentified: 0 })),
    'Asha Patel, Ravi Kumar',
  );
});

test('nobody recognised reads as a tally, not as an empty cell', () => {
  assert.equal(intruderText(row({ count: 3, names: [], unidentified: 3 })), '3 unidentified');
});

test('an older row has no names recorded, so it still shows its head count', () => {
  // Rows written before the engine collected names carry only the count and
  // the generated "3 persons" sentence. An empty cell would read as "nobody".
  const old = row({ zoneName: 'Dock', count: 3, matchedName: '3 persons' });
  assert.equal(intruderText(old), '3 people');
  assert.equal(intruders(old).recorded, false);
  assert.equal(intruderText(row({ count: 1, matchedName: '1 person' })), '1 person');
});

test('"3 persons" is a head count, never a name', () => {
  assert.deepEqual(intruders(row({ count: 3, matchedName: '3 persons' })).names, []);
  assert.equal(intruderText(row({ count: 3, names: ['3 persons'], unidentified: 0 })), '3 people');
});

test('"Unknown" is a label the face stage emits, not a person', () => {
  assert.equal(intruderText(row({ count: 2, names: ['Unknown'], unidentified: 1 })), '1 unidentified');
  assert.deepEqual(intruders(row({ count: 1, names: ['unknown'] })).names, []);
});

test('the same person matched twice in a frame is named once', () => {
  assert.equal(
    intruderText(row({ count: 2, names: ['Asha Patel', 'Asha Patel'], unidentified: 0 })),
    'Asha Patel',
  );
});

test('names are trimmed, and blanks are dropped rather than printed as commas', () => {
  assert.equal(
    intruderText(row({ count: 2, names: ['  Asha Patel ', '', null, '   '], unidentified: 1 })),
    'Asha Patel + 1 unidentified',
  );
});

test('only zone intrusions carry this line — every other type is untouched', () => {
  for (const type of ['person.unknown', 'occupancy.threshold', 'tripwire.entry', 'vehicle.lpr']) {
    assert.equal(intruderText(row({ count: 4, names: ['Asha Patel'] }, { type })), null);
  }
});

test('a row with nothing to say says nothing', () => {
  assert.equal(intruderText(row({ zoneName: 'Dock' })), null);
  assert.equal(intruderText(row({ count: 0, names: [], unidentified: 0 })), null);
  assert.equal(intruderText({ type: 'zone.intrusion' }), null);
  assert.equal(intruderText(null), null);
});

test('a payload that arrives at the top level reads the same', () => {
  // Some callers hand the stored row straight in rather than its `raw`.
  assert.equal(
    intruderText({ type: 'zone.intrusion', payload: { names: ['Ravi Kumar'], unidentified: 2 } }),
    'Ravi Kumar + 2 unidentified',
  );
});
