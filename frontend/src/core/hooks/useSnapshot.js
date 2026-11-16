// Stills of a camera: the Monitor Wall editor's tiles, and the picture a zone
// editor falls back to when live doesn't play.
//
// One cache for the whole app session, shared by every tile and every mount,
// so paging through the wall or coming back to the page doesn't re-grab. The
// server also caches (60 s) and never runs more than one grab per recorder
// at a time; this side only caps requests in flight and paces refreshes.
//
// Offline cameras may be requested too: the server answers with the camera's
// saved picture (stale, dated) or a 409 { reason: 'never_connected' |
// 'expired', lastSeenAt }, which lands here as `error: 409` plus `reason` and
// `lastSeenAt`. Pages that only want live cameras' stills gate the call
// themselves (Camera health does).

import { useEffect, useSyncExternalStore } from 'react';
import api from '@/core/services/api';

const REFRESH_MS = 120_000;
const MAX_IN_FLIGHT = 3;

// monitorId → { url, at: Date, stale, fetchedAt, fromCache, error, reason, lastSeenAt }
const cache = new Map();
const pending = new Set();
const queue = [];
const listeners = new Set();
let active = 0;

const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// The 409 explains why there is no picture. The request asked for a blob, so
// the JSON body arrives as one.
async function errorBody(err) {
  const data = err?.response?.data;
  try {
    const parsed = data instanceof Blob ? JSON.parse(await data.text()) : data;
    return { reason: parsed?.reason || null, lastSeenAt: parsed?.lastSeenAt || null };
  } catch {
    return { reason: null, lastSeenAt: null };
  }
}

function pump() {
  while (active < MAX_IN_FLIGHT && queue.length) {
    const { id, cachedOnly } = queue.shift();
    const key = `${id}|${cachedOnly ? 'cached' : 'grab'}`;
    active += 1;
    api.get(`/stream/snapshot/${encodeURIComponent(id)}`, {
      responseType: 'blob', timeout: 30_000, params: cachedOnly ? { cached: 1 } : undefined,
    })
      .then((res) => {
        const prev = cache.get(id);
        // A slow cached-only answer never replaces a fresh grab that landed first.
        if (cachedOnly && prev?.url && !prev.fromCache) return;
        if (prev?.url) URL.revokeObjectURL(prev.url);
        cache.set(id, {
          url: URL.createObjectURL(res.data),
          at: new Date(res.headers['x-snapshot-at'] || Date.now()),
          stale: res.headers['x-snapshot-stale'] === '1',
          fetchedAt: Date.now(),
          fromCache: cachedOnly,
          error: null,
          reason: null,
          lastSeenAt: null,
        });
      })
      .catch(async (err) => {
        const status = err?.response?.status || 'network';
        const prev = cache.get(id);
        // "Nothing held yet" is not a failure, and must not hide a picture we have.
        if (cachedOnly && prev?.url) return;
        const why = status === 409 ? await errorBody(err) : {};
        cache.set(id, { ...(prev || {}), fetchedAt: Date.now(), fromCache: cachedOnly, error: status, ...why });
      })
      .finally(() => {
        active -= 1;
        pending.delete(key);
        emit();
        pump();
      });
  }
}

/**
 * @param {string} monitorId
 * @param {object} [opts]
 * @param {boolean} [opts.force]       skip the two-minute reuse
 * @param {boolean} [opts.cachedOnly]  never make the server grab: only a
 *        picture it already holds (else 404). A cached-only answer never
 *        counts as recent for an ordinary request, which still grabs.
 */
export function requestSnapshot(monitorId, { force = false, cachedOnly = false } = {}) {
  const key = `${monitorId}|${cachedOnly ? 'cached' : 'grab'}`;
  if (!monitorId || pending.has(key)) return;
  const hit = cache.get(monitorId);
  const recent = hit && Date.now() - hit.fetchedAt < REFRESH_MS && (cachedOnly || !hit.fromCache);
  if (!force && recent) return;
  pending.add(key);
  queue.push({ id: monitorId, cachedOnly });
  pump();
}

/**
 * Re-take the camera's saved reference picture (operators who may save zones).
 * On success the still is re-fetched, so every view of it shows the new time.
 * @returns {Promise<{ status: 'updated', capturedAt } | { status: 'queued' |
 *          'too_soon' | 'offline' | 'failed', retryAfter? }>}
 */
export async function updateSavedPicture(monitorId) {
  try {
    // `{}`, not null: axios sends a null body as the JSON text "null", which
    // express.json() (strict) rejects with 400 before the route runs.
    const res = await api.post(`/stream/snapshot/${encodeURIComponent(monitorId)}/refresh`, {}, { timeout: 30_000 });
    if (res.status === 202) return { status: 'queued' };
    requestSnapshot(monitorId, { force: true });
    return { status: 'updated', capturedAt: res.data?.capturedAt || null };
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) return { status: 'too_soon', retryAfter: err.response.data?.retryAfter ?? null };
    if (status === 409) return { status: 'offline' };
    return { status: 'failed' };
  }
}

const freshened = new Set();

/**
 * Live is playing in a zone editor: the server re-saves the camera's picture
 * from the live stream (free for the NVR) when the saved one is more than a
 * few hours old, so the next opening's picture matches live (day vs night).
 * Fire and forget, once per camera per page session; the server decides.
 */
export function freshenSavedPicture(monitorId) {
  if (!monitorId || freshened.has(monitorId)) return;
  freshened.add(monitorId);
  api.post(`/stream/snapshot/${encodeURIComponent(monitorId)}/freshen`, {}, { timeout: 30_000 }).catch(() => {});
}

// The latest still for a camera, fetched on mount and refreshed every two
// minutes while the tab is visible. Returns null until the first one lands.
// `cachedOnly` asks only for a picture the server already holds (no grab).
export function useSnapshot(monitorId, enabled = true, { cachedOnly = false } = {}) {
  const snap = useSyncExternalStore(subscribe, () => (monitorId ? cache.get(monitorId) : undefined));
  useEffect(() => {
    if (!enabled || !monitorId) return undefined;
    requestSnapshot(monitorId, { cachedOnly });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') requestSnapshot(monitorId, { cachedOnly });
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [monitorId, enabled, cachedOnly]);
  return snap || null;
}
