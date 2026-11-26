// "Export evidence": a sealed pack of one camera's footage for a range, with
// a reason that goes into the export log and the report. Opened from a Smart
// Search result (range around the person) or from Recordings (the clip range).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/core/ui/dialog';
import { Button } from '@/core/ui/button';
import evidenceService from '@/core/services/evidence';
import { exportProblem, toLocalInput } from './evidence-model';

/**
 * @param {{ open, onOpenChange, camera: { monitorId, name }, start: Date, end: Date,
 *           trackIds?: string[], scores?: object }} props
 */
export default function EvidenceExportDialog({ open, onOpenChange, camera, start, end, trackIds = [], scores = {} }) {
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setFrom(start ? toLocalInput(start) : '');
    // A range that runs into the future ends at the latest recorded moment.
    setTo(end ? toLocalInput(Math.min(new Date(end).getTime(), Date.now() - 5000)) : '');
    setError(null);
  }, [open, start, end]);

  const req = { start: from ? new Date(from) : null, end: to ? new Date(to) : null, reason };
  const problem = exportProblem(req);

  const submit = async () => {
    if (problem || !camera) return;
    setBusy(true);
    setError(null);
    try {
      await evidenceService.create({
        monitorId: camera.monitorId, start: req.start.toISOString(), end: req.end.toISOString(),
        reason: reason.trim(), trackIds, scores,
      });
      onOpenChange(false);
      setReason('');
      navigate('/investigate/evidence');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not start the export.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-brand" /> Export evidence</DialogTitle>
          <DialogDescription>
            A sealed pack from <b>{camera?.name || camera?.monitorId}</b>: the recorder’s original footage, an H.264 copy,
            a report with a draft Section 63 certificate, and a signed list of SHA-256 hashes. Any later change to any file shows up when the pack is verified.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-small font-medium text-fg-secondary">
              From
              <input type="datetime-local" step="1" value={from} onChange={(e) => setFrom(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2 text-small text-fg" />
            </label>
            <label className="grid gap-1 text-small font-medium text-fg-secondary">
              To
              <input type="datetime-local" step="1" value={to} onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2 text-small text-fg" />
            </label>
          </div>
          <label className="grid gap-1 text-small font-medium text-fg-secondary">
            Why is this footage being exported?
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000}
              placeholder="e.g. Theft of a laptop at Gate 3 reported by the site manager; FIR 123/2026 requested by police"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-small text-fg" />
            <span className="text-[12px] font-normal text-fg-muted">Saved in the export log and printed in the report. Required.</span>
          </label>
          {trackIds.length ? (
            <p className="text-[12px] text-fg-muted">Includes the Smart Search photo of {trackIds.length === 1 ? 'this person' : `${trackIds.length} people`}.</p>
          ) : null}
          <p className="text-[12px] text-fg-muted">The recorder replays the footage in real time, so the pack takes about as long as the range to build. You can leave this page.</p>
          {error || (problem && reason) ? <p className="text-small text-danger">{error || problem}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || Boolean(problem)}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Export evidence
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
