/**
 * intruders.js — who was in the zone, in words.
 *
 * A restricted-zone alert used to be able to say only "1 person": the detector
 * knew the name (it had just checked it against the zone's allow-list) and
 * then discarded it. It now records the people it matched in the frame that
 * fired the alert, as `payload.names`, with a tally of the ones it could not
 * name as `payload.unidentified`.
 *
 * Three states, and the difference between the last two matters:
 *
 *   names recorded, some matched    "Asha Patel + 1 unidentified"
 *   names recorded, none matched    "2 unidentified"
 *   NO names recorded (older row)   "3 people" — the head count, which is all
 *                                   that was stored. An empty cell here would
 *                                   read as "nobody was there".
 *
 * A name appears only because that camera recognised that face at that moment.
 * Nothing here infers one from another camera or an earlier sighting.
 *
 * Pure (no React, no '@/' imports) so `npm test` can check it. Mirrors
 * peopleText in backend/src/controllers/ai.controller.js, which writes the
 * same sentence into the CSV.
 */

const ZONE_INTRUSION = 'zone.intrusion';

// What the face stage emits for a detection it could not match: a label, not a
// person. It counts as unidentified, and is never printed as a name.
const UNKNOWN = /^unknown$/i;

// What the engine writes when it has no identity to report. It is the head
// count, which has its own place, so it is not a name.
const GENERATED = /^\s*\d+\s+persons?\s*$/i;

/** The payload the row was built from, whichever shape reached the UI. */
function payloadOf(evt) {
  const p = evt?.raw?.payload ?? evt?.payload;
  return p && typeof p === 'object' ? p : {};
}

/**
 * The recognised names on a row, the count it could not name, and whether the
 * row carries that record at all.
 *
 * @returns {{ names: string[], unidentified: number, recorded: boolean }}
 */
export function intruders(evt) {
  const p = payloadOf(evt);
  const raw = p.names ?? p.matchedNames;
  const recorded = Array.isArray(raw) || Number.isFinite(Number(p.unidentified));
  const names = [...new Set((Array.isArray(raw) ? raw : [])
    .map((n) => (n === null || n === undefined ? '' : String(n).trim()))
    .filter((n) => n && !UNKNOWN.test(n) && !GENERATED.test(n)))];
  const n = Number(p.unidentified);
  return { names, unidentified: Number.isFinite(n) && n > 0 ? n : 0, recorded };
}

/**
 * The line a zone-intrusion row shows for its people, or null when the row is
 * not a zone intrusion or has nothing to say. Every other event type is
 * untouched — this is only the vocabulary of a restricted-zone entry.
 */
export function intruderText(evt) {
  if (evt?.type !== ZONE_INTRUSION) return null;
  const { names, unidentified } = intruders(evt);
  if (names.length && unidentified) return `${names.join(', ')} + ${unidentified} unidentified`;
  if (names.length) return names.join(', ');
  if (unidentified) return `${unidentified} unidentified`;
  // An older row: the head count is the whole of what was stored.
  const p = payloadOf(evt);
  const count = Number(evt?.count ?? p.count);
  if (Number.isFinite(count) && count > 0) return `${count} ${count === 1 ? 'person' : 'people'}`;
  return null;
}
