/**
 * One place that decides what "turn AI on/off for a camera" sends, and what a
 * camera's AI is actually doing.
 *
 * Camera Setup → AI Detection is the only screen that switches AI on by hand.
 * Two other places still have to switch it on for a reason of their own (AI
 * Feed saving a detection area, Occupancy saving a gate), and before this file
 * each of them built its own PATCH /ai/cameras/:id/lifecycle body with its own
 * defaults (4 fps in one, 8 in another). They all build it here now, so a
 * camera behaves the same whichever screen started it.
 *
 * The backend today runs ONE pipeline per camera (person + face). Everything
 * the operator thinks of as a "feature" is that pipeline plus either a flag on
 * it (unknown / watchlist alerts, journey mapping) or something drawn on the
 * camera (a counting line for head count, a zone for restricted areas).
 * `cameraFeatures` turns that into a list the UI can show.
 *
 * Pure, with no imports, so it runs under `node --test`.
 */

export const DEFAULT_FPS = 4;
export const DEFAULT_INPUT_SIZE = 960;

/** Area purposes offered in the picker. */
export const PURPOSES = [
  'Main gate',
  'Reception',
  'Restricted area',
  'Server room',
  'Cash counter',
  'Exam hall',
  'Store room',
];

/**
 * The features shown to the operator, in display order.
 *   kind 'flag'  – a switch stored on camera.settings.ai (`flag` names it)
 *   kind 'setup' – on when something has been drawn for this camera; the
 *                  picker links to the screen where it is drawn
 */
export const AI_FEATURES = [
  { key: 'face', kind: 'core', label: 'Face & person detection', short: 'Face', note: 'Finds people and recognises enrolled faces. Every other feature builds on this.' },
  { key: 'unknown_alerts', kind: 'flag', flag: 'unknownAlerts', label: 'Unknown person alerts', short: 'Unknown', note: 'Alert when someone who is not enrolled is seen.' },
  { key: 'watchlist_alerts', kind: 'flag', flag: 'watchlistAlerts', label: 'Watchlist alerts', short: 'Watchlist', note: 'High-priority alert when a watchlisted person is seen.' },
  { key: 'journey', kind: 'flag', flag: 'journeyMapping', label: 'Journey mapping', short: 'Journey', note: "Joins sightings into a person's path across cameras." },
  { key: 'head_count', kind: 'setup', label: 'Head count / footfall', short: 'Count', note: 'Counts people crossing a gate line.', setupLabel: 'Draw a gate line', setupPath: '/occupancy/zone-setup' },
  { key: 'restricted_zone', kind: 'setup', label: 'Restricted zone', short: 'Zone', note: 'Alerts when someone enters an area you draw.', setupLabel: 'Draw a zone', setupPath: '/ai-feed' },
];

/**
 * Features each purpose turns on by default when it is picked. Only flags can
 * be preset; drawn features always need the operator to draw them.
 */
export const PURPOSE_PRESETS = {
  'Main gate':       { unknownAlerts: true,  watchlistAlerts: true,  journeyMapping: true },
  Reception:         { unknownAlerts: true,  watchlistAlerts: false, journeyMapping: true },
  'Restricted area': { unknownAlerts: true,  watchlistAlerts: true,  journeyMapping: false },
  'Server room':     { unknownAlerts: true,  watchlistAlerts: true,  journeyMapping: false },
  'Cash counter':    { unknownAlerts: true,  watchlistAlerts: true,  journeyMapping: false },
  'Exam hall':       { unknownAlerts: true,  watchlistAlerts: false, journeyMapping: false },
  'Store room':      { unknownAlerts: true,  watchlistAlerts: false, journeyMapping: false },
};

/** A sensible purpose for a camera that has never had one, from its name. */
export function inferPurpose(row) {
  const text = `${row?.name || ''} ${row?.groupName || ''}`.toLowerCase();
  if (text.includes('gate') || text.includes('entrance')) return 'Main gate';
  if (text.includes('server')) return 'Server room';
  if (text.includes('reception')) return 'Reception';
  if (text.includes('cash')) return 'Cash counter';
  if (text.includes('store')) return 'Store room';
  return 'Restricted area';
}

/**
 * The lifecycle body that switches AI ON, carrying every setting the camera
 * already has. `overrides` wins over both.
 *
 * `detectionZones` is only sent when the caller passes it: the backend keeps
 * the stored zones when the field is absent, so turning AI on can never wipe
 * an area drawn in AI Feed.
 */
export function buildEnablePayload(row, overrides = {}) {
  const ai = row?.ai || {};
  return {
    enabled: true,
    mode: 'continuous',
    fps: Number(ai.fps) || DEFAULT_FPS,
    detectionInputSize: Number(ai.detectionInputSize) || DEFAULT_INPUT_SIZE,
    purpose: ai.purpose || inferPurpose(row),
    priority: ai.priority || 'normal',
    unknownAlerts: ai.unknownAlerts !== false,
    watchlistAlerts: ai.watchlistAlerts !== false,
    journeyMapping: ai.journeyMapping !== false,
    ...overrides,
  };
}

/** The lifecycle body that switches AI OFF, keeping the stored choices. */
export function buildDisablePayload(row) {
  return { ...buildEnablePayload(row), enabled: false, mode: 'off' };
}

const hasDrawn = (list) => Array.isArray(list) && list.some((z) => z && z.enabled !== false);

/**
 * What this camera's AI is set to do, as [{ ...feature, on, needsSetup }].
 * `row` is a GET /ai/cameras row (serializeAiCamera in the backend).
 *
 * A drawn feature is `on` when it is drawn; `needsSetup` when it is drawn but
 * AI is off (nothing will happen), so the UI can say so.
 */
export function cameraFeatures(row) {
  const ai = row?.ai || {};
  const aiOn = ai.enabled === true;
  const zones = Array.isArray(ai.detectionZones) ? ai.detectionZones : [];
  const drawn = {
    head_count: row?.headcount?.enabled === true
      || hasDrawn(row?.headcount?.zones)
      || zones.some((z) => z?.shape === 'line' && z.enabled !== false),
    restricted_zone: zones.some((z) => z?.shape !== 'line' && z?.enabled !== false),
  };
  return AI_FEATURES.map((f) => {
    if (f.kind === 'core') return { ...f, on: aiOn, needsSetup: false };
    if (f.kind === 'flag') return { ...f, on: aiOn && ai[f.flag] !== false, needsSetup: false };
    return { ...f, on: aiOn && drawn[f.key], needsSetup: !aiOn && drawn[f.key] };
  });
}

/** Short labels of the features that are on, for chips on rows and cards. */
export function activeFeatureLabels(row) {
  return cameraFeatures(row).filter((f) => f.on).map((f) => f.short);
}

/** Where Camera Setup's AI Detection tab opens with one camera selected. */
export function aiSetupPath(cameraId) {
  const params = new URLSearchParams({ tab: 'ai-detection' });
  if (cameraId) params.set('camera', String(cameraId));
  return `/camera-setup?${params.toString()}`;
}

/** Label and dot colour for a camera's AI lifecycle state (GET /ai/cameras `lifecycle`). */
export function lifecycleCopy(status) {
  switch (status) {
    case 'detecting':
      return { label: 'Detecting', dot: 'bg-success' };
    case 'starting':
      return { label: 'Starting', dot: 'bg-info animate-pulse' };
    case 'pending':
      return { label: 'Needs retry', dot: 'bg-warning' };
    case 'attention':
      return { label: 'Attention', dot: 'bg-danger' };
    default:
      return { label: 'On', dot: 'bg-success' };
  }
}
