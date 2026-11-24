// "Add to case": pin a person, a journey or a clip to an open case, or start a
// new case with it. Used from Smart Search, the journey page and Recordings.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderPlus, Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/core/ui/dialog';
import { Button } from '@/core/ui/button';
import casesService from '@/core/services/cases';

const NEW = '__new__';

/** @param {{ open, onOpenChange, item: object, what: string }} props  item = case item payload (case-model itemFrom) */
export default function AddToCaseDialog({ open, onOpenChange, item, what }) {
  const [cases, setCases] = useState(null);
  const [pick, setPick] = useState(NEW);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setError(null);
    casesService.list('open').then((list) => {
      setCases(list);
      setPick(list[0]?.id || NEW);
    }).catch((e) => setError(e?.response?.data?.message || e.message));
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = pick === NEW ? await casesService.create({ title }) : cases.find((x) => x.id === pick);
      await casesService.addItem(c.id, { ...item, note: note.trim() || undefined });
      setDone(c);
    } catch (e) {
      setError(e?.response?.data?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const invalid = pick === NEW ? title.trim().length < 3 : !pick;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FolderPlus className="h-5 w-5 text-brand" /> Add to case</DialogTitle>
          <DialogDescription>{what}</DialogDescription>
        </DialogHeader>
        {done ? (
          <p className="text-small text-fg">
            Added to <Link to={`/investigate/cases/${done.id}`} className="font-semibold text-brand hover:underline">{done.label} {done.title}</Link>.
          </p>
        ) : (
          <div className="grid gap-3">
            {!cases && !error ? <p className="flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading cases…</p> : null}
            {cases ? (
              <label className="grid gap-1 text-small font-medium text-fg-secondary">
                Case
                <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-small text-fg">
                  {cases.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.title}</option>)}
                  <option value={NEW}>+ New case…</option>
                </select>
              </label>
            ) : null}
            {pick === NEW && cases ? (
              <label className="grid gap-1 text-small font-medium text-fg-secondary">
                New case title
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="e.g. Laptop theft at Gate 3"
                  className="h-9 rounded-lg border border-line bg-surface px-3 text-small text-fg" />
              </label>
            ) : null}
            <label className="grid gap-1 text-small font-medium text-fg-secondary">
              Note (optional)
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-small text-fg" />
            </label>
            {error ? <p className="text-small text-danger">{error}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{done ? 'Close' : 'Cancel'}</Button>
          {!done ? (
            <Button onClick={submit} disabled={busy || invalid || !cases}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Add
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
