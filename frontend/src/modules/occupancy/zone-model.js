/**
 * Zones and cameras as a many-to-many relation.
 *
 * A zone used to BE a camera: records were keyed by monitorId and carried one
 * boundary. That cannot describe either shape a real site has --
 *
 *   one camera, many zones    a wide shot over a lobby AND the queue beside it
 *   one zone, many cameras    a hall too large for any single view
 *
 * -- so a zone now has its own id, a list of cameras, and a boundary PER
 * camera. The boundary has to be per camera: a polygon is drawn in one view's
 * pixel space and means nothing laid over another's.
 *
 *   {
 *     id:         'zone-k3x9' | <monitorId for zones saved before this model>
 *     cameras:    [monitorId, ...]        first one is the primary
 *     boundaries: { [monitorId]: [[x,y], ...] }
 *     monitorId:  cameras[0]              kept for the server and older readers
 *     boundary:   boundaries[cameras[0]]  ditto
 *     broken:     null, or why this record cannot work (see normalizeZone)
 *     ...rules    capacity, dwell, schedule, access -- one set per zone
 *   }
 *
 * A zone's live count is the sum of its per-camera counts. That is only right
 * if the parts do not overlap on the floor, which is what drawing a boundary on
 * each camera is for: each view outlines its own slice of the room.
 *
 * Pure, with no imports, so it runs under `node --test` and can be shared by
 * the data layer, the persistence layer and the editor without a cycle.
 */

/** Fewer corners than this is not a shape. Mirrors headcount/zone-geometry. */
export const MIN_CORNERS = 3;

/**
 * Stroke colours for zones sharing one camera view. Literal hues on purpose:
 * they are drawn over video, where theme tokens have no say over contrast, and
 * each has to stand apart from the others and from a typical scene.
 */
export const ZONE_COLORS = ['#4CC9F0', '#F72585', '#FFB703', '#80ED99', '#B388FF', '#FF7F50', '#00F5D4', '#F4F1BB'];

export const hasShape = (pts) => Array.isArray(pts) && pts.length >= MIN_CORNERS;

