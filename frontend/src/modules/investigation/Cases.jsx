// Cases (investigation toolkit I-4): one workspace per incident.
//   /investigate/cases       the account's cases (open / closed) + New case
//   /investigate/cases/:id   one case: pinned people, clips, journeys, notes;
//                            legal hold (keeps footage before the NVR overwrites
//                            it); timeline; members; activity log.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Download, FileText, FolderOpen, Footprints, Loader2, Lock, NotebookPen, Plus, ShieldCheck, Trash2, Unlock, User, Video,
} from 'lucide-react';

import { OperationsPage, PageCard, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import casesService, { keptFootageUrl } from '@/core/services/cases';
import { cropUrl } from '@/core/services/investigate';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import { cn } from '@/core/lib/utils';
import { KEEP_LABEL, auditText, canEdit, timeline } from './case-model';
import { isImported, playbackLink } from './search-model';
import { sizeLabel } from './evidence-model';
import EvidenceExportDialog from './EvidenceExportDialog';

const errText = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';
const fmt = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
const TYPE_ICON = { track: User, clip: Video, journey: Footprints, note: NotebookPen, evidence: ShieldCheck };
const TYPE_LABEL = { track: 'Person', clip: 'Clip', journey: 'Journey', note: 'Note', evidence: 'Evidence pack' };

export default function Cases() {
  const { caseId } = useParams();
  return caseId ? <CaseView key={caseId} caseId={caseId} /> : <CaseList />;
}

function CaseList() {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [title, setTitle] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    casesService.list(status).then(setRows).catch((e) => setError(errText(e)));
  }, [status]);

  const create = async (e) => {
    e.preventDefault();
    try {
      const c = await casesService.create({ title });
      navigate(`/investigate/cases/${c.id}`);
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <OperationsPage>
      <PageHeader icon={FolderOpen} title="Cases"
        description="One workspace per incident: the people, clips and journeys that matter, notes, who works on it, and a legal hold that keeps the footage." />
      <PageContent scroll className="gap-4 pb-6">
        <PageCard className="flex flex-wrap items-center gap-3 p-4">
          <form onSubmit={create} className="flex flex-1 gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="New case, e.g. Laptop theft at Gate 3"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-small text-fg" />
            <button type="submit" disabled={title.trim().length < 3}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-small font-semibold text-white disabled:opacity-50">
              <Plus className="h-4 w-4" /> New case
            </button>
          </form>
          <div className="flex rounded-lg border border-line p-0.5 text-small">
            {['open', 'closed'].map((s) => (
              <button key={s} type="button" onClick={() => setStatus(s)}
                className={cn('rounded-md px-3 py-1 capitalize', status === s ? 'bg-surface-sunken font-semibold text-fg' : 'text-fg-muted')}>{s}</button>
            ))}
          </div>
        </PageCard>
        {error ? <p className="text-small text-danger">{error}</p> : null}
        {!rows && !error ? <p className="flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p> : null}
        {rows?.length === 0 ? <p className="text-small text-fg-muted">No {status} cases. Start one above, or use <b>Add to case</b> on a search result.</p> : null}
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {(rows || []).map((c) => (
            <Link key={c.id} to={`/investigate/cases/${c.id}`}>
              <PageCard className="p-4 transition hover:border-brand">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12px] text-fg-muted">{c.label}</span>
                  <span className="flex items-center gap-2">
                    {c.legalHold ? <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 text-[11px] font-semibold text-fg-secondary"><Lock className="h-3 w-3" /> Legal hold</span> : null}
                    {c.priority === 'high' ? <span className="rounded-md bg-danger/10 px-1.5 text-[11px] font-semibold text-danger">High</span> : null}
                  </span>
                </div>
                <p className="mt-1 truncate text-body font-bold text-fg">{c.title}</p>
                <p className="mt-0.5 text-[12px] text-fg-muted">{c.items} {c.items === 1 ? 'item' : 'items'} · updated {fmt(c.updatedAt)} · by {c.createdBy}</p>
              </PageCard>
            </Link>
          ))}
        </div>
      </PageContent>
    </OperationsPage>
  );
}

function CaseView({ caseId }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [exporting, setExporting] = useState(null);
  const canExport = makeEntitlement(useAuthStore((s) => s.user)).has('evidence_export');

  const load = useCallback(() => {
    casesService.get(caseId).then((d) => { setC(d); setError(null); }).catch((e) => setError(errText(e)));
  }, [caseId]);
  useEffect(() => { load(); }, [load]);
  const pending = c?.items?.some((i) => ['queued', 'keeping'].includes(i.kept.status));
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [pending, load]);

  const act = async (fn) => {
    try { await fn(); load(); } catch (e) { setError(errText(e)); }
  };
  const edit = canEdit(c?.role);

  if (!c) {
    return (
      <OperationsPage>
        <PageHeader icon={FolderOpen} title="Case" />
        <PageContent>{error ? <p className="text-small text-danger">{error}</p> : <p className="flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}</PageContent>
      </OperationsPage>
    );
  }

  const pinned = c.items.filter((i) => i.type !== 'note');
  const notes = c.items.filter((i) => i.type === 'note');
  return (
    <OperationsPage>
      <PageHeader
        icon={FolderOpen}
        title={`${c.label} · ${c.title}`}
        description={c.description || `Opened by ${c.createdBy} on ${fmt(c.createdAt)}.`}
        actions={edit ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => act(() => casesService.update(c.id, { legalHold: !c.legalHold }))}
              title="Legal hold keeps every pinned person's index record and copies their footage off the recorder before it is overwritten"
              className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-small font-semibold',
                c.legalHold ? 'border-brand bg-brand/10 text-brand' : 'border-line text-fg-secondary hover:bg-surface-sunken')}>
              {c.legalHold ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />} Legal hold {c.legalHold ? 'on' : 'off'}
            </button>
            <button type="button" onClick={() => act(() => casesService.update(c.id, { status: c.status === 'open' ? 'closed' : 'open' }))}
              className="inline-flex h-9 items-center rounded-lg border border-line px-3 text-small font-semibold text-fg-secondary hover:bg-surface-sunken">
              {c.status === 'open' ? 'Close case' : 'Reopen case'}
            </button>
          </div>
        ) : <span className="text-small text-fg-muted">You can view this case</span>}
      />
      <PageContent scroll className="gap-4 pb-6">
        {error ? <PageCard className="p-3 text-small text-danger">{error}</PageCard> : null}

        <PageCard className="p-4">
          <h2 className="text-body font-bold text-fg">Pinned evidence</h2>
          {c.legalHold ? <p className="text-[12px] text-fg-muted">Legal hold is on: footage of every person and clip below is copied off the recorder and kept with its SHA-256.</p> : null}
          {!pinned.length ? <p className="mt-2 text-small text-fg-muted">Nothing pinned yet. Use <b>Add to case</b> on a Smart Search result, a journey, or a clip in Recordings.</p> : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {pinned.map((i) => (
              <ItemCard key={i.id} i={i} caseId={c.id} edit={edit} canExport={canExport}
                onKeep={() => act(() => casesService.keep(c.id, i.id))}
                onRemove={() => act(() => casesService.removeItem(c.id, i.id))}
                onExport={() => setExporting(i)} />
            ))}
          </div>
        </PageCard>

        <div className="grid gap-4 lg:grid-cols-2">
          <PageCard className="p-4">
            <h2 className="text-body font-bold text-fg">Notes</h2>
            {edit ? (
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await casesService.addItem(c.id, { type: 'note', note }); setNote(''); }); }}>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} placeholder="Add a note"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-small text-fg" />
                <button type="submit" disabled={!note.trim()} className="h-9 rounded-lg bg-brand px-3 text-small font-semibold text-white disabled:opacity-50">Add</button>
              </form>
            ) : null}
            <ul className="mt-3 space-y-2">
              {notes.slice().reverse().map((n) => (
                <li key={n.id} className="rounded-lg bg-surface-sunken p-2.5 text-small text-fg">
                  {n.note}
                  <p className="mt-1 text-[11px] text-fg-muted">{n.addedBy} · {fmt(n.addedAt)}</p>
                </li>
              ))}
            </ul>
          </PageCard>

          <PageCard className="p-4">
            <h2 className="text-body font-bold text-fg">Timeline</h2>
            <p className="text-[12px] text-fg-muted">What happened, in the order it happened.</p>
            <ol className="mt-2 space-y-1.5 border-l border-line pl-3">
              {timeline(c.items).map((i) => {
                const Icon = TYPE_ICON[i.type] || FileText;
                return (
                  <li key={i.id} className="text-small text-fg">
                    <span className="font-mono text-[12px] text-fg-muted">{fmt(i.from)}</span>{' '}
                    <Icon className="inline h-3.5 w-3.5 text-brand" /> {i.title || TYPE_LABEL[i.type]}{i.cameraName ? ` · ${i.cameraName}` : ''}
                    {i.type === 'note' ? <span className="text-fg-muted"> — {i.note}</span> : null}
                  </li>
                );
              })}
            </ol>
          </PageCard>

          <Members c={c} onChange={load} />

          <PageCard className="p-4">
            <h2 className="text-body font-bold text-fg">Activity</h2>
            <p className="text-[12px] text-fg-muted">Every view and change, kept with the case.</p>
            <ul className="mt-2 max-h-72 space-y-1 overflow-auto text-[12px] text-fg-secondary">
              {c.audit.map((a, k) => (
                <li key={k}><span className="font-mono text-fg-muted">{fmt(a.at)}</span> {a.by} {auditText(a.action)}</li>
              ))}
            </ul>
          </PageCard>
        </div>

        {exporting ? (
          <EvidenceExportDialog open onOpenChange={(o) => { if (!o) setExporting(null); }}
            camera={{ monitorId: exporting.monitorId, name: exporting.cameraName }}
            start={new Date(exporting.from)} end={new Date(exporting.to)}
            trackIds={exporting.ref?.trackId ? [exporting.ref.trackId] : []} />
        ) : null}
      </PageContent>
    </OperationsPage>
  );
}

