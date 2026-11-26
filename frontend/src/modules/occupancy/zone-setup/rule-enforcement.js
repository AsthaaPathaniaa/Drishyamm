/**
 * Which of a zone's rules something actually enforces — and which are only
 * stored.
 *
 * WHY THIS EXISTS
 *
 * The rules drawer offers four sections of settings, and they do not all do
 * something. Some are read by the intrusion engine on every frame; others are
 * written to this browser's localStorage, round-trip through the save, and are
 * read by nothing at all. On screen they looked identical: same accordion,
 * same inputs, same confident summary line when closed.
 *
 * That is worse than a missing feature. An operator who sets "minimum
 * staffing: 2" is told nothing, sees it saved, sees it summarised — and no
 * alert will ever come from it. On a security page, a control that looks
 * armed and is not is the failure mode to design against.
 *
 * So the drawer is split: what works, then a labelled divider, then what does
 * not yet. Same controls, same saves — the setting is kept, so nothing an
 * operator typed is thrown away and the day the engine reads it they need
 * change nothing — but the promise is accurate.
 *
 * HOW THESE WERE DECIDED, so the next person can re-check rather than trust
 * this comment. A rule is ENFORCED when it survives the whole path:
 *
 *   the drawer writes it           StepBehaviour / StepAccess
 *   -> `toApi` sends it            restricted-zones-api.js
 *   -> the column stores it        models/RestrictedZone.js
 *   -> the engine reads it         services/zoneIntrusion.service.js
 *      (or services/zoneArming.js, for the arm window)
 *
 * Checked field by field at the time of writing. `toApi` is the narrow point:
 * it sends monitorId, cameraName, name, shape, points, rect, priority,
 * alertOnEntry, allowed, schedule, window, dwellSec and maxOccupancy. A rule
 * whose field is not in that list cannot be enforced, whatever the UI implies.
 */

/** A rule the engine reads. Changing it changes what happens. */
export const ENFORCED = 'enforced';
/** A rule that saves and is read by nothing yet. */
export const STORED_ONLY = 'stored-only';

/**
 * The drawer's sections, in the order they should appear, with what each one
 * actually does.
 *
 * `fields` are the draft keys the section writes — the thing to re-check
 * against `toApi` when this is revisited.
 */
export const RULE_SECTIONS = Object.freeze([
  {
    id: 'capacity',
    status: ENFORCED,
    // maxCapacity -> toApi `maxOccupancy` -> the engine's capacity rule. It
    // also reaches the camera as `headcount.threshold`, but ONLY when one zone
    // sits alone on one camera (cameraPayload's `solo` rule) -- so the counting
    // limit is narrower than the intrusion one. Both are real.
    fields: ['maxCapacity'],
    why: 'The engine raises an alert when the zone goes over this.',
  },
  {
    id: 'access',
    status: ENFORCED,
    // access.mode -> alertOnEntry + allowed; roles -> allowed;
    // scheduleMode/scheduleHours -> schedule + window; severity -> priority;
    // alertAfterSec -> dwellSec. Every one of them crosses.
    fields: ['access', 'severity', 'alertAfterSec'],
    why: 'Who may enter, when the zone is armed, and how loud the alert is.',
  },
  {
    id: 'schedule',
    status: STORED_ONLY,
    // `hours` and `offHoursLock` are NOT in toApi. The arm window that IS
    // enforced is the one inside Access & identity (access.scheduleHours),
    // which is a genuine trap: two schedules on one page, one of them inert.
    fields: ['hours', 'offHoursLock'],
    why: 'Saved, but nothing reads it yet. The arm window that IS enforced is '
      + 'the one in Access & identity.',
  },
  {
    id: 'staffing',
    status: STORED_ONLY,
    fields: ['minCapacity'],
    why: 'Saved, but no service raises an under-staffing alert yet.',
  },
  {
    id: 'identity',
    status: STORED_ONLY,
    fields: ['privacy'],
    why: 'Saved, but the pipeline does not read it yet — faces are governed by '
      + 'the camera\'s own face-recognition switch.',
  },
]);

/** Is this section's setting actually acted on? */
export function isEnforced(id) {
  const row = RULE_SECTIONS.find((s) => s.id === id);
  return row ? row.status === ENFORCED : false;
}

/** One section's row, or null for an id nobody has classified. */
export function ruleSection(id) {
  return RULE_SECTIONS.find((s) => s.id === id) || null;
}

/**
 * The sections split into the two groups, each in declared order.
 *
 * Working FIRST, always: an operator reading top to bottom should meet the
 * controls that do something before the ones that do not. The second group
 * keeps its heading even when empty of surprises, because an unlabelled
 * section below a divider is just a section.
 */
export function groupSections(ids = RULE_SECTIONS.map((s) => s.id)) {
  const known = RULE_SECTIONS.filter((s) => ids.includes(s.id));
  return {
    working: known.filter((s) => s.status === ENFORCED),
    pending: known.filter((s) => s.status === STORED_ONLY),
  };
}

/** The heading over the second group. */
export const PENDING_HEADING = 'Not enforced yet';

/**
 * Said once under that heading, rather than per section.
 *
 * It has to answer "then why is it here?" — the answer being that the setting
 * is kept, so nothing typed is lost and no one has to come back and re-enter
 * it later.
 */
export const PENDING_NOTE = 'These save with the zone and are kept, but no service acts '
  + 'on them yet — nothing here will raise an alert. They are shown so the setting is '
  + 'not lost, and so this page does not claim a rule is armed when it is not.';
