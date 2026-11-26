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
 * Its one import is the AI-consent rule in core/services/aiConsent.js, which
 * is pure too, so this still runs under `node --test` -- the JSX around it
 * cannot be loaded there. It decides nothing: `eligible` on the server is the
 * authority, and this is what the operator is TOLD.
 */

import { aiOn, errorText } from '../../core/services/aiConsent.js';

/** The camera's master AI switch is off. Fixable from this page. */
export const AI_OFF = 'ai-off';
/** The VMS cannot reach the camera. Not a head-count problem. */
export const OFFLINE = 'offline';
/** Nothing is visibly wrong; the detector has not started it yet. */
export const WAITING = 'waiting';
/** The detector is already counting as many cameras as it will open. */
export const AT_CAPACITY = 'at-capacity';
/**
 * The camera is outside its own counting hours. The ONLY reason in this file
 * that is not a fault: the operator asked for this, and it is the system
 * obeying them. Carries `normal: true`, which keeps it out of the amber strip
 * -- a warning that appears every night at ten o'clock teaches an operator to
 * stop reading warnings.
 */
export const OUTSIDE_HOURS = 'outside-hours';

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
 * @param detector `{ max, counting }` from GET /health -- how many cameras the
 *                 service will open, and how many it has open. Optional: with
 *                 no numbers the capacity case simply is not reported, which
 *                 is what happens while /health is still loading or when an
 *                 older detector does not send the caps.
 * @returns {{ code, line, fix, fixable }|null}
 */
