// Ask Drishyam (investigation I-8/I-9): the tools an answer is built from.
//
// Answers never come from a model looking at video. They come from these
// tools, which call the same APIs the app uses (search index, journeys,
// activity, alerts), scoped to the caller's organisation and cameras. Every
// fact a tool returns carries a citation number [n]; the citation is a link
// the person can open to check it (a person's photo, a journey, the footage).
const axios = require('axios');
const { Op } = require('sequelize');
const { aiAuthHeader } = require('../../utils/aiTenant');

const ai = axios.create({ baseURL: process.env.AI_SERVICE_URL || 'http://smart-cam-ai:8001', timeout: 30_000 });
const MAX_CAMERAS_FOR_COUNTS = 20;

/** Per-question context: who asks, their cameras, their time zone, and the citations so far. */
class AskContext {
  constructor({ user, cameras, tz = 'Asia/Kolkata', now = new Date() }) {
    this.user = user;
    this.cameras = cameras;                   // [{ code, name }]
    this.tz = tz;
    this.now = now;
    this.citations = [];
    this.calls = [];
    this.names = Object.fromEntries(cameras.map((c) => [c.code, c.name || c.code]));
  }

  cite(kind, label, link, extra = {}) {
    this.citations.push({ n: this.citations.length + 1, kind, label, link, ...extra });
    return this.citations.length;
  }

