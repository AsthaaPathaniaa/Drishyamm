/**
 * Capacity & rules: four accordion sections, one per question.
 *
 *   Capacity & alerts        open by default -- a zone counts with just this
 *   Schedule & security      hours, off-hours lock
 *   Staffing & dwell         min staffing, loitering ceiling
 *   Access & identity        who may enter, whitelist, privacy mode
 *
 * Replaces one "More rules" drawer that opened everything at once into a
 * column taller than the screen. A closed section still says what is set in
 * one line ("09:00–18:00 · locked off-hours"), so a rule nobody expected is
 * visible without opening anything.
 *
 * It now renders inside the right-hand drawer (RulesDrawer.jsx) rather than a
 * third page column, and kept the accordion through that move -- the reasoning
 * is in that file, next to the decision.
 *
 * Which sections are open is remembered per browser: someone tuning dwell
 * across twenty zones should not reopen it twenty times.
 *
 * `locked` is a brand-new zone with no boundary yet. Everything but capacity
 * waits until it has one: the shape is the next thing to do, and schedules or
 * whitelists for a zone that does not exist yet are a distraction from it.
 */
import { useState } from 'react';
import {
  CalendarClock, ChevronRight, Gauge, Lock, ShieldCheck, Timer,
} from 'lucide-react';
import {
  CapacityStep, IdentityTracking, ScheduleRules, StaffingRules,
} from './StepBehaviour';
import StepAccess from './StepAccess';
import { summaries } from './rule-summary';
import {
  groupSections, isEnforced, PENDING_HEADING, PENDING_NOTE,
} from './rule-enforcement';

const OPEN_KEY = 'drishyam.zoneSetup.openSections';
const DEFAULT_OPEN = ['capacity'];

const readOpen = () => {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null');
    return new Set(Array.isArray(v) ? v : DEFAULT_OPEN);
  } catch { return new Set(DEFAULT_OPEN); }
};
const writeOpen = (set) => {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* storage blocked: per-visit */ }
};

export default function RuleSections({
  draft, set, access, lockedOut, suggestions, locked = false,
  // The camera this zone's rules run on, and the one action the access step
  // can take on it. Passed through rather than fetched here: ZoneSetup already
  // holds the AI camera registry, and a second reader of it could disagree
  // with the first about whether a detector is running.
  camera = null, onEnableBodyDetection, enablingBody = false, bodyNote = '',
}) {
  const [open, setOpen] = useState(readOpen);
  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeOpen(next);
    return next;
  });
  const sum = summaries(draft, lockedOut);

  const sections = [
    {
      id: 'capacity', icon: Gauge, title: 'Capacity & alerts',
      body: <CapacityStep draft={draft} lockedOut={lockedOut} set={set} />,
    },
    {
      id: 'schedule', icon: CalendarClock, title: 'Schedule & security',
      body: <ScheduleRules draft={draft} set={set} />,
    },
    {
      id: 'staffing', icon: Timer, title: 'Staffing & dwell',
      body: <StaffingRules draft={draft} set={set} />,
    },
    {
      id: 'access', icon: ShieldCheck, title: 'Access & who may enter',
      body: (
        <StepAccess
          access={access}
          alertAfterSec={draft.alertAfterSec ?? 5}
          bodyNote={bodyNote}
          camera={camera}
          enablingBody={enablingBody}
          onChange={(a) => set({ access: a })}
          onEnableBodyDetection={onEnableBodyDetection}
          onRule={set}
          severity={draft.severity || 'critical'}
          suggestions={suggestions}
        />
      ),
    },
    {
      // Lifted OUT of Access & identity. Every other setting in that section
      // reaches the engine; privacy reaches nothing. Sitting inside an
      // enforced section, it borrowed that section's credibility -- which is
      // the whole fault this split exists to fix.
      id: 'identity', icon: ShieldCheck, title: 'Identity & privacy',
      body: <IdentityTracking draft={draft} set={set} />,
    },
  ];
  const byId = Object.fromEntries(sections.map((x) => [x.id, x]));
  const { working, pending } = groupSections(sections.map((x) => x.id));

  /** One accordion section. Identical for both groups -- only the order and
   *  the heading above them differ, so a pending rule is not a second-class
   *  CONTROL, just an honestly labelled one. */
  const renderSection = (id) => {
    const { icon, title, body } = byId[id];
    const Icon = icon;
    const waits = locked && id !== 'capacity';
    const isOpen = !waits && open.has(id);
    const summary = waits ? 'Draw the boundary first' : (sum[id] || []).filter(Boolean).join(' · ');
    const enforced = isEnforced(id);
    return (
      <section className={`overflow-hidden rounded-lg border border-line bg-surface ${waits ? 'opacity-55' : ''}`} key={id}>
        <button
          aria-controls={`rules-${id}`}
          aria-expanded={isOpen}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition enabled:hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand disabled:cursor-not-allowed"
          disabled={waits}
          onClick={() => toggle(id)}
          type="button"
        >
          <Icon className={`h-4 w-4 shrink-0 ${enforced ? 'text-brand' : 'text-fg-subtle'}`} strokeWidth={2} />
          <span className={`shrink-0 text-heading font-bold ${enforced ? 'text-fg' : 'text-fg-muted'}`}>{title}</span>
          {!isOpen && summary ? (
            <span className="min-w-0 flex-1 truncate text-right text-small text-fg-subtle" title={summary}>{summary}</span>
          ) : <span className="flex-1" />}
          {waits ? <Lock className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2.25} /> : (
            <ChevronRight
              className={`h-4 w-4 shrink-0 text-fg-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`}
              strokeWidth={2.25}
            />
          )}
        </button>
        {/* No reason is repeated in the body: every control in a pending
            section is already wrapped in StepBehaviour's `NotEnforced`, which
            carries the badge and the specific reason beside the control
            itself. This split adds the ORDER and one heading, not a second
            copy of what the section already says. */}
        {isOpen ? (
          <div className="border-t border-line-subtle px-3 py-2.5" id={`rules-${id}`}>{body}</div>
        ) : null}
      </section>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {/* WORKING FIRST. Someone reading top to bottom meets the controls that
          do something before the ones that do not. */}
      {working.map((sec) => renderSection(sec.id))}

      {pending.length > 0 && (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-caption font-bold uppercase tracking-wider text-fg-subtle">
              {PENDING_HEADING}
            </span>
            <span className="h-px min-w-0 flex-1 bg-line" />
          </div>
          <p className="text-caption leading-relaxed text-fg-muted">{PENDING_NOTE}</p>
          {pending.map((sec) => renderSection(sec.id))}
        </>
      )}
    </div>
  );
}