export function notCountingReason(cam, running = false, detector = {}) {
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

  // SECOND, because it is CERTAIN and the three below it are not. A camera
  // outside its hours has been dropped from the registry list on purpose, so
  // "the VMS cannot reach it", "the detector is full" and "not started yet"
  // are all true-but-irrelevant things to say about it -- and the first of
  // them would send an operator to check a camera that is working perfectly.
  //
  // It ranks BELOW the AI switch, which outranks everything: AI off means this
  // camera will not count when its window opens either, so that is the bigger
  // fact and the only one with an action attached.
  //
  // `=== false` STRICTLY. `countingNow` is computed by the server
  // (aiFeatureCameras.withinCountWindow, reported on the camera row), and a
  // row that does not carry it at all -- an older backend, a cached response --
  // means UNKNOWN, not paused. Reading absent as paused would explain away a
  // genuinely broken camera as a schedule nobody set.
  if (cam?.headcount?.countingNow === false) {
    const w = cam.headcount.countWindow || {};
    const hours = w.from && w.to;
    return {
      code: OUTSIDE_HOURS,
      line: hours
        ? `it counts only between ${w.from} and ${w.to}, and it is outside those hours`
        : 'it is outside its counting hours',
      // Nothing to offer. The fix for "it is doing what you told it" is to
      // change the hours, which lives on the camera's own card next to the
      // number it governs -- not on a page-wide strip, where one button would
      // have to pick which camera's schedule to edit.
      fix: '',
      fixable: false,
      normal: true,
      // When it comes back. Outside a window, the next opening is always its
      // start -- true for 09:00-17:00 at midnight and for 22:00-06:00 at noon.
      resumesAt: hours ? w.from : null,
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

  // The detector is full. This used to be indistinguishable from "not yet"
  // from the page's side, so both came out as "not started it yet" -- true,
  // and useless to somebody who had been waiting ten minutes. /health now
  // reports the cap, so the real answer can be given.
  if (atCapacity(detector)) {
    return {
      code: AT_CAPACITY,
      line: `the detector is already counting ${detector.max} cameras, which is all it will open`,
      fix: '',
      fixable: false,
    };
  }

  return {
    code: WAITING,
    // Still deliberately not an error: the detector polls the registry every
    // ~15s, so a camera ticked seconds ago is simply early.
    line: 'the detector has not started it yet',
    fix: '',
    fixable: false,
  };
}

/** Is the detector already serving every stream it will open? */
export function atCapacity({ max = 0, counting = 0 } = {}) {
  return Number(max) > 0 && Number(counting) >= Number(max);
}

/**
 * The cap, read from GET /health.
 *
 * Absent means unknown, not unlimited: an older detector sends no caps, and
 * reporting "no limit" for one would be a worse answer than reporting none.
 */
export function detectorCapacity(health, countingNow = 0) {
  return {
    max: Number(health?.max_streams) || 0,
    perHost: Number(health?.max_streams_per_host) || 0,
    counting: Number(countingNow) || 0,
  };
}

/**
 * What to say before ticking a camera the detector has no room for, or null
 * when there is room.
 *
 * WARNS, it does not block. The tick is still meaningful: it is a standing
 * instruction, and the camera starts the moment another is turned off. Refusing
 * it would make the operator remember to come back.
 *
 * It says who to ask rather than offering a control, because the limit is a
 * server setting and the per-recorder half of it is PROTECTIVE -- entry NVRs
 * stop answering past a few concurrent RTSP sessions and take every camera
 * offline with them. A UI that offered to raise that would be offering to
 * break the site.
 */
export function capacityCopy(cam, detector = {}) {
  const { max, perHost, counting } = detectorCapacity(
    { max_streams: detector.max, max_streams_per_host: detector.perHost },
    detector.counting,
  );
  const name = cam?.name || cam?.monitorId || 'This camera';
  return {
    title: 'The detector is already full',
    body: `It counts up to ${max} cameras at once and is counting ${counting}. `
      + `${name} will be saved as "should be counted", but nothing will count it `
      + `until one of the others is turned off.`
      + (perHost ? ` (A single recorder is limited to ${perHost} at once, separately, `
        + 'to stop it dropping every camera on it.)' : '')
      + ' Raising the limit is a server setting — ask whoever runs this deployment.',
    confirmLabel: 'Tick it anyway',
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
export function notCounting(camList = [], runningIds = new Set(), detector = {}) {
  const out = [];
  for (const cam of camList || []) {
    const reason = notCountingReason(
      cam, runningIds.has?.(cam?.monitorId) === true, detector,
    );
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
 * Split the not-counting cameras into the ones that are WRONG and the ones
 * that are merely OFF DUTY.
 *
 * Both still have to be accounted for -- the wall is built from the detector's
 * streams, so either kind has no tile at all, and a camera with no tile and no
 * sentence is the original defect this file was written to remove. What differs
 * is the REGISTER they are said in: a fault is amber and asks for something, a
 * scheduled pause is a quiet line that confirms the camera is behaving.
 *
 * Kept as two functions over one flag read at the call site so that adding a
 * second non-fault reason later cannot leave one strip behind.
 */
export function faults(items = []) {
  return items.filter(({ reason }) => reason && !reason.normal);
}

/** The cameras that are off duty by their own schedule, and nothing else. */
export function paused(items = []) {
  return items.filter(({ reason }) => reason?.normal === true);
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

/* ── consent to switch the camera's AI on ───────────────────────────────────
 *
 * Counting cannot start while the camera's master AI switch is off, and the
 * switch an operator is given here only asks for counting -- so something has
 * to turn the master on, and that something must ASK, not decide.
 *
 * That rule is not head count's to state: it governs every feature behind the
 * master switch, and it lives in core/services/aiConsent.js with its
 * reasoning. What belongs here is the WORDING of the question, which is
 * head-count copy and nobody else's -- see `consentCopy` below.
 */

/* ── when a save does not land ──────────────────────────────────────────────
 *
 * A tick that springs back with no message is this whole file's complaint,
 * committed by the page that was written to fix it. Every save here can be
 * refused for reasons the operator can act on and cannot guess:
 *
 *   the account's head-count licence is used up
 *   the camera was deleted in another tab
 *   the backend is unreachable
 *
 * None of those is a consent question, so none of them opened the dialog, and
 * the catch simply put the tick back. Silent.
 */

/**
 * One line for the saves that did not land, or null when none failed.
 *
 * Grouped by REASON rather than listed per camera: twenty cameras refused for
 * one exhausted licence is one fact, and twenty copies of it is noise that
 * hides the second reason underneath.
 *
 * @param failures `[{ cam, message }]`
 */
export function saveFailureSummary(failures = []) {
  const real = (failures || []).filter(Boolean);
  if (!real.length) return null;

  const byReason = new Map();
  for (const { cam, message } of real) {
    const key = String(message || errorText());
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(cam?.name || cam?.monitorId || 'a camera');
  }

  const parts = [];
  for (const [message, names] of byReason.entries()) {
    const who = names.length > 4 ? `${names.length} cameras` : andList(names);
    // The server's sentence is already a sentence, so it is not re-punctuated
    // into the middle of this one.
    parts.push(`${who}: ${message.replace(/\.$/, '')}`);
  }
  return `Not saved — ${parts.join('; ')}.`;
}

/**
 * What the dialog says, as `{ title, body, confirmLabel, cameras }`.
 *
 * The body names all three things an operator needs to decide: what is off,
 * what will be switched on, and what will NOT be — because the obvious worry
 * about "turn AI on" is face recognition, and the answer is no.
 *
 * Takes one camera or a LIST, because "Turn all on" in the picker can need
 * consent for several at once and asking once per camera would be a queue of
 * identical dialogs. Few enough to read are NAMED; past four it is a count,
 * the same rule the not-counting sentence uses.
 */
export function consentCopy(input) {
  const cameras = (Array.isArray(input) ? input : [input]).filter(Boolean);
  const names = cameras.map((c) => c?.name || c?.monitorId).filter(Boolean);
  const many = cameras.length > 1;
  const who = !cameras.length ? 'this camera'
    : names.length > 4 ? `${cameras.length} cameras`
      : andList(names);
  return {
    cameras,
    title: many
      ? `Switch AI on for ${cameras.length} cameras?`
      : 'Switch AI on for this camera?',
    body: `${who} ${many ? 'have' : 'has'} AI switched off, so ${many ? 'they cannot' : 'it cannot'} `
      + `count people yet. Switching AI on lets the detector count them. ${many ? 'They count' : 'It counts'} `
      + 'only — faces are not matched, and no other AI feature is started. You can switch '
      + 'it off again in Camera Setup.',
    confirmLabel: many ? `Switch AI on for ${cameras.length} and count` : 'Switch AI on and count',
  };
}