  time(t) {
    try {
      // hourCycle h23: midnight is 00:00 (hour12:false gives "24:00" in en-IN).
      return new Date(t).toLocaleString('en-IN', { timeZone: this.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  clock(t) {
    try {
      return new Date(t).toLocaleTimeString('en-IN', { timeZone: this.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      return new Date(t).toISOString().slice(11, 16);
    }
  }

  headers() {
    return aiAuthHeader(this.user);
  }

  /** Camera codes for names the asker used ("gate 3" → its code); unknown names are ignored. */
  codesFor(names) {
    if (!Array.isArray(names) || !names.length) return null;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const out = [];
    for (const n of names) {
      const want = norm(n);
      const hit = this.cameras.find((c) => norm(c.name) === want || norm(c.code) === want)
        || this.cameras.find((c) => want && (norm(c.name).includes(want) || want.includes(norm(c.name))));
      if (hit && !out.includes(hit.code)) out.push(hit.code);
    }
    return out.length ? out : null;
  }
}

const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

/** "24 Nov, 14:19–14:21", or just "24 Nov, 14:19" when it starts and ends in the same minute. */
function span(ctx, a, b) {
  const end = ctx.clock(b);
  return ctx.clock(a) === end ? ctx.time(a) : `${ctx.time(a)}–${end}`;
}

/** People matching a description. Returns facts with citations, best first. */
async function searchPeople(ctx, { description, cameras, from, to, limit = 8 }) {
  const overrides = {};
  const codes = ctx.codesFor(cameras);
  if (codes) overrides.camera_codes = codes;
  if (from) overrides.since = iso(from);
  if (to) overrides.until = iso(to);
  const { data } = await ai.post('/investigate/search', {
    q: String(description || 'a person').slice(0, 300), tz: ctx.tz, cameras: ctx.cameras, overrides,
    scope_codes: ctx.cameras.map((c) => c.code), top_k: Math.max(1, Math.min(30, limit)),
  }, { headers: ctx.headers() });
  ctx.calls.push({ tool: 'search_people', description, cameras, from, to, count: data.results.length });
  const searchRef = ctx.cite('search', `Smart Search: “${description}”`, `/investigate?q=${encodeURIComponent(description || '')}`);
  const people = data.results.map((r) => ({
    ref: ctx.cite('person', `${ctx.names[r.camera_code] || r.camera_code} · ${ctx.time(r.first_seen)}`, `/investigate/track/${r.track_id}`,
      { trackId: r.track_id, photo: `/api/investigate/tracks/${r.track_id}/crop`, score: r.score }),
    track_id: r.track_id,
    camera: ctx.names[r.camera_code] || r.camera_code,
    camera_code: r.camera_code,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    seen_local: span(ctx, r.first_seen, r.last_seen),
    match: Math.round((r.score || 0) * 100),
    colours: [r.attributes?.top_colour && `${r.attributes.top_colour} top`, r.attributes?.bottom_colour && `${r.attributes.bottom_colour} bottom`].filter(Boolean).join(', ') || (r.ir ? 'night (no colour)' : ''),
  }));
  return { search_ref: searchRef, understood: (data.parsed?.chips || []).map((c) => c.label), people };
}

/** Where one person went: confirmed stops and how many proposals still need review. */
async function personJourney(ctx, { track_id: trackId }) {
  const { data } = await ai.post('/investigate/journey', { track_id: trackId, scope_codes: ctx.cameras.map((c) => c.code) },
    { headers: ctx.headers() });
  ctx.calls.push({ tool: 'person_journey', track_id: trackId, stops: data.stops.length });
  const ref = ctx.cite('journey', `Journey of this person (${data.stops.length} confirmed)`, `/investigate/track/${trackId}`, { trackId });
  return {
    journey_ref: ref,
    stops: data.stops.map((s) => ({ camera: ctx.names[s.camera_code] || s.camera_code, seen_local: span(ctx, s.first_seen, s.last_seen), status: s.status })),
    unconfirmed_sightings: data.candidates.length,
    note: 'Only confirmed stops are on the journey; unconfirmed sightings are look-alikes awaiting review.',
  };
}

/** People on each camera in a window: passes, busiest 10 minutes, first and last. */
async function countPeople(ctx, { cameras, from, to }) {
  const codes = ctx.codesFor(cameras) || ctx.cameras.filter((c) => !String(c.code).startsWith('file:')).map((c) => c.code);
  const since = new Date(from);
  const until = new Date(Math.min(new Date(to).getTime(), ctx.now.getTime()));
  const out = [];
  for (const code of codes.slice(0, MAX_CAMERAS_FOR_COUNTS)) {
    // eslint-disable-next-line no-await-in-loop -- a handful of cameras, in order
    const { data } = await ai.get('/investigate/activity', {
      headers: ctx.headers(), params: { camera_code: code, since: iso(since), until: iso(until), bin_s: 600, scope: codes.join(',') },
    });
    const bins = data.bins || [];
    let best = -1;
    bins.forEach((c, i) => { if (best < 0 || c > bins[best]) best = i; });
    const segs = data.segments || [];
    const busiest = best >= 0 && bins[best] ? new Date(Date.parse(data.since) + best * data.bin_s * 1000) : null;
    const link = `/playback?${new URLSearchParams({ monitor: code, from: iso(since), to: iso(until) })}`;
    out.push({
      ref: ctx.cite('activity', `${ctx.names[code] || code}: ${ctx.time(since)} – ${ctx.time(until)}`, link),
      camera: ctx.names[code] || code,
      people_passes: data.passes || 0,
      busiest_10_min: busiest ? `${ctx.clock(busiest)}–${ctx.clock(new Date(busiest.getTime() + 600_000))} (${bins[best]} on screen)` : null,
      first_activity: segs.length ? ctx.time(segs[0][0]) : null,
      last_activity: segs.length ? ctx.time(segs[segs.length - 1][1]) : null,
    });
  }
  ctx.calls.push({ tool: 'count_people', cameras: codes.length, from, to });
  return {
    window: `${ctx.time(since)} – ${ctx.time(until)}`,
    cameras: out.sort((a, b) => b.people_passes - a.people_passes),
    note: 'A pass is one person crossing a camera’s view; one person seen twice counts twice.',
  };
}

/** AI alerts (unknown faces, line crossings, …) in a window. */
async function listAlerts(ctx, { cameras, from, to, limit = 10 }) {
  const { AIEvent } = require('../../models');
  const owner = String(ctx.user.parentUserId || ctx.user.id);
  const codes = ctx.codesFor(cameras) || ctx.cameras.map((c) => c.code);
  const where = {
    userId: [...new Set([owner, String(ctx.user.id)])], monitorId: codes,
    ts: { [Op.between]: [new Date(from), new Date(Math.min(new Date(to).getTime(), ctx.now.getTime()))] },
  };
  const rows = await AIEvent.findAll({ where, order: [['ts', 'DESC']], limit: 500, attributes: ['id', 'monitorId', 'eventType', 'ts', 'severity', 'payload'] });
  const byType = {};
  for (const r of rows) byType[r.eventType] = (byType[r.eventType] || 0) + 1;
  ctx.calls.push({ tool: 'list_alerts', count: rows.length, from, to });
  const ref = ctx.cite('alerts', `Alerts ${ctx.time(from)} – ${ctx.time(to)}`, '/alerts');
  return {
    alerts_ref: ref,
    total: rows.length,
    by_type: byType,
    latest: rows.slice(0, Math.max(1, Math.min(20, limit))).map((r) => ({
      ref: ctx.cite('alert', `${r.eventType} · ${ctx.names[r.monitorId] || r.monitorId} · ${ctx.time(r.ts)}`, '/alerts'),
      type: r.eventType, camera: ctx.names[r.monitorId] || r.monitorId, at: ctx.time(r.ts), name: r.payload?.matchedName || null,
    })),
  };
}

function listCameras(ctx) {
  return { cameras: ctx.cameras.map((c) => ({ name: c.name, imported_video: String(c.code).startsWith('file:') })) };
}

module.exports = { AskContext, searchPeople, personJourney, countPeople, listAlerts, listCameras };
