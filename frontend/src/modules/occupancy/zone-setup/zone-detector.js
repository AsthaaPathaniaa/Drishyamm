/**
 * What a zone will and will not catch, given what is detecting people on its
 * camera — and the switch that changes the answer.
 *
 * A zone detects nothing itself. It applies its dwell / confirm rules to boxes
 * a PRODUCER publishes, and there are two:
 *
 *   face pipeline   `ai.faceRecognition`, absent means ON. Boxes carry a NAME,
 *                   so an allow-list can excuse a person — but a face that is
 *                   turned away, covered or too far to read produces no box at
 *                   all, so the person is simply not there as far as the zone
 *                   is concerned.
 *   zone-guard      `ai.zoneBodyDetection`, absent means OFF. Boxes carry no
 *                   name, ever, by design: it detects a BODY. It catches the
 *                   person the face pipeline misses, and it cannot tell staff
 *                   from an intruder.
 *
 * Why this file exists rather than a sentence in the editor: "off" is a
 * legitimate choice here, and a legitimate choice has to be an INFORMED one.
 * A strict-lockout zone saved with body detection off is a zone that misses
 * the intruder who knows where the camera is — which is the intruder it was
 * drawn for. A silent off on a security control is the failure; the off itself
 * is not.
 *
 * The rules mirror the backend's zoneProducer.service.js, which is the
 * authority and enforces them. Nothing here is a permission check; it is what
 * the operator is TOLD.
 *
 * Pure, with no imports, so it runs under `node --test`. The API call in
 * `enableBodyDetection` is injected, the same pattern as gate-ai.js.
 */

/** Is this camera used by AI at all? Mirrors the backend's isAiEnabled. */
const aiOn = (row) => row?.ai?.enabled === true && row?.ai?.mode !== 'off';

/** Is the face pipeline producing boxes here? Absent means on. */
export const faceProducing = (row) => aiOn(row) && row?.ai?.faceRecognition !== false;

/** Is zone-guard producing boxes here? Absent means OFF — it is opted into. */
export const bodyProducing = (row) => aiOn(row) && row?.ai?.zoneBodyDetection === true;

/** Would a zone on this camera have anything feeding it? */
export const hasProducer = (row) => faceProducing(row) || bodyProducing(row);

/**
 * Is body detection MANDATORY on this camera rather than a choice?
 *
 * AI on, face recognition off: there is no other producer, so a zone here
 * fires only if zone-guard is watching. AI off entirely is NOT this case —
 * then nothing runs because the operator said so, which the editor reports
 * separately rather than treating as a detector problem.
 */
export const bodyRequired = (row) => aiOn(row) && row?.ai?.faceRecognition === false;

/** The modes whose coverage depends on which producer is running. */
const LOCKOUT = 'lockout';

/**
 * What to tell the operator about a zone on this camera, as
 * `{ level, headline, catches, misses, offer, reason }` — or null when there
 * is nothing worth saying.
 *
 * `offer` is true when the useful next action is the inline switch. It is
 * false when the problem is elsewhere (AI off entirely), because offering a
 * detector switch on a camera whose AI is off would be a control that saves
 * and changes nothing — the same mistake as showing the toggle on a camera
 * with no zone.
 *
 * Only LOCKOUT zones get the warning. A public zone alarms on nobody, so its
 * coverage is not a security question; an allow-list zone is not offered at
 * all today (access-data.js) precisely because zone-guard breaks it, and that
 * mode carries its own explanation already.
 */
export function zoneCoverage(row, mode) {
  if (!aiOn(row)) {
    return {
      level: 'blocked',
      headline: 'This camera\'s AI is off, so this zone will not fire at all.',
      catches: [],
      misses: ['Everyone — nothing is detecting people on this camera.'],
      offer: false,
      reason: 'Turn AI on for this camera in Camera Setup → AI Detection.',
    };
  }

  if (bodyRequired(row) && !bodyProducing(row)) {
    // The invariant. The backend refuses to arm a zone in this state, so this
    // is not advice -- it is what has to change before the zone can be saved.
    return {
      level: 'blocked',
      headline: 'Nothing on this camera is detecting people.',
      catches: [],
      misses: ['Everyone. Face recognition is off, so there is no other detector.'],
      offer: true,
      reason: 'This zone cannot be armed until body detection is on.',
    };
  }

  if (mode !== LOCKOUT || bodyProducing(row)) return null;

  // Face-only lockout: the case worth a sentence. Off is allowed, and this is
  // what it costs.
  return {
    level: 'warning',
    headline: 'This zone will only catch people whose face the camera can read.',
    catches: ['Anyone facing the camera closely enough to be detected.'],
    misses: [
      'Someone with their back or side to the camera.',
      'A covered, hooded or masked face.',
      'Anyone too far away for their face to register.',
    ],
    offer: true,
    reason: 'Nobody is permitted in a strict-lockout zone, so a body with no readable '
      + 'face is still a breach — but only body detection can see one.',
  };
}