/** A fresh, URL-safe zone id. Never a 24-hex string, so it cannot pass for a monitorId. */
export function newZoneId() {
  return `zone-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

/**
 * A stored record that cannot work, and why. Carried on the record as `broken`
 * so every reader can decide for itself: the rail LISTS it, the cameras and the
 * canvas never see it.
 */
export const BROKEN_NO_CAMERA = 'no-camera';

/** `broken` in words, for a row that has to explain itself. */
export const BROKEN_LABEL = {
  [BROKEN_NO_CAMERA]: 'No camera — nothing can count this zone',
};

/**
 * Bring any stored record to the current shape.
 *
 * Records saved before this model are keyed by their camera and may list extra
 * cameras. Those extras never contributed to the count -- only the primary's
 * stream was read -- so they are dropped rather than suddenly summed in, which
 * would change the numbers an operator has been watching without them touching
 * anything.
 *
 * A record with NO camera left used to return null here, which deleted the
 * zone from every surface at once -- rail, dashboard, canvas, camera payload --
 * with nothing anywhere to say it had happened. That is how "I created zones
 * and I see none" becomes unanswerable from the page. So the record is kept and
 * marked `broken` instead: a zone with no camera is a bug worth seeing.
 *
 * Being KEPT is not being used. `cameras: []` already excludes it from
 * zonesOnCamera, and therefore from cameraPayload (nothing is pushed to a
 * camera), from colorsOnCamera and the canvas (nothing is drawn), and from
 * buildRegionZones (no count, no site total). The rail reads `saved` directly,
 * so that is where it surfaces -- the one place it can be read and deleted.
 *
 * No console line: normalizeZones runs on every loadRooms, which a single save
 * calls several times, so a warning here would be a stream rather than a
 * signal. The row in the rail is the trace.
 *
 * Returns null only for input that is not a record at all.
 */
export function normalizeZone(key, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const legacy = !raw.boundaries;
  const cameras = legacy
    ? [raw.monitorId || key].filter(Boolean)
    : (Array.isArray(raw.cameras) ? raw.cameras : []).filter(Boolean);
  const boundaries = legacy
    ? (cameras.length ? { [cameras[0]]: Array.isArray(raw.boundary) ? raw.boundary : [] } : {})
    : { ...raw.boundaries };
  return {
    ...raw,
    id: raw.id || key,
    cameras,
    boundaries,
    // '' rather than undefined: a key that JSON.stringify would drop makes the
    // next read of the cache a different shape than this one.
    monitorId: cameras[0] || '',
    boundary: boundaries[cameras[0]] || [],
    broken: cameras.length ? null : BROKEN_NO_CAMERA,
  };
}

/**
 * Every stored record, normalised, keyed by zone id. Only input that is not a
 * record at all drops out -- a zone with no camera is kept, carrying `broken`.
 */
export function normalizeZones(rooms = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(rooms || {})) {
    const z = normalizeZone(key, raw);
    if (z) out[z.id] = z;
  }
  return out;
}

/**
 * Saved zones that exist but cannot produce a number: drawn on cameras, none
 * of which is counting.
 *
 * `live` is the dashboard's region zones -- any array of `{ id }` will do. That
 * array has already been filtered to zones with a head-count stream
 * (buildRegionZones), so a saved zone missing from it is a saved zone nothing
 * is watching. This is what makes "No space is counting yet" answerable: the
 * zones are there, the counting is not.
 *
 * A zone with no camera at all is NOT one of these -- there is no switch to
 * turn on. It carries `broken` and the rail lists it on its own account.
 */
export function zonesNotCounting(rooms = {}, live = []) {
  const counting = new Set((live || []).map((z) => z?.id));
  return Object.values(normalizeZones(rooms))
    .filter((z) => !z.broken && z.cameras.length && !counting.has(z.id));
}

/**
 * Those zones in one sentence -- or null when there are none, so a panel that
 * has nothing wrong with it keeps the empty state it already had, word for
 * word. The caller renders nothing for null rather than an empty line.
 */
export function notCountingText(count = 0) {
  const n = Number(count) || 0;
  if (n < 1) return null;
  return n === 1
    ? '1 zone is set up on a camera that is not counting.'
    : `${n} zones are set up on cameras that are not counting.`;
}

export const boundaryOn = (zone, monitorId) => zone?.boundaries?.[monitorId] || [];

/**
 * The zones drawn on one camera, in a STABLE order (by id) so a zone keeps its
 * colour while it is renamed, and the tree, chips and canvas all agree on it.
 */
export function zonesOnCamera(zones, monitorId) {
  return Object.values(zones || {})
    .filter((z) => z?.cameras?.includes(monitorId))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** zoneId -> colour, for the zones on one camera. */
export function colorsOnCamera(zones, monitorId) {
  const out = {};
  zonesOnCamera(zones, monitorId).forEach((z, i) => { out[z.id] = ZONE_COLORS[i % ZONE_COLORS.length]; });
  return out;
}

/**
 * What one camera should be told: every polygon on it, and a limit.
 *
 * The camera has ONE threshold, so it can only enforce a zone's capacity when
 * that zone is the only one on it and lives on no other camera. Anywhere else
 * the number the camera sees is not the zone's number, and arming it would
 * alarm on the wrong count -- so the limit goes to 0 and the dashboard judges
 * the zone from the per-zone counts instead.
 */
export function cameraPayload(zones, monitorId) {
  const on = zonesOnCamera(zones, monitorId);
  const polygons = on
    .filter((z) => hasShape(boundaryOn(z, monitorId)))
    .map((z) => ({ id: z.id, name: z.name || 'Zone', enabled: true, points: boundaryOn(z, monitorId) }));
  const solo = on.length === 1 && on[0].cameras.length === 1;
  return {
    threshold: solo ? Number(on[0].maxCapacity) || 0 : 0,
    zones: polygons,
    zoneCount: on.length,
  };
}

/**
 * One zone's count on one camera's stream.
 *
 * With a single zone and no shape the zone IS the whole view, so the stream's
 * head count is its count. Otherwise the detector's per-zone breakdown is the
 * only honest source; it is keyed by the name the zone was pushed with, and
 * zones pushed before ids existed may be keyed by name only.
 */
export function countOn(stream, zone, zones) {
  if (!stream) return 0;
  const m = stream.id;
  const shared = zonesOnCamera(zones, m).length > 1;
  const heads = Number(stream?.counts?.heads) || 0;
  if (!shared && !hasShape(boundaryOn(zone, m))) return heads;
  const zc = stream.zone_counts || {};
  const v = zc[zone.id] ?? zc[zone.name];
  if (v != null) return Number(v) || 0;
  // One shape, no breakdown: the camera counts inside its only polygon, so its
  // head count is still this zone's. Shared, with no breakdown, it is not.
  return shared ? 0 : heads;
}

/**
 * Why a zone cannot be saved as drawn, or [] if it can.
 *
 * `zones` is every OTHER saved zone. The checks are the ones that would
 * otherwise produce a silently wrong count:
 *   - two zones with one name on a camera share one entry in its breakdown
 *   - on a shared camera, a zone with no shape claims the whole view, and the
 *     people in it would be counted twice
 */
export function zoneProblems(draft, zones = {}, cameraName = (m) => m) {
  const problems = [];
  const name = String(draft?.name || '').trim();
  if (!name) problems.push('Give the zone a name.');
  // Reachable only for a record already marked `broken`: every zone created
  // here starts on a camera, and the canvas bar refuses to detach the last
  // one. Saving it again would reach no camera and still report success.
  if (!(draft?.cameras || []).length) {
    problems.push('Add a camera to this zone: with none, nothing can count it or draw it.');
  }
  const others = Object.values(zones).filter((z) => z.id !== draft.id);

  for (const m of draft.cameras || []) {
    const onCam = others.filter((z) => z.cameras.includes(m));
    if (!onCam.length) continue;
    if (name && onCam.some((z) => String(z.name || '').trim().toLowerCase() === name.toLowerCase())) {
      problems.push(`Another zone on ${cameraName(m)} is already called "${name}". Zones sharing a camera need different names.`);
    }
    if (!hasShape(boundaryOn(draft, m))) {
      problems.push(`${cameraName(m)} is shared with ${onCam.length === 1 ? 'another zone' : `${onCam.length} other zones`} — draw this zone's boundary on it.`);
    }
    for (const z of onCam) {
      if (!hasShape(boundaryOn(z, m))) {
        problems.push(`"${z.name || 'Unnamed zone'}" covers the whole of ${cameraName(m)}. Draw its boundary before adding another zone to that camera.`);
      }
    }
  }
  return problems;
}
