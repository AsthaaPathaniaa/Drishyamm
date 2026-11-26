// Smart Skim (I-6) helpers: where to jump when only activity should play.
// Segments are [startIso, endIso] busy stretches from /api/investigate/activity.

/** Segments as numbers (ms), sorted. */
export function toRanges(segments = []) {
  return segments.map(([a, b]) => [Date.parse(a), Date.parse(b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
}

/**
 * Where the playhead should be at `t` when skimming: `t` itself inside a busy
 * stretch, else the start of the next one, else null (nothing left to play).
 */
export function skimTarget(ranges, t) {
  for (const [a, b] of ranges) {
    if (t < a) return a;
    if (t <= b) return t;
  }
  return null;
}

/** How much footage skimming plays vs the whole span, for "1 h 40 min in 4 min". */
export function skimTotals(ranges, start, end) {
  let busy = 0;
  for (const [a, b] of ranges) busy += Math.max(0, Math.min(b, end) - Math.max(a, start));
  return { busyMs: busy, spanMs: Math.max(0, end - start) };
}

/** 0..1 shade per bin for the density row (0 = nobody). */
export function shades(bins = []) {
  const max = Math.max(0, ...bins);
  return bins.map((c) => (max ? (c ? 0.25 + 0.75 * (c / max) : 0) : 0));
}
