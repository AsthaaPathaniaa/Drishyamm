// Video synopsis (investigation phase 4): only the busy stretches of a range,
// sped up, with the real time burned in. Made on the server (GPU encode) from
// this server's recordings or an imported video; never from the recorder.
import { useEffect, useState } from 'react';
import { Clapperboard, Download, Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/core/ui/dialog';
import { synopsisService } from '@/core/services/investigate';

const mins = (s) => (s == null ? '' : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

/** @param {{ open, onOpenChange, camera: { monitorId, name }, from: Date|number, to: Date|number }} props */
export default function SynopsisDialog({ open, onOpenChange, camera, from, to }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !camera) return undefined;
    let live = true;
    synopsisService.start({ monitorId: camera.monitorId, from: new Date(from).toISOString(), to: new Date(to).toISOString() })
      .then((j) => { if (live) setJob(j); })
      .catch((e) => { if (live) setError(e?.response?.data?.message || e.message); });
    return () => { live = false; };
  }, [open, camera, from, to]);

  useEffect(() => {
    if (!job?.job_id || ['ready', 'failed'].includes(job.status)) return undefined;
    const t = setInterval(() => synopsisService.status(job.job_id).then(setJob).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [job?.job_id, job?.status]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Clapperboard className="h-5 w-5 text-brand" /> Synopsis · {camera?.name}</DialogTitle>
          <DialogDescription>
            Only the moments with people or vehicles, sped up, with the real time in the corner.
            {job?.span_s ? ` ${mins(job.span_s)} of footage → ${mins(job.out_s)} (${job.stretches} busy stretches at ${job.speed}×).` : ''}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-small text-danger">{error}</p> : null}
        {!error && (!job || ['queued', 'rendering'].includes(job.status)) ? (
          <p className="flex items-center gap-2 text-small text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Making the synopsis… {job?.progress ? `${Math.round(job.progress * 100)}%` : ''}
          </p>
        ) : null}
        {job?.status === 'failed' ? <p className="text-small text-danger">{job.error}</p> : null}
        {job?.status === 'ready' ? (
          <div className="space-y-2">
            <video src={synopsisService.videoUrl(job.job_id)} controls autoPlay className="w-full rounded-lg bg-black" />
            <a href={synopsisService.videoUrl(job.job_id)} download={`synopsis_${(camera?.name || 'camera').replace(/\W+/g, '_')}.mp4`}
              className="inline-flex items-center gap-1.5 text-small font-semibold text-brand hover:underline">
              <Download className="h-4 w-4" /> Download
            </a>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
