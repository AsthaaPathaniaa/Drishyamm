// Pure helpers for the Smart Search page: URL state (so a search is a link
// you can share or come back to), chip removal, and how a result is labelled
// and opened in Recordings. No React, no network: tested in search-model.test.js.

export const CHIP_KINDS = ['object_class', 'camera', 'time', 'top_colour', 'bottom_colour', 'vehicle_type', 'vehicle_colour', 'gender'];
const PRE_ROLL_MS = 10_000;
const POST_ROLL_MS = 10_000;

/**
 * URLSearchParams → { q, clear, cams, unknown }.
 * `cams`: cameras picked by hand (a "did you mean" suggestion), replacing the
 * ones read from the text. `unknown`: also show people whose colour couldn't be read.
 */
export function readSearchState(params) {
  const q = (params.get('q') || '').slice(0, 300);
  const clear = (params.get('clear') || '').split(',').filter((k) => CHIP_KINDS.includes(k));
  const cams = (params.get('cams') || '').split(',').filter((c) => /^[\w:.-]{1,64}$/.test(c)).slice(0, 50);
  const unknown = params.get('unknown') === '1';
  return { q, clear, cams, unknown };
}

/** { q, clear, cams, unknown } → URLSearchParams (empty values left out). */
export function writeSearchState({ q, clear = [], cams = [], unknown = false }) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  const kinds = [...new Set(clear)].filter((k) => CHIP_KINDS.includes(k));
  if (kinds.length) p.set('clear', kinds.join(','));
  if (cams.length) p.set('cams', [...new Set(cams)].join(','));
  if (unknown) p.set('unknown', '1');
  return p;
}

/** Removing a chip adds its kind to `clear` (a camera chip also drops hand-picked cameras). */
export function removeChip(state, kind) {
  return { ...state, clear: [...new Set([...(state.clear || []), kind])], ...(kind === 'camera' ? { cams: [] } : {}) };
}

/** The overrides a search sends for this URL state. */
export function searchOverrides({ clear = [], cams = [], unknown = false } = {}) {
  return {
    clear,
    ...(cams.length ? { camera_codes: cams } : {}),
    ...(unknown ? { include_unknown_colour: true } : {}),
  };
}

/** "Everyone, newest first" results (nothing described): no match score to show. */
export const isBrowse = (data) => !!data?.parsed?.browse || (data?.results?.length > 0 && data.results.every((r) => r.score == null));

/** The chips to show: the parse minus what the user removed. */
export function visibleChips(parsed, clear = []) {
  return (parsed?.chips || []).filter((c) => !clear.includes(c.kind));
}

/**
 * The badge on a result. Text searches: how well the description fits, beyond
 * "a person" (the AI's `match`); raw percentages there meant nothing (every
 * result read 100% on the testing server). Photo searches keep the percentage:
 * photo-to-photo similarity is a real number. Nothing to show → null.
 */
export function matchBadge(r, { photo = false } = {}) {
  if (photo) return r?.score != null ? `${scoreLabel(r.score)} match` : null;
  return { strong: 'Strong match', good: 'Good match', possible: 'Possible match' }[r?.match] || null;
}

/** "92%" for a score in 0..1. */
export function scoreLabel(score) {
  const n = Math.round(Math.max(0, Math.min(1, Number(score) || 0)) * 100);
  return `${n}%`;
}

/** Results grouped by camera, best first, for "seen on N cameras". */
export function summarise(results = []) {
  const cams = new Map();
  for (const r of results) {
    const k = r.camera_code || r.camera_id;
    cams.set(k, (cams.get(k) || 0) + 1);
  }
  return { count: results.length, cameras: cams.size };
}

/** Imported video (I-7)? Its results play from the uploaded file, not the recorder. */
export const isImported = (code) => typeof code === 'string' && code.startsWith('file:');

/** Recordings link for a result: its camera, from 10 s before to 10 s after.
 *  An imported video opens its own player at that moment instead. */
export function playbackLink(r) {
  if (isImported(r.camera_code)) {
    return `/investigate/imports/${encodeURIComponent(r.camera_code.slice(5))}?at=${encodeURIComponent(r.first_seen)}`;
  }
  const first = new Date(r.first_seen).getTime();
  const last = new Date(r.last_seen || r.first_seen).getTime();
  const qs = new URLSearchParams({
    monitor: r.camera_code || '',
    from: new Date(first - PRE_ROLL_MS).toISOString(),
    to: new Date(last + POST_ROLL_MS).toISOString(),
  });
  return `/playback?${qs}`;
}

/** "Mon 24 Nov, 1:42 pm · 18 s" in the viewer's own time zone. */
export function whenLabel(r, locale = undefined) {
  const first = new Date(r.first_seen);
  const secs = Math.max(0, Math.round((new Date(r.last_seen || r.first_seen) - first) / 1000));
  const day = first.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = first.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const dur = secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs} s`;
  return `${day}, ${time} · ${dur}`;
}

/** What the colour line says. Night (IR) footage has no colour. */
export function colourLabel(r) {
  if (r.ir) return 'Colour not available (night)';
  const a = r.attributes || {};
  if (r.object_class === 'vehicle') {
    return [a.vehicle_colour, a.vehicle_type].filter(Boolean).join(' ') || 'vehicle';
  }
  const parts = [];
  if (a.top_colour) parts.push(`${a.top_colour} top`);
  if (a.bottom_colour) parts.push(`${a.bottom_colour} bottom`);
  return parts.join(', ');
}

/** "ask not what your [country] can do" → [{ text }, { hit }] for highlighting the searched words. */
export function highlight(text = '', query = '') {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return [{ text }];
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${esc.join('|')})`, 'gi');
  return text.split(re).filter(Boolean).map((part) => (words.includes(part.toLowerCase()) ? { hit: part } : { text: part }));
}