/** Said after the inline switch has turned body detection on. */
export const BODY_TURNED_ON = 'Body detection is on for this camera. The zone now catches '
  + 'people whose face cannot be read.';

/** Where an operator turns it on by hand when the inline switch could not. */
const BY_HAND = 'Turn on "Catch people with no visible face" in Camera Setup → AI Detection.';

/**
 * Turn body detection on for one camera, from inside the zone editor.
 *
 * Goes through the SAME per-camera lifecycle route the AI Detection tab uses,
 * with every setting the camera already has carried over, so a camera switched
 * on from here is indistinguishable from one switched on there.
 *
 * Never throws: the operator is in the middle of editing a zone, and a failure
 * here changes what they are told, not what they have drawn.
 *
 * @param row            the camera's GET /ai/cameras row
 * @param buildPayload   (row, overrides) => lifecycle body (aiCamera's
 *                       buildEnablePayload, injected so this stays pure)
 * @param enableCamera   (cameraId, payload) => PATCH /ai/cameras/:id/lifecycle
 *
 * @returns { status, note }
 *            already-on  it was already running; nothing was asked of the backend
 *            turned-on   it is on now
 *            unknown     there is no camera row to act on
 *            failed      the call was refused, or the AI service did not start it
 */
export async function enableBodyDetection({ row, buildPayload, enableCamera }) {
  if (!row?.id) {
    return { status: 'unknown', note: `This camera is not in the AI camera list. ${BY_HAND}` };
  }
  if (bodyProducing(row)) return { status: 'already-on', note: '' };

  try {
    // `faceRecognition` is sent EXPLICITLY, and this is the whole point of the
    // line. buildEnablePayload defaults it to `ai.faceRecognition !== false` --
    // absent means ON -- so sending only `zoneBodyDetection` switched FACE
    // RECOGNITION on as well for any camera nobody had configured, and spent a
    // face licence the operator never asked for. This button says one thing:
    // turn on body detection.
    //
    // `faceProducing(row)` is the camera's CURRENT state, not a constant,
    // because both constant answers are wrong:
    //   true  -- the bug above.
    //   false -- would stop a camera that IS matching faces today (absent
    //            means on, so plenty are) the moment someone adds a zone to it.
    // The detector dialog (applyZoneEntry) already sends the flag explicitly
    // for both of its options; this path was the one that did not.
    const payload = await enableCamera(row.id, buildPayload(row, {
      zoneBodyDetection: true,
      faceRecognition: faceProducing(row),
    }));
    if (payload?.reconcile && payload.reconcile.ok === false) {
      return {
        status: 'failed',
        note: `Body detection is saved, but the AI service did not start this camera: ${
          payload.reconcile.error || 'it did not respond.'} Nothing is detected until it does.`,
      };
    }
    return { status: 'turned-on', note: BODY_TURNED_ON };
  } catch (err) {
    const why = err?.response?.data?.message || err?.message || 'the request was refused';
    return { status: 'failed', note: `Body detection could not be turned on (${why}). ${BY_HAND}` };
  }
}

/**
 * The reason a zone cannot be SAVED as armed, or null when it can.
 *
 * One string, for the editor's existing problem list (`zoneProblems`). This is
 * the client half of the backend's 409: the operator should never have to send
 * a save to learn the camera cannot carry the zone.
 */
export function zoneDetectorProblem(row, cameraName = 'this camera') {
  if (!row) return null;        // no row to judge; the server is the authority
  if (!aiOn(row)) return null;  // AI off is reported by the editor already
  if (hasProducer(row)) return null;
  return `${cameraName} has face recognition off and no body detection, so nothing would `
    + 'detect people in this zone. Switch on "Catch people with no visible face" for it.';
}

