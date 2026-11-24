/**
 * Why a camera this page says is ON is not being counted — and why a zone
 * drawn on it has no number.
 *
 * Both questions have the same shape, and the page could answer neither.
 *
 * THE WALL IS BUILT FROM THE DETECTOR, NOT FROM THE REGISTRY. A tile exists
 * for every stream `GET /streams` returns. So a camera the operator ticked in
 * the picker, that the detector is NOT counting, has no tile at all: the
 * header says "6/20 cameras", six cameras are selected, and four tiles are on
 * screen. Nothing on the page accounts for the other two, and the picker shows
 * them ticked with a grey rectangle where the picture should be.
 *
 * That gap became reachable the day the camera's own AI switch started
 * governing every feature rather than only face recognition (backend
 * aiFeatureCameras.service.js, `eligible`). Head count used to be
 * `settings.headcount.enabled` ALONE, read inside the detector; it now also
 * requires the camera's master AI switch, which is the right rule -- one
 * switch an operator is shown should govern the services it appears to govern
 * -- but this page's own tick only ever wrote `settings.headcount.enabled`.
 * So the page can put a camera in a state it then cannot explain: ticked
 * here, excluded there, silent in both places.
 *
 * ZONES ARE THE SAME DROP, ONE LEVEL DOWN. The detector seeds `zone_counts`
 * with every configured area at 0 (head-count stream_worker.py), precisely so
 * "nobody is in the room" can be told apart from "the room is not counted".
 * So a counted camera that reports NO areas, while the registry says a zone is
 * drawn on it, is telling us the shape has not reached it: the registry write
 * landed and the detector's 15-second poll has not caught up, or never will.
 * The tile used to render that as "Counting zone" over the whole-view number,
 * which is the one reading it is not.
 *
 * Pure, with no imports, so it runs under `node --test` -- the JSX around it
 * cannot be loaded there. It decides nothing: `eligible` on the server is the
 * authority, and this is what the operator is TOLD.
 */

/** The camera's master AI switch is off. Fixable from this page. */
export const AI_OFF = 'ai-off';
/** The VMS cannot reach the camera. Not a head-count problem. */
export const OFFLINE = 'offline';
/** Nothing is visibly wrong; the detector has not started it yet. */
export const WAITING = 'waiting';

/**
 * Is this camera's AI master switch on?
 *
 * Mirrors the backend's `isAiEnabled` exactly -- `enabled === true` AND the
 * mode is not 'off'. Restated here rather than guessed at, because a second,
 * looser reading of the same switch is how a page comes to disagree with the
 * service it is describing.
 */
export const aiOn = (cam) => cam?.ai?.enabled === true && cam?.ai?.mode !== 'off';

/** Does the operator want this camera counted? */
export const wanted = (cam) => cam?.headcount?.enabled === true;

/**
 * Why `cam` is not being counted, or null when there is nothing to say.
 *
 * Null for a camera nobody asked to count, and null for one that IS counting:
 * this is the gap between the two, and only the gap.
 *
 * @param cam      a `GET /ai/cameras` row
 * @param running  is the detector serving a stream for it right now?
 * @returns {{ code, line, fix, fixable }|null}
 */
export function notCountingReason(cam, running = false) {
  if (!wanted(cam)) return null;
  if (running) return null;

  if (!aiOn(cam)) {
    return {
      code: AI_OFF,
      // Named as the switch the operator actually saw, not as the field.
      line: 'its AI is switched off, so no service reads it',
      fix: 'Turn AI on',
      fixable: true,
    };
  }

  if (String(cam?.status || '').toLowerCase() === 'offline') {
    return {
      code: OFFLINE,
      line: 'the VMS cannot reach the camera',
      fix: '',
      fixable: false,
    };
  }

  return {
    code: WAITING,
    // Deliberately not an error. The detector polls the registry every ~15s,
    // and it caps how many streams it will open at once, so "not yet" and
    // "never, because the service is full" look identical from here. Saying
    // which would be a guess.
    line: 'the detector has not started it yet',
    fix: '',
    fixable: false,
  };
}

/**
 * Every camera the operator turned on that the detector is not counting, each
 * with its reason. Ordered as the registry gave them, so the list reads the
 * same way twice.
 *
 * @param camList    `GET /ai/cameras` rows
 * @param runningIds Set of monitorIds the detector is serving
 */
export function notCounting(camList = [], runningIds = new Set()) {
  const out = [];
  for (const cam of camList || []) {
    const reason = notCountingReason(cam, runningIds.has?.(cam?.monitorId) === true);
    if (reason) out.push({ cam, reason });
  }
  return out;
}

/** "Camera 3 and Camera 7" — the Oxford-less join the save messages use. */
export function andList(items = []) {
  const list = items.filter(Boolean).map(String);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * One sentence naming the cameras that are not counting and why, or null when
 * every selected camera is counted.
 *
 * Cameras are NAMED rather than tallied while there are few enough to read: a
 * count tells an operator that something is wrong without telling them where,
 * which is the complaint this whole file exists to answer. Past four it
 * becomes a tally, because a sentence listing nine cameras is not read.
 *
 * Grouped by reason, because the reasons take different actions.
 */
export function notCountingSummary(items = [], nameOf = (c) => c?.name || c?.monitorId) {
  if (!items.length) return null;

  const byCode = new Map();
  for (const { cam, reason } of items) {
    if (!byCode.has(reason.code)) byCode.set(reason.code, { reason, names: [] });
    byCode.get(reason.code).names.push(nameOf(cam));
  }

  const parts = [];
  for (const { reason, names } of byCode.values()) {
    const who = names.length > 4
      ? `${names.length} cameras`
      : andList(names);
    const verb = names.length === 1 ? 'is' : 'are';
    parts.push(`${who} ${verb} not counting because ${reason.line}`);
  }
  return `${parts.join('; and ')}.`;
}

/**
 * The cameras whose only problem is the AI switch — the one reason an operator
 * can act on without leaving this page.
 */
export function fixable(items = []) {
  return items.filter(({ reason }) => reason?.fixable).map(({ cam }) => cam);
}

/**
 * Is a zone drawn on this camera that the detector is not applying?
 *
 * The detector seeds `zone_counts` at 0 for every area it has, so an empty
 * breakdown on a camera the registry says is scoped means the shape has not
 * reached it. Until it does, the headline number is the WHOLE VIEW -- which is
 * the opposite of what an outline drawn over the picture claims.
 *
 * @param stream the enriched stream row: `zones` from the registry,
 *               `zone_counts` from the detector.
 */
export function zonesPending(stream) {
  const drawn = (stream?.zones || []).filter((z) => z && z.enabled !== false);
  if (!drawn.length) return false;
  return Object.keys(stream?.zone_counts || {}).length === 0;
}

/** What the tile should say it is counting. */
export const ZONE_PENDING_LABEL = 'Zone drawn, not yet applied · counting the whole view';
