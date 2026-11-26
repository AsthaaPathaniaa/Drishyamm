import { useState } from 'react';
import { ScanFace, PersonStanding, TriangleAlert } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/core/ui/dialog';
import { Button } from '@/core/ui/button';

/**
 * Choose what watches for people, before a zone is drawn rather than after.
 *
 * A zone detects nothing itself: it applies its rules to boxes a PRODUCER
 * publishes, and a camera with neither producer on carries a zone that can
 * never fire. The side panel's "Draw a zone" used to navigate anyway -- the
 * operator picked a camera, drew a shape, named it, set its rules, pressed
 * Save, and learned from a 409 that none of it could work. Everything between
 * the click and the save was wasted, and the message arrived where it reads as
 * "your work is lost" rather than "choose a detector first".
 *
 * A CHOICE, NOT A CONFIRMATION. Face and body are different trade-offs -- one
 * tells you who and misses a covered face, the other catches anyone and names
 * nobody -- and which is right depends on what the zone is for. A yes/no
 * dialog would be this component picking for the operator, and picking wrong
 * about half the time. So both options are offered with what each costs, and
 * the one that suits a strict lockout is marked, because that is the case
 * where the wrong choice is a zone that misses the person it was drawn for.
 *
 * Nothing is navigated until a choice has been applied: `onChoose` is awaited,
 * and a failure keeps the dialog open with the reason, because a camera that
 * did not change is a camera whose zone still cannot fire.
 */
export function ZoneDetectorDialog({ open, onOpenChange, entry, onChoose }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  if (!entry) return null;

  const pick = async (option) => {
    setError(null);
    setBusy(option.id);
    try {
      await onChoose?.(option);
      onOpenChange?.(false);
    } catch (err) {
      setError(
        err?.response?.data?.message
        || err?.message
        || 'The camera could not be changed. Nothing was drawn, so nothing is lost.',
      );
    } finally {
      setBusy(null);
    }
  };

  const icon = (id) => (id === 'body'
    ? <PersonStanding className="h-4 w-4 shrink-0" strokeWidth={2.25} />
    : <ScanFace className="h-4 w-4 shrink-0" strokeWidth={2.25} />);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange?.(v); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry.title}</DialogTitle>
          <DialogDescription className="mt-1">{entry.body}</DialogDescription>
        </DialogHeader>

        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-danger-line bg-danger-soft
                        px-3 py-2 text-small font-medium text-danger-ink">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} />
            <span className="min-w-0 flex-1">{error}</span>
          </p>
        )}

        <div className="flex flex-col gap-2.5">
          {entry.options.map((option) => (
            <button
              className="group rounded-xl border border-line bg-surface px-4 py-3 text-left transition
                         hover:border-brand/50 hover:bg-brand-soft/40 focus-visible:outline-none
                         focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-wait
                         disabled:opacity-60"
              disabled={Boolean(busy)}
              key={option.id}
              onClick={() => pick(option)}
              type="button"
            >
              <span className="flex items-center gap-2 text-body font-semibold text-fg">
                {icon(option.id)}
                {busy === option.id ? 'Switching on…' : option.label}
                {option.recommendedFor === 'lockout' && (
                  <span className="rounded bg-brand-soft px-1.5 py-0.5 text-micro font-bold
                                   uppercase tracking-wide text-brand-ink">
                    for lockout
                  </span>
                )}
              </span>
              <span className="mt-1 block text-caption leading-relaxed text-fg-muted">
                {option.detail}
              </span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button
            disabled={Boolean(busy)}
            onClick={() => onOpenChange?.(false)}
            type="button"
            variant="outline"
          >
            {/* Not "Cancel": leaving is a legitimate answer, and this says what
                leaving means -- the zone is not drawn, and nothing changed. */}
            Don&apos;t draw a zone yet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ZoneDetectorDialog;
