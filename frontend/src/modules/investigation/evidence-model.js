// Pure helpers for evidence export (tested in evidence-model.test.js).

export const REASON_MIN = 10;
export const MAX_RANGE_MS = 30 * 60 * 1000;

/** A problem with the request, or null when it can be sent. */
export function exportProblem({ start, end, reason }, now = Date.now()) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 'Choose a start and an end.';
  if (e <= s) return 'The end must be after the start.';
  if (e - s > MAX_RANGE_MS) return 'An evidence pack can cover at most 30 minutes.';
  if (e > now) return "The end hasn't been recorded yet.";
  if ((reason || '').trim().length < REASON_MIN) return `Say why this footage is being exported (at least ${REASON_MIN} characters).`;
  return null;
}

/** Value for <input type="datetime-local"> in the viewer's own time zone. */
export function toLocalInput(d) {
  const t = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

/** Range around a Smart Search result: 10 s before it appears to 10 s after it leaves. */
export function rangeAround(result, padMs = 10_000) {
  const s = new Date(result.first_seen).getTime() - padMs;
  const e = new Date(result.last_seen || result.first_seen).getTime() + padMs;   // the dialog clamps to what's recorded
  return { start: new Date(s), end: new Date(e) };
}

export function sizeLabel(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** One-line verdict for a verify result. */
export function verdict(r) {
  if (!r) return null;
  if (r.ok && r.madeHere) return { tone: 'ok', text: 'Intact and signed by this account. Nothing in the pack has changed since it was exported.' };
  if (r.ok) return { tone: 'ok', text: 'Intact and correctly signed, but by a key this account does not use: it was made somewhere else.' };
  if (r.error) return { tone: 'bad', text: `Not a valid evidence pack: ${r.error}` };
  if (!r.signatureOk) return { tone: 'bad', text: 'The signature does not match: the manifest was changed, or signed by someone else.' };
  const bad = (r.files || []).filter((f) => !f.ok).map((f) => f.path);
  const parts = [];
  if (bad.length) parts.push(`changed: ${bad.join(', ')}`);
  if (r.missing?.length) parts.push(`missing: ${r.missing.join(', ')}`);
  if (r.unlisted?.length) parts.push(`added: ${r.unlisted.join(', ')}`);
  return { tone: 'bad', text: `The pack has been altered (${parts.join('; ')}).` };
}
