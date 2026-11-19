/**
 * Restricted zones — the page's pure logic: date ranges, shifts, the clip
 * window and the detection box. No React, no network, so every rule here is
 * unit-tested (breach-model.test.js).
 *
 * Time is India time throughout (IST, UTC+05:30), whatever the browser is set
 * to: a shift, an hour-of-day bucket and a "Today" all mean the site's clock.
 *
 * Two things USED to live here and no longer do, because the server owns
 * them: the trend rollups (now GET /ai/zone-breaches/trends, counted in SQL
 * over the whole filtered range rather than over the page the browser holds)
 * and the resolution store (now resolved_at / resolved_by on the event, so a
 * breach one operator closes out is closed for everyone).
 *
 * SHIFTS is the copy the server mirrors — see backend/src/utils/aiEventFilters.js.
 */

const IST_MS = 330 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── Date range ──────────────────────────────────────────────────────────────

export const RANGE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24h' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom range' },
];

/** Epoch ms of IST midnight on the day that contains `ms`. */
export const istMidnight = (ms) => Math.floor((ms + IST_MS) / DAY) * DAY - IST_MS;

/** "YYYY-MM-DD" (an IST calendar day) → epoch ms of its IST midnight, or null. */
export function istDayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - IST_MS : null;
}

/** Epoch ms → "YYYY-MM-DD" in IST. */
export const istYmd = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

/**
 * The window a range covers, as epoch ms. `until` is null for "up to now", so
 * the request stays open-ended and a breach from this minute still lands.
 * @param {{ preset: string, from?: string, to?: string }} range  from/to are IST days, inclusive
 */
export function rangeWindow(range, now = Date.now()) {
  switch (range.preset) {
    case '24h': return { since: now - DAY, until: null };
    case '7d': return { since: istMidnight(now) - 6 * DAY, until: null };
    case '30d': return { since: istMidnight(now) - 29 * DAY, until: null };
    case 'custom': {
      let a = istDayStart(range.from) ?? istMidnight(now);
      let b = istDayStart(range.to) ?? istMidnight(now);
      if (b < a) [a, b] = [b, a];
      const end = b + DAY;
      return { since: a, until: end > now ? null : end };
    }
    default: return { since: istMidnight(now), until: null };
  }
}

// ── Shifts ──────────────────────────────────────────────────────────────────
// A shift narrows the range to hours of the day, on every day in it: "night
// shift, last 7 days" is seven nights. Hours are IST; a shift may wrap
// midnight (end < start).

export const SHIFTS = [
  { id: 'all', label: 'All shifts', hours: null },
  { id: 'morning', label: 'Morning (06:00–14:00)', short: 'Morning', hours: [6, 14] },
  { id: 'evening', label: 'Evening (14:00–22:00)', short: 'Evening', hours: [14, 22] },
  { id: 'night', label: 'Night (22:00–06:00)', short: 'Night', hours: [22, 6] },
];

/** Hour of the day, 0–23, in IST. */
export const istHour = (ms) => new Date(ms + IST_MS).getUTCHours();

export function inShift(ms, shiftId) {
  const shift = SHIFTS.find((s) => s.id === shiftId);
  if (!shift?.hours) return true;
  const [start, end] = shift.hours;
  const h = istHour(ms);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** The label the range button shows: "Today", "Last 7 days · Night". */
export function rangeLabel(range) {
  const base = range.preset === 'custom'
    ? `${range.from || '…'} → ${range.to || '…'}`
    : (RANGE_PRESETS.find((p) => p.id === range.preset) || RANGE_PRESETS[0]).label;
  const shift = SHIFTS.find((s) => s.id === range.shift);
  return shift?.short ? `${base} · ${shift.short}` : base;
}

// ── Detection box ───────────────────────────────────────────────────────────

/** [x1, y1, x2, y2] from any of the shapes the feed uses, or null. */
export function readBbox(evt) {
  const b = evt?.bbox || evt?.payload?.bbox || evt?.payload?.box || null;
  if (Array.isArray(b) && b.length >= 4) {
    const arr = b.slice(0, 4).map(Number);
    return arr.every(Number.isFinite) ? arr : null;
  }
  if (b && typeof b === 'object') {
    const arr = [b.x1 ?? b.left ?? b.x, b.y1 ?? b.top ?? b.y, b.x2 ?? b.right, b.y2 ?? b.bottom].map(Number);
    if (!Number.isFinite(arr[2]) && Number.isFinite(Number(b.w ?? b.width))) arr[2] = arr[0] + Number(b.w ?? b.width);
    if (!Number.isFinite(arr[3]) && Number.isFinite(Number(b.h ?? b.height))) arr[3] = arr[1] + Number(b.h ?? b.height);
    return arr.every(Number.isFinite) ? arr : null;
  }
  return null;
}

/** The inference frame's size, when the event says. */
export function readFrame(evt) {
  const p = evt?.payload || {};
  const w = Number(p.frame_w ?? p.frameW ?? evt?.frame_w);
  const h = Number(p.frame_h ?? p.frameH ?? evt?.frame_h);
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The box in the pixel space of an image `img` ({ w, h }). A normalised box
 * (every value ≤ 1) scales by the image; a pixel box scales from the
 * inference frame when it differs from the image.
 */
export function boxInImage(bbox, frame, img) {
  if (!bbox || !img?.w || !img?.h) return null;
  if (bbox.every((v) => v >= 0 && v <= 1)) {
    const [x1, y1, x2, y2] = bbox;
    return [x1 * img.w, y1 * img.h, x2 * img.w, y2 * img.h];
  }
  const sx = frame ? img.w / frame.w : 1;
  const sy = frame ? img.h / frame.h : 1;
  const [x1, y1, x2, y2] = bbox;
  return [x1 * sx, y1 * sy, x2 * sx, y2 * sy];
}

// ── Clip ────────────────────────────────────────────────────────────────────

/** The recording around a breach: 15 s before to 45 s after, never past now. */
export function clipWindow(whenMs, now = Date.now()) {
  return { start: whenMs - 15_000, end: Math.min(whenMs + 45_000, now) };
}
