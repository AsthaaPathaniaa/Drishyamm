/**
 * no-entry.js — what the Event Log does differently as the No-entry page.
 *
 * There used to be two tables. Zone Breaches (/occupancy/breaches) read the
 * same `GET /ai/events` feed as this log, mixed unrecognised faces and
 * loitering in with real zone intrusions, and stopped at the route's 200-row
 * ceiling — so "who got into a restricted area this week" was a question it
 * could not answer, while the Event Log next door already had the filters, the
 * evidence panel, acknowledge, bulk acknowledge and the exports.
 *
 * So there is one table now, in two modes. This file is the whole of the
 * difference that is worth testing: the locked event type, the translation
 * from this page's filter vocabulary into the server's, and the paging
 * arithmetic the exports depend on.
 *
 * Pure (no React, no '@/' imports) so `npm test` can check it — the shift
 * windows come from breach-model by relative path, because they are the ones
 * the old page used and the server now applies.
 */

import { SHIFTS } from '../../occupancy/breaches/breach-model.js';

export const NO_ENTRY_MODE = 'no-entry';

/**
 * The one event type this mode shows. A restricted-zone entry is a person
 * somewhere they are not allowed to be; an unrecognised face at reception is
 * not, and belongs on Activity history with everything else.
 */
export const NO_ENTRY_TYPE = 'zone.intrusion';

/** `GET /ai/zone-breaches` refuses a larger page than this. */
export const SERVER_PAGE_MAX = 100;

/**
 * Rows a PDF export will load. A PDF is a fixed-length document somebody
 * reads or files; past about a thousand rows it is neither, and the CSV —
 * which the server streams uncapped — is the honest answer. The file says so
 * when it is cut (see `pdfOverflowNote`).
 */
export const PDF_ROW_LIMIT = 1000;

export const isNoEntry = (mode) => mode === NO_ENTRY_MODE;

/** The shift choices, including "All shifts". Hours are IST. */
export const SHIFT_OPTIONS = SHIFTS.map((s) => ({ id: s.id, label: s.label }));

// This page grades events high / medium / info (the AI vocabulary in
// event-model.js); the `ai_events` column is an enum of info / warning /
// critical. Same three levels, two spellings, mapped in one place.
const SEVERITY_OUT = { high: 'critical', medium: 'warning', info: 'info' };

// The log says a row is "new" until a human has seen it; the server says the
// breach is "open" until it is acknowledged. Same three states, two
// spellings. `resolved` is a real server state now (resolved_at on the
// event), so filtering by it returns the same rows for every operator.
const STATUS_OUT = { new: 'open', acknowledged: 'acknowledged', resolved: 'resolved' };

/** The status choices the No-entry page offers, in the order they happen. */
export const STATUS_OPTIONS = [
  { id: 'all', label: 'All Statuses' },
  { id: 'new', label: 'Open' },
  { id: 'acknowledged', label: 'Acknowledged' },
  { id: 'resolved', label: 'Resolved' },
];

/**
 * The cameras a request should be limited to, or `null` for no limit.
 *
 * The server has one camera filter (`monitorIds`), and this page has two
 * controls that narrow by camera: Site and Camera. A chosen camera is the
 * narrower of the two, so it wins outright; otherwise the site contributes
 * every camera in it.
 *
 * An EMPTY array is meaningful and is not the same as `null`: it says a site
 * was chosen that contains no cameras, so nothing can match. See
 * `scopeIsEmpty` — sending no filter there would show the whole estate.
 *
 * @param {{ camera?: string, siteCodes?: Set<string>|string[]|null }} o
 * @returns {string[]|null}
 */
export function monitorIdsFor({ camera, siteCodes } = {}) {
  if (camera && camera !== 'all') return [camera];
  if (siteCodes) return [...siteCodes].filter(Boolean);
  return null;
}

/** True when the scope can match nothing at all, so no request is worth making. */
export const scopeIsEmpty = (monitorIds) => Array.isArray(monitorIds) && monitorIds.length === 0;

/**
 * This page's filter state as the query `GET /ai/zone-breaches` expects.
 *
 * Everything the operator can narrow by goes to the server, because the server
 * is what pages: a filter applied in the browser would narrow the page on
 * screen and leave the count, the page numbers and the exports describing a
 * different set of rows.
 *
 * `since`/`until` are ISO strings — the caller owns the local-day arithmetic
 * (log-model's startOfDay / endOfDay), so this stays free of '@/' imports.
 *
 * @param {object} o
 * @param {string} [o.since]        ISO 8601
 * @param {string} [o.until]        ISO 8601
 * @param {string[]|null} [o.monitorIds]
 * @param {string} [o.zoneId]       a RestrictedZone id, or 'all'
 * @param {string} [o.severity]     high | medium | info | all
 * @param {string} [o.status]       new | acknowledged | all
 * @param {string} [o.shift]        morning | evening | night | all
 * @param {string} [o.query]        free text
 */
export function zoneBreachParams({
  since, until, monitorIds, zoneId, severity, status, shift, query, page = 1, pageSize = 25,
} = {}) {
  const out = {
    page: Math.max(1, Number(page) || 1),
    pageSize: Math.min(SERVER_PAGE_MAX, Math.max(1, Number(pageSize) || 25)),
  };
  if (since) out.since = since;
  if (until) out.until = until;
  if (Array.isArray(monitorIds) && monitorIds.length) out.monitorIds = monitorIds.join(',');
  if (zoneId && zoneId !== 'all') out.zoneId = zoneId;
  if (SEVERITY_OUT[severity]) out.severity = SEVERITY_OUT[severity];
  if (STATUS_OUT[status]) out.status = STATUS_OUT[status];
  if (shift && shift !== 'all' && shift !== undefined) out.shift = shift;
  const q = String(query || '').trim();
  if (q) out.q = q;
  return out;
}

/**
 * The same filters without the page, for an export.
 *
 * An export covers the whole filtered range, so carrying the page the
 * operator happens to be on is at best noise and at worst a future server
 * that honours it and returns 25 rows of a 500-row month.
 */
export function exportParams(params = {}) {
  const rest = { ...params };
  delete rest.page;
  delete rest.pageSize;
  return rest;
}

/**
 * The pages a PDF export has to fetch, in order.
 *
 * The server caps a page at 100 rows, so a thousand-row report is ten
 * requests. An empty range is no requests at all.
 */
export function pdfPagePlan(total, limit = PDF_ROW_LIMIT, size = SERVER_PAGE_MAX) {
  const want = Math.max(0, Math.min(Number(total) || 0, limit));
  return Array.from({ length: Math.ceil(want / size) }, (_, i) => i + 1);
}

/**
 * The line a cut-short PDF carries, or null when it holds the whole range.
 * It names both numbers and points at the export that has no ceiling.
 */
export function pdfOverflowNote(total, shown) {
  const all = Number(total) || 0;
  const got = Number(shown) || 0;
  if (all <= got) return null;
  return `Showing the newest ${got.toLocaleString()} of ${all.toLocaleString()} breaches matching these filters. `
    + 'Export as CSV for the complete range.';
}

/** `zone-breaches-2026-11-10` / `…_to_2026-11-17` — the saved file's name. */
export function exportName(from, to) {
  return `zone-breaches-${from}${to && to !== from ? `_to_${to}` : ''}`;
}
