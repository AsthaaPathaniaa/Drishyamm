import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/core/lib/utils';

const pad = (n) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

function Column({ items, selected, onPick, label }) {
  return (
    <div role="listbox" aria-label={label} className="max-h-56 w-12 overflow-y-auto overscroll-contain py-1 [scrollbar-width:thin]">
      {items.map((v) => {
        const on = v === selected;
        return (
          <button
            key={v}
            type="button"
            role="option"
            aria-selected={on}
            data-selected={on}
            onClick={() => onPick(v)}
            className={cn(
              'block w-full rounded-md py-1 text-center text-small font-medium tabular-nums transition',
              on ? 'bg-brand text-white' : 'text-fg-secondary hover:bg-surface-sunken hover:text-fg',
            )}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A time field (HH:MM) with a Drishyam-themed drop-down. The browser's own
 * time picker can't be styled (see index.css), so the clock button opens this
 * panel instead; typing in the field still works as before.
 *
 * `onChange` receives the new "HH:MM" string. `onKeyDown` goes to the input.
 */
export default function TimeField({ value, onChange, onKeyDown, ariaLabel, className }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const [hh = '00', mm = '00'] = (value || '').split(':');

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // Bring the selected hour and minute into view.
    rootRef.current?.querySelectorAll('[data-selected="true"]').forEach((el) => {
      const list = el.parentElement;
      list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
    });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickHour = (h) => onChange(`${h}:${mm}`);
  const pickMinute = (m) => {
    onChange(`${hh}:${m}`);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <span ref={rootRef} className="relative inline-flex items-center gap-1.5">
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Choose ${ariaLabel?.toLowerCase() || 'time'}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn('transition hover:text-fg', open ? 'text-brand' : 'text-fg-muted')}
      >
        <Clock className="h-4 w-4" />
      </button>
      <input
        ref={inputRef}
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label={ariaLabel}
        className={className}
      />
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-2 flex gap-1 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          <Column items={HOURS} selected={hh} onPick={pickHour} label="Hour" />
          <span aria-hidden className="w-px self-stretch bg-line" />
          <Column items={MINUTES} selected={mm} onPick={pickMinute} label="Minute" />
        </div>
      ) : null}
    </span>
  );
}
