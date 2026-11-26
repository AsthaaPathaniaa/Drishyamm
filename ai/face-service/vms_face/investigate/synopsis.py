"""Video synopsis (investigation phase 4): hours of footage in minutes.

A *reel* of only the busy stretches of one camera (Smart Skim's segments from
the index), each sped up and stamped with its real local time, joined into one
MP4. Classic synopsis also overlays people from different times into one
frame; that needs every frame of every person, which the index doesn't keep,
so this does what can be shown faithfully: nothing invented, every frame real,
every frame timed.

Sources: this server's recordings (journey/recordings.locate_window, the same
locator the journey video uses) or an imported file (I-7). Never the NVR.
GPU: NVENC encode when the host has it, else libx264.

Pure planning (plan) is unit-tested; render() runs ffmpeg.
"""
from __future__ import annotations

import datetime as dt
import math
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from vms_face.core.logging import get_logger

log = get_logger(__name__)

TARGET_S = 180.0          # aim for about 3 minutes of output
MIN_SPEED, MAX_SPEED = 2.0, 16.0
PAD_S = 2.0

Span = tuple[dt.datetime, dt.datetime]


@dataclass
class Plan:
    pieces: list[Span]
    speed: float
    busy_s: float
    span_s: float
    out_s: float


def plan(segments: Sequence[Span], since: dt.datetime, until: dt.datetime, *,
         target_s: float = TARGET_S, speed: float | None = None) -> Plan:
    """Which stretches to show and how fast: the slowest speed (≥ 2×) that
    keeps the reel near `target_s`, at most 16×."""
    pieces = [(max(a, since), min(b, until)) for a, b in segments if b > since and a < until]
    pieces = [(a, b) for a, b in pieces if (b - a).total_seconds() >= 1.0]
    busy = sum((b - a).total_seconds() for a, b in pieces)
    if speed is None:
        speed = min(MAX_SPEED, max(MIN_SPEED, math.ceil(busy / max(1.0, target_s))))
    speed = float(min(MAX_SPEED, max(1.0, speed)))
    return Plan(pieces=pieces, speed=speed, busy_s=round(busy, 1), span_s=round((until - since).total_seconds(), 1),
                out_s=round(busy / speed, 1))


@dataclass
class SynopsisJob:
    job_id: str
    tenant_id: uuid.UUID
    camera_code: str
    camera_name: str
    since: dt.datetime
    until: dt.datetime
    tz_offset_min: int
    plan: Plan | None = None
    status: str = "queued"          # queued | rendering | ready | failed
    progress: float = 0.0
    error: str | None = None
    output_key: str | None = None
    size: int | None = None
    encoder: str | None = None
    took_s: float | None = None
    created: float = field(default_factory=time.time)

    def view(self) -> dict[str, Any]:
        p = self.plan
        return {
            "job_id": self.job_id, "status": self.status, "progress": round(self.progress, 3), "error": self.error,
            "camera_code": self.camera_code, "camera_name": self.camera_name,
            "since": self.since.isoformat(), "until": self.until.isoformat(),
            "speed": p.speed if p else None, "busy_s": p.busy_s if p else None, "span_s": p.span_s if p else None,
            "out_s": p.out_s if p else None, "stretches": len(p.pieces) if p else None,
            "size": self.size, "encoder": self.encoder, "took_s": self.took_s,
        }


_jobs: dict[str, SynopsisJob] = {}
_lock = threading.Lock()


def get(job_id: str) -> SynopsisJob | None:
    return _jobs.get(job_id)


def _nvenc_ok() -> bool:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x144:r=25",
                        "-t", "0.2", "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True, timeout=30)
    return r.returncode == 0


_ENC: list[str] | None = None


def _encoder() -> list[str]:
    global _ENC
    if _ENC is None:
        _ENC = ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "28"] if _nvenc_ok() else \
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]
    return _ENC


