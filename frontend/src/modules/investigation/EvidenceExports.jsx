// Evidence (investigation toolkit I-5): the account's export log — every pack,
// who made it and why, its hashes and its download — and "Verify a pack":
// upload a ZIP and see whether anything in it changed since it was exported.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Download, FileWarning, Loader2, ShieldCheck, Upload, XCircle } from 'lucide-react';

import { OperationsPage, PageCard, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import evidenceService, { evidenceDownloadUrl } from '@/core/services/evidence';
import { cn } from '@/core/lib/utils';
import { sizeLabel, verdict } from './evidence-model';

const fmt = (d) => new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });

export default function EvidenceExports() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    evidenceService.list().then((r) => { setRows(r); setError(null); })
      .catch((e) => setError(e?.response?.data?.message || e.message));
  }, []);

  useEffect(() => { load(); }, [load]);
  const building = rows?.some((r) => r.status === 'building');
  useEffect(() => {
    if (!building) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [building, load]);

  return (
    <OperationsPage>
      <PageHeader
        icon={ShieldCheck}
        title="Evidence"
        description="Sealed evidence packs exported from this account, and a check that a pack hasn't been changed since."
        actions={<Link to="/investigate" className="text-small font-semibold text-brand hover:underline">Smart Search</Link>}
      />
      <PageContent scroll className="gap-4 pb-6">
        <VerifyPanel />

        <PageCard className="overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-body font-bold text-fg">Export log</h2>
            <p className="text-[12px] text-fg-muted">Every export, with the reason given. Entries stay here even after the file is deleted.</p>
          </div>
          {error ? <p className="p-4 text-small text-danger">{error}</p> : null}
          {rows && !rows.length ? (
            <p className="p-4 text-small text-fg-muted">
              No evidence exported yet. Use <b>Export evidence</b> on a Smart Search result or in Recordings.
            </p>
          ) : null}
          {!rows && !error ? <p className="flex items-center gap-2 p-4 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p> : null}
          <ul className="divide-y divide-line">
            {(rows || []).map((r) => <ExportRow key={r.id} r={r} />)}
          </ul>
        </PageCard>
      </PageContent>
    </OperationsPage>
  );
}

function ExportRow({ r }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-small font-semibold text-fg">{r.cameraName || r.monitorId} · {fmt(r.start)} – {fmt(r.end)}</p>
          <p className="mt-0.5 text-[12px] text-fg-muted">“{r.reason}” · by {r.createdBy || 'someone'} on {fmt(r.createdAt)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {r.status === 'building' ? (
            <span className="inline-flex items-center gap-1.5 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Building…</span>
          ) : r.status === 'failed' ? (
            <span className="inline-flex items-center gap-1.5 text-small text-danger" title={r.error || ''}><XCircle className="h-4 w-4" /> Failed</span>
          ) : (
            <>
              <button type="button" onClick={() => setOpen((v) => !v)} className="text-small text-fg-muted hover:text-fg">
                {open ? 'Hide hashes' : 'Hashes'}
              </button>
              <a href={evidenceDownloadUrl(r.id)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-small font-semibold text-fg-secondary hover:bg-surface-sunken">
                <Download className="h-4 w-4" /> {sizeLabel(r.zipSize)}
              </a>
            </>
          )}
        </div>
      </div>
      {r.status === 'failed' && r.error ? <p className="mt-1 text-[12px] text-danger">{r.error}</p> : null}
      {open ? (
        <div className="mt-2 space-y-1 rounded-lg bg-surface-sunken p-3 font-mono text-[11px] text-fg-secondary">
          <p>pack.zip  {r.zipSha256}</p>
          <p>manifest  {r.manifestSha256}</p>
          {r.files.map((f) => <p key={f.path}>{f.path}  {f.sha256}</p>)}
          <p className="pt-1 font-sans text-fg-muted">Signing key fingerprint: {r.keyFingerprint} · downloaded {r.downloads}×</p>
        </div>
      ) : null}
    </li>
  );
}

function VerifyPanel() {
  const fileRef = useRef(null);
  const [state, setState] = useState({ busy: false, progress: 0, result: null, error: null, name: '' });

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setState({ busy: true, progress: 0, result: null, error: null, name: file.name });
    try {
      const result = await evidenceService.verify(file, (p) => setState((s) => ({ ...s, progress: p.total ? p.loaded / p.total : 0 })));
      setState({ busy: false, progress: 1, result, error: null, name: file.name });
    } catch (err) {
      setState({ busy: false, progress: 0, result: null, error: err?.response?.data?.message || err.message, name: file.name });
    }
  };

  const v = verdict(state.result);
  return (
    <PageCard className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-body font-bold text-fg">Verify a pack</h2>
          <p className="text-[12px] text-fg-muted">Upload an evidence ZIP. Every file’s SHA-256 and the signature are checked; one changed byte fails.</p>
        </div>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={state.busy}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary hover:bg-surface-sunken disabled:opacity-50">
          {state.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {state.busy ? `Checking ${Math.round(state.progress * 100)}%` : 'Choose ZIP'}
        </button>
        <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" onChange={onFile} />
      </div>
      {state.error ? <p className="mt-3 text-small text-danger">{state.error}</p> : null}
      {v ? (
        <div className={cn('mt-3 flex items-start gap-2 rounded-lg border p-3 text-small',
          v.tone === 'ok' ? 'border-success text-fg' : 'border-danger text-fg')}>
          {v.tone === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
          <div>
            <p className="font-semibold">{state.name}</p>
            <p>{v.text}</p>
            {state.result?.logged ? (
              <p className="mt-1 text-[12px] text-fg-muted">
                Export log: {state.result.logged.cameraName}, “{state.result.logged.reason}”, by {state.result.logged.createdBy} on {fmt(state.result.logged.createdAt)}.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </PageCard>
  );
}