/* ── the door, not the save ─────────────────────────────────────────────────
 *
 * Drawing a zone on a camera that cannot carry one used to be a round trip:
 * the side panel's "Draw a zone" link navigated straight to the zone page, the
 * operator picked a camera, drew a shape, named it, set its rules, pressed
 * Save -- and only then learned the camera has no detector, from a 409.
 *
 * Everything between the click and the save was wasted, and the message
 * arrived at the point where it reads as "your work is lost" rather than
 * "choose a detector first".
 *
 * So the question is asked AT THE DOOR. `zoneEntry` is what the panel checks
 * before it navigates, and what it offers is a CHOICE, not a confirmation:
 * face and body are different trade-offs, and which one is right depends on
 * what the zone is for. Picking for the operator would be picking wrong half
 * the time.
 */

/** Turn on face recognition: the master too, if it is off. */
export const USE_FACE = 'face';
/** Turn on body detection, leaving faces unmatched. */
export const USE_BODY = 'body';

/** "Dock and Vault", "Dock, Vault and Gate" — names, never a tally. */
const andList = (names) => {
  const list = names.filter(Boolean).map(String);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

/** What to call a camera when the caller offers nothing better. */
const nameOfRow = (row) => row?.name || row?.monitorId || 'this camera';

/** The name the operator knows this camera by. */
const resolveName = (nameOf, row) => (typeof nameOf === 'function' ? nameOf(row) : null)
  || nameOfRow(row);

/**
 * What must be decided before this zone's cameras can carry it — or null when
 * they already can, in which case the panel simply navigates as before.
 *
 * TAKES THE WHOLE CAMERA LIST, not one camera. A zone writes its counting
 * config to every camera it is drawn on (`touched` in room-settings' saveRoom)
 * and the master AI switch gates that write, so a three-camera zone whose
 * second camera has AI off still dies at the save however carefully the first
 * was checked. One row is accepted too, for the door, where one is all there is.
 *
 * ONE DIALOG FOR ALL OF THEM. It is the same decision -- which detector -- so
 * asking per camera would be a queue of identical questions. The cameras that
 * need it are NAMED: a count tells an operator that something is wrong without
 * telling them where.
 *
 * Returns `{ code, title, body, options, cameras }`. `cameras` is the rows
 * that need changing, so the caller does not re-derive the set -- hand it
 * straight back to `applyZoneEntry`. Each option carries the `overrides` to
 * give `buildEnablePayload`, so the caller does not restate the rules; it also
 * carries `costsFaceLicence`, because spending one is the kind of consequence
 * an operator should see named before they choose.
 *
 * @param input   one camera row, or the rows for every camera the zone covers
 * @param nameOf  (row) => the name the operator knows it by. Falls back to the
 *                row's own name, so it is optional.
 */
export function zoneEntry(input, nameOf = nameOfRow) {
  const rows = Array.isArray(input) ? input : [input];
  // Only the cameras that cannot carry a zone yet. A four-camera zone with one
  // anonymous camera is one decision about that one, not four. An empty list is
  // nobody to ask about -- a zone with no cameras at all is the editor's own
  // problem, and it reports that itself.
  const cameras = rows.filter((row) => !hasProducer(row));
  if (!cameras.length) return null;

  const who = andList(cameras.map((row) => resolveName(nameOf, row)));
  const count = cameras.length;
  const many = count > 1;
  const options = [
    {
      id: USE_BODY,
      label: 'Catch anyone (body detection)',
      detail: 'Sets the zone off for any person who enters, including someone hooded, '
        + 'turned away or far from the camera. It never tells you WHO — it detects a '
        + 'body, not a face. This is the right choice for a strict lockout, where '
        + 'nobody is permitted and the person you most need to catch is the one '
        + 'avoiding the camera.',
      // Face explicitly off: this option promises no face matching, so it must
      // not quietly leave a flag that starts it. Absent means ON for that one.
      overrides: { enabled: true, faceRecognition: false, zoneBodyDetection: true },
      costsFaceLicence: false,
      recommendedFor: 'lockout',
    },
    {
      id: USE_FACE,
      label: 'Recognise faces',
      detail: 'Tells you who entered, and lets an allow-list excuse the people who '
        + 'are meant to be there. It only sees a person whose face the camera can '
        + 'read, so a covered or turned-away face sets nothing off. Uses one face '
        + 'recognition licence.',
      overrides: { enabled: true, faceRecognition: true },
      costsFaceLicence: true,
      // No `recommendedFor`. The mode this option suits -- allow-list -- is
      // `unavailable` in access-data.js until the overlay channel can say
      // whether a box could carry a name, so recommending it here would point
      // an operator at a choice they cannot make. Restore it with the mode.
    },
  ];

  // Any master switch off means the choice switches AI on as well. Said in the
  // body, because using a camera for AI at all is the operator's decision and
  // this dialog is where they are taking it.
  if (cameras.some((row) => !aiOn(row))) {
    return {
      code: 'ai-off',
      cameras,
      options,
      title: many
        ? `${count} cameras on this zone are not being used by AI yet`
        : `${who} is not being used by AI yet`,
      body: many
        ? 'A zone needs something watching for people on every camera it is drawn on. '
          + `Choose what should watch ${who} — the same choice is applied to all ${count}, `
          + 'and switches AI on where it is off.'
        : 'A zone needs something watching for people on this camera. Choose what '
          + 'should watch — this also switches the camera\'s AI on.',
    };
  }

  return {
    code: 'no-detector',
    cameras,
    options,
    title: many
      ? `Nothing is detecting people on ${count} of this zone's cameras`
      : `Nothing is detecting people on ${who}`,
    body: many
      ? `Face recognition and body detection are both off on ${who}, so a zone drawn `
        + 'here would never set anything off on them. Choose one — the same choice is '
        + `applied to all ${count}.`
      : 'Face recognition and body detection are both off, so a zone drawn here '
        + 'would never set anything off. Choose one before drawing it.',
  };
}

/**
 * Apply the chosen option to every camera the dialog named.
 *
 * Goes through the SAME per-camera lifecycle route the AI Detection tab uses,
 * which is allowed to switch the master on -- because this dialog IS the
 * operator deciding to switch it on. Nothing here touches the head-count
 * route: the zone save writes counting afterwards, and that write stops being
 * refused precisely because the master is on by the time it goes out.
 *
 * NEVER THROWS, AND NEVER STOPS EARLY. One unreachable camera must not leave
 * the others unchanged, and must not leave the operator guessing which is
 * which. The caller decides what a partial result means; in a dialog, a
 * non-empty `failed` is the reason to stay open and show `note`.
 *
 * @param entry        the `zoneEntry` result being answered
 * @param option       the option the operator chose
 * @param buildPayload (row, overrides) => lifecycle body (aiCamera's
 *                     buildEnablePayload, injected so this stays pure)
 * @param enableCamera (cameraId, payload) => PATCH /ai/cameras/:id/lifecycle
 *
 * @returns { applied, failed, notices, note }
 */
export async function applyZoneEntry({
  entry, option, buildPayload, enableCamera, nameOf = nameOfRow,
}) {
  const applied = [];
  const failed = [];
  const notices = [];

  for (const row of entry?.cameras || []) {
    const name = resolveName(nameOf, row);
    if (!row?.id) {
      failed.push({ name, why: 'it is not in the AI camera list' });
      continue;
    }
    try {
      const result = await enableCamera(row.id, buildPayload(row, option?.overrides || {}));
      applied.push({ row, name, result });
      // Saved, but the service did not start the camera. Not a reason to refuse
      // the zone -- the setting is right and it retries -- but it is said,
      // because nothing is detected until it does.
      if (result?.reconcile && result.reconcile.ok === false) {
        notices.push(`${name}: saved, but the AI service did not start it (${
          result.reconcile.error || 'it did not respond.'}).`);
      }
    } catch (err) {
      failed.push({
        name,
        why: err?.response?.data?.message || err?.message || 'the request was refused',
      });
    }
  }

  return {
    applied,
    failed,
    notices,
    note: failed.length
      ? `${andList(failed.map((f) => f.name))} could not be changed: ${
        andList([...new Set(failed.map((f) => f.why))])}. Nothing was drawn, so nothing is lost.`
      : '',
  };
}