def _sources(job: SynopsisJob, a: dt.datetime, b: dt.datetime, file_source: tuple[str, dt.datetime] | None) -> list[tuple[str, float, float, dt.datetime]]:
    """(path, seek_s, take_s, real start of the take) for [a, b]."""
    if file_source:
        path, start = file_source
        seek = max(0.0, (a - start).total_seconds())
        return [(path, seek, (b - a).total_seconds(), a)]
    from vms_face.journey import recordings

    return [(str(s.path), s.seek_sec, s.take_sec, s.segment_started_at + dt.timedelta(seconds=s.seek_sec))
            for s in recordings.locate_window(job.camera_code, a, b)]


def render(job: SynopsisJob, file_source: tuple[str, dt.datetime] | None, upload) -> None:
    """Cut, stamp, speed up and join the busy stretches; `upload(path, key)` stores the result."""
    from vms_face.config import settings

    job.status = "rendering"
    t0 = time.time()
    work = Path(tempfile.mkdtemp(prefix="vms-synopsis-"))
    enc = _encoder()
    job.encoder = enc[1]
    font = settings.stitch_font_path
    try:
        pieces: list[Path] = []
        total = max(1, len(job.plan.pieces))
        for i, (a, b) in enumerate(job.plan.pieces):
            for j, (path, seek, take, real_start) in enumerate(_sources(job, a - dt.timedelta(seconds=PAD_S), b + dt.timedelta(seconds=PAD_S), file_source)):
                out = work / f"p{i:04d}_{j:02d}.mp4"
                epoch = int(real_start.timestamp()) + job.tz_offset_min * 60
                stamp = (f"drawtext=fontfile={font}:text='%{{pts\\:gmtime\\:{epoch}\\:%d %b %H\\\\\\:%M\\\\\\:%S}}  "
                         f"{job.speed_label()}':x=16:y=16:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8")
                vf = f"{stamp},setpts=PTS/{job.plan.speed},scale=-2:'min(720,ih)',fps=25"
                cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{seek:.3f}", "-t", f"{take:.3f}",
                       "-i", path, "-vf", vf, "-an", *enc, "-pix_fmt", "yuv420p", str(out)]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
                if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
                    pieces.append(out)
                else:
                    log.warning("synopsis piece failed", job=job.job_id, err=(r.stderr or "")[-300:])
            job.progress = 0.05 + 0.85 * (i + 1) / total
        if not pieces:
            raise RuntimeError("no footage could be read for the busy stretches (no recordings on this server for that time?)")
        lst = work / "list.txt"
        lst.write_text("".join(f"file '{p.name}'\n" for p in pieces))
        final = work / "synopsis.mp4"
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                            "-c", "copy", "-movflags", "+faststart", str(final)], capture_output=True, text=True, timeout=600, cwd=work)
        if r.returncode != 0:
            raise RuntimeError(f"joining the pieces failed: {(r.stderr or '')[-200:]}")
        key = f"{job.tenant_id}/synopsis/{job.job_id}.mp4"
        upload(final, key)
        job.output_key, job.size = key, final.stat().st_size
        job.status, job.progress = "ready", 1.0
    except Exception as e:
        job.status, job.error = "failed", str(e)[:400]
        log.warning("synopsis failed", job=job.job_id, err=str(e))
    finally:
        job.took_s = round(time.time() - t0, 1)
        shutil.rmtree(work, ignore_errors=True)


def _speed_label(self: SynopsisJob) -> str:
    return f"{self.plan.speed:g}×" if self.plan else ""


SynopsisJob.speed_label = _speed_label  # type: ignore[attr-defined]


def start(job: SynopsisJob, file_source: tuple[str, dt.datetime] | None, upload) -> SynopsisJob:
    """Run one job at a time in a background thread (ffmpeg does the GPU work)."""
    _jobs[job.job_id] = job

    def run():
        with _lock:
            render(job, file_source, upload)

    threading.Thread(target=run, name=f"synopsis-{job.job_id[:8]}", daemon=True).start()
    return job
