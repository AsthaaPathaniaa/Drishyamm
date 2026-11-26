// Pure helpers for Cases (I-4). Tested in case-model.test.js.

/** Case item payloads from the places that add to a case. */
export const itemFrom = {
  searchResult: (r) => ({
    type: 'track', trackId: r.track_id, monitorId: r.camera_code, from: r.first_seen, to: r.last_seen || r.first_seen,
    score: r.score ?? null, title: `Person on ${r.camera_name || r.camera_code}`,
  }),
  journey: (seed, stops, route) => ({
    type: 'journey', seedTrackId: seed.track_id, route, stops,
    from: stops[0]?.first_seen || seed.first_seen, to: stops[stops.length - 1]?.last_seen || seed.last_seen,
    title: route.length ? route.join(' → ') : 'Journey',
  }),
  clip: (camera, start, end) => ({
    type: 'clip', monitorId: camera.monitorId, from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    title: `Clip from ${camera.name || camera.monitorId}`,
  }),
};

const AUDIT_TEXT = {
  created: 'created the case', viewed: 'opened the case', updated: 'changed the case', item_added: 'pinned an item',
  item_removed: 'removed an item', legal_hold_on: 'turned legal hold on', legal_hold_off: 'turned legal hold off',
  footage_kept: 'kept footage', footage_keep_failed: 'could not keep footage', footage_keep_requested: 'asked to keep footage',
  footage_opened: 'downloaded kept footage', member_set: 'changed a member', member_removed: 'removed a member',
};
export const auditText = (action) => AUDIT_TEXT[action] || action.replace(/_/g, ' ');

/** One time-ordered timeline of what happened (items) — the incident's own clock. */
export function timeline(items = []) {
  return items.filter((i) => i.from).slice().sort((a, b) => new Date(a.from) - new Date(b.from));
}

export const KEEP_LABEL = {
  none: null, queued: 'Waiting to keep footage', keeping: 'Keeping footage…', kept: 'Footage kept', failed: 'Could not keep footage',
};

export const canEdit = (role) => role === 'owner' || role === 'editor';