function ItemCard({ i, caseId, edit, canExport, onKeep, onRemove, onExport }) {
  const Icon = TYPE_ICON[i.type] || FileText;
  const footage = i.type === 'track' || i.type === 'clip';
  const keep = KEEP_LABEL[i.kept.status];
  const play = i.monitorId ? playbackLink({ camera_code: i.monitorId, first_seen: i.from, last_seen: i.to }) : null;
  return (
    <article className="flex gap-3 rounded-xl border border-line bg-surface p-2.5">
      {i.type === 'track' && i.ref?.trackId ? (
        <img src={cropUrl(i.ref.trackId)} alt="" className="h-24 w-16 shrink-0 rounded-md bg-surface-sunken object-cover" />
      ) : (
        <div className="grid h-24 w-16 shrink-0 place-items-center rounded-md bg-surface-sunken"><Icon className="h-6 w-6 text-fg-muted" /></div>
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{TYPE_LABEL[i.type]}</p>
        <p className="truncate text-small font-semibold text-fg">{i.title || i.cameraName}</p>
        <p className="truncate text-[11px] text-fg-muted">{i.cameraName ? `${i.cameraName} · ` : ''}{fmt(i.from)}</p>
        {i.type === 'journey' ? <p className="truncate text-[11px] text-fg-muted">{(i.ref.stops || []).length} stops</p> : null}
        {i.note ? <p className="line-clamp-2 text-[11px] text-fg-secondary">{i.note}</p> : null}
        {keep ? (
          <p className={cn('text-[11px] font-semibold', i.kept.status === 'kept' ? 'text-success' : i.kept.status === 'failed' ? 'text-danger' : 'text-fg-muted')} title={i.kept.error || ''}>
            {keep}{i.kept.status === 'kept' ? ` · ${sizeLabel(i.kept.size)}` : ''}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 pt-0.5 text-[11px] font-semibold">
          {play ? <Link to={play} className="text-brand hover:underline">Play</Link> : null}
          {i.type === 'journey' && i.ref?.seedTrackId ? <Link to={`/investigate/track/${i.ref.seedTrackId}`} className="text-brand hover:underline">Open journey</Link> : null}
          {i.kept.status === 'kept' ? <a href={keptFootageUrl(caseId, i.id)} className="inline-flex items-center gap-0.5 text-brand hover:underline"><Download className="h-3 w-3" /> Kept copy</a> : null}
          {footage && edit && ['none', 'failed'].includes(i.kept.status) ? <button type="button" onClick={onKeep} className="text-brand hover:underline">Keep footage</button> : null}
          {footage && canExport && !isImported(i.monitorId) ? <button type="button" onClick={onExport} className="text-brand hover:underline">Evidence</button> : null}
          {edit ? <button type="button" onClick={onRemove} title="Remove from case" className="text-fg-muted hover:text-danger"><Trash2 className="h-3 w-3" /></button> : null}
        </div>
      </div>
    </article>
  );
}

function Members({ c, onChange }) {
  const [people, setPeople] = useState(null);
  const [who, setWho] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState(null);
  const owner = c.role === 'owner';
  useEffect(() => {
    if (owner) casesService.people().then(setPeople).catch(() => setPeople([]));
  }, [owner]);
  const candidates = (people || []).filter((p) => !c.members.some((m) => String(m.userId) === String(p.id)));
  const add = async () => {
    try { await casesService.setMember(c.id, who, role); setWho(''); onChange(); } catch (e) { setError(errText(e)); }
  };
  return (
    <PageCard className="p-4">
      <h2 className="text-body font-bold text-fg">Members</h2>
      <ul className="mt-2 space-y-1 text-small">
        {c.members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between gap-2">
            <span className="truncate text-fg">{m.name}</span>
            <span className="flex items-center gap-2 text-[12px] capitalize text-fg-muted">
              {m.role}
              {owner && m.role !== 'owner' ? (
                <button type="button" onClick={() => casesService.removeMember(c.id, m.userId).then(onChange).catch((e) => setError(errText(e)))}
                  className="text-fg-muted hover:text-danger" title="Remove"><Trash2 className="h-3 w-3" /></button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {owner && candidates.length ? (
        <div className="mt-3 flex gap-2">
          <select value={who} onChange={(e) => setWho(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-small text-fg">
            <option value="">Add someone from your account…</option>
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value)} className="h-8 rounded-lg border border-line bg-surface px-2 text-small text-fg">
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button type="button" disabled={!who} onClick={add} className="h-8 rounded-lg bg-brand px-3 text-small font-semibold text-white disabled:opacity-50">Add</button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-small text-danger">{error}</p> : null}
    </PageCard>
  );
}
