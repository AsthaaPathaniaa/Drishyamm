"""File import (I-7): index an uploaded video like a camera.

The backend stores the upload under `investigate_imports_root` (SHA-256 taken
while writing) and asks us to index it. One job at a time, on the GPU:

    PyAV decode (NVDEC when RTSP_HWACCEL=cuda, opened under the CUDA gate)
      → every 1/sample_fps s: YOLO person boxes → CameraIndexer (same tracker,
        best crop, fingerprint, colours as live cameras) → IndexWriter
      → tracks with source='file' on a virtual camera `file:<import_id>`,
        dated from the video's recorded start time.

Imported tracks are not removed by time-based retention (an old phone video
would vanish at the next sweep); they go when the import is deleted.

Job state lives in memory: a restart marks running jobs lost; the backend
shows that and can start the import again.
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from vms_face.core.logging import get_logger

log = get_logger(__name__)

BATCH = 16


@dataclass
class ImportJob:
    import_id: str
    tenant_id: uuid.UUID
    path: str
    name: str
    recorded_start: dt.datetime
    sample_fps: float = 8.0
    status: str = "queued"            # queued | indexing | ready | failed
    progress: float = 0.0
    duration_s: float | None = None
    tracks: int = 0
    frames: int = 0
    error: str | None = None
    hw_decode: bool | None = None
    started_at: float | None = None
    finished_at: float | None = None
    camera_id: uuid.UUID | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def view(self) -> dict[str, Any]:
        took = (self.finished_at or time.time()) - self.started_at if self.started_at else None
        return {
            "import_id": self.import_id, "status": self.status, "progress": round(self.progress, 4),
            "duration_s": self.duration_s, "tracks": self.tracks, "frames": self.frames, "error": self.error,
            "hw_decode": self.hw_decode, "took_s": round(took, 1) if took else None,
            "camera_code": camera_code(self.import_id),
        }


def camera_code(import_id: str) -> str:
    return f"file:{import_id}"


def safe_path(root: str, path: str) -> Path:
    """The file must be inside the imports root (the backend writes there)."""
    base = Path(root).resolve()
    p = Path(path).resolve()
    if base not in p.parents or not p.is_file():
        raise ValueError("file not found in the imports folder")
    return p


_jobs: dict[str, ImportJob] = {}
_queue: asyncio.Queue | None = None
_worker: asyncio.Task | None = None


def get_job(import_id: str) -> ImportJob | None:
    return _jobs.get(import_id)


def submit(job: ImportJob) -> ImportJob:
    global _queue, _worker
    old = _jobs.get(job.import_id)
    if old and old.status in ("queued", "indexing"):
        return old
    _jobs[job.import_id] = job
    if _queue is None:
        _queue = asyncio.Queue()
    if _worker is None or _worker.done():
        _worker = asyncio.get_running_loop().create_task(_run_queue(), name="investigate-file-import")
    _queue.put_nowait(job)
    return job


async def _run_queue() -> None:
    assert _queue is not None
    while True:
        job = await _queue.get()
        if job.cancel.is_set():
            continue
        try:
            await run(job)
        except Exception as e:     # never let one file stop the queue
            job.status, job.error, job.finished_at = "failed", str(e)[:400], time.time()
            log.warning("import failed", import_id=job.import_id, err=str(e))


async def ensure_camera(job: ImportJob) -> uuid.UUID:
    """The virtual camera the import's tracks hang off (never started live)."""
    from sqlalchemy import select
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from vms_face.domain.enums import CameraStatus
    from vms_face.api.routes.legacy import _ensure_tenant_by_id
    from vms_face.domain.models import Camera
    from vms_face.infra.postgres import session_scope

    code = camera_code(job.import_id)
    async with session_scope() as s:
        await _ensure_tenant_by_id(s, job.tenant_id)
        await s.execute(pg_insert(Camera).values(
            id=uuid.uuid4(), tenant_id=job.tenant_id, code=code, name=job.name[:256], rtsp_url=f"file://{job.path}",
            enabled=False, status=CameraStatus.OFFLINE,
            config_json={"import": True, "recorded_start": job.recorded_start.isoformat(), "path": job.path},
        ).on_conflict_do_update(index_elements=["tenant_id", "code"], set_={
            # Re-indexing may come with a corrected recording time.
            "config": {"import": True, "recorded_start": job.recorded_start.isoformat(), "path": job.path},
            "name": job.name[:256],
        }))
        cid = (await s.execute(select(Camera.id).where(Camera.tenant_id == job.tenant_id, Camera.code == code))).scalar_one()
    return cid


def _detector():
    from vms_face.config import settings
    from vms_face.infra.person_detector import YOLOPersonDetector

    global _det
    try:
        return _det
    except NameError:
        pass
    path = (settings.pipeline_person_model_path or "/srv/data/models/yolov8n.onnx").strip()
    _det = YOLOPersonDetector(path, det_size=int(settings.pipeline_person_det_size),
                              score_threshold=float(settings.pipeline_person_threshold))
    return _det


async def run(job: ImportJob) -> None:
    from vms_face.investigate.indexer import CameraIndexer, IndexWriter

    job.status, job.started_at = "indexing", time.time()
    job.camera_id = await ensure_camera(job)
    # Re-indexing (e.g. with a corrected recording time) replaces what the
    # previous run found instead of adding a second copy of everyone.
    await _clear_tracks(job.tenant_id, job.camera_id)
    loop = asyncio.get_running_loop()
    writer = IndexWriter()
    pending: list = []
    start_ts = job.recorded_start.timestamp()
    clock = {"t": start_ts}

    def sink(summary):
        summary.source = "file"
        pending.append(summary)

    indexer = CameraIndexer(job.camera_id, job.tenant_id, sink, clock=lambda: clock["t"], heartbeat_s=1e9)
    vehicle_indexer = CameraIndexer(job.camera_id, job.tenant_id, sink, clock=lambda: clock["t"], heartbeat_s=1e9,
                                    object_class="vehicle")

    def flush(force: bool = False) -> None:
        while len(pending) >= BATCH or (force and pending):
            batch = pending[:BATCH]
            del pending[:BATCH]
            asyncio.run_coroutine_threadsafe(writer.write_batch(batch), loop).result()
            job.tracks += len(batch)

    def decode_all() -> None:
        import av
        from vms_face.config import settings
        from vms_face.infra.cuda_gate import cuda_init_gate
        from vms_face.infra.person_detector import detect_people_and_vehicles

        det = _detector()
        hw = None
        if (settings.rtsp_hwaccel or "").strip().lower() == "cuda":
            from av.codec.hwaccel import HWAccel
            hw = HWAccel(device_type="cuda", allow_software_fallback=True)
        with (cuda_init_gate("import nvdec open") if hw is not None else contextlib.nullcontext()):
            container = av.open(job.path, hwaccel=hw)
        try:
            stream = next(s for s in container.streams if s.type == "video")
            stream.thread_type = "AUTO"
            dur = float(stream.duration * stream.time_base) if stream.duration else (
                container.duration / 1e6 if container.duration else None)
            job.duration_s = round(dur, 2) if dur else None
            job.hw_decode = hw is not None          # NVDEC requested (falls back to CPU if the codec isn't supported)
            step = 1.0 / max(0.5, job.sample_fps)
            next_t = 0.0
            for frame in container.decode(stream):
                if job.cancel.is_set():
                    raise RuntimeError("cancelled")
                if frame.pts is None:
                    continue
                t = float(frame.pts * stream.time_base)
                if t + 1e-6 < next_t:
                    continue
                next_t = t + step
                img = frame.to_ndarray(format="bgr24")
                clock["t"] = start_ts + t
                people, vehicles = detect_people_and_vehicles(det, img)
                indexer.step(img, people)
                vehicle_indexer.step(img, vehicles)
                job.frames += 1
                if dur:
                    job.progress = min(0.99, t / dur)
                flush()
            indexer.flush()
            vehicle_indexer.flush()
            flush(force=True)
        finally:
            with (cuda_init_gate("import nvdec close") if hw is not None else contextlib.nullcontext()):
                container.close()

    await loop.run_in_executor(None, decode_all)
    job.status, job.progress, job.finished_at = "ready", 1.0, time.time()
    log.info("import indexed", import_id=job.import_id, tracks=job.tracks, frames=job.frames,
             seconds=round(job.finished_at - job.started_at, 1), video_s=job.duration_s)


async def _clear_tracks(tenant_id: uuid.UUID, camera_id: uuid.UUID) -> int:
    """Remove every indexed track of one import camera (rows, vectors, crops)."""
    from qdrant_client.http.models import FieldCondition, Filter, MatchValue
    from sqlalchemy import delete, select

    from vms_face.config import settings
    from vms_face.domain.models import Track
    from vms_face.infra.minio_store import get_object_store
    from vms_face.infra.postgres import session_scope
    from vms_face.infra.qdrant import get_qdrant_tracks

    async with session_scope() as s:
        keys = [k for (k,) in (await s.execute(select(Track.best_crop_key).where(
            Track.tenant_id == tenant_id, Track.camera_id == camera_id))).all() if k]
        await s.execute(delete(Track).where(Track.tenant_id == tenant_id, Track.camera_id == camera_id))
    store = get_qdrant_tracks()
    await store.client.delete(store.collection, points_selector=Filter(must=[
        FieldCondition(key="tenant_id", match=MatchValue(value=str(tenant_id))),
        FieldCondition(key="camera_id", match=MatchValue(value=str(camera_id))),
    ]))

    def _rm() -> None:
        client = get_object_store()._client  # noqa: SLF001 — same as retention
        for k in keys:
            with contextlib.suppress(Exception):
                client.remove_object(settings.minio_bucket_investigate, k)

    await asyncio.get_running_loop().run_in_executor(None, _rm)
    return len(keys)


async def delete_import(tenant_id: uuid.UUID, import_id: str) -> int:
    """Remove the import's tracks (rows, points, vectors, crops) and its camera."""
    from qdrant_client.http.models import FieldCondition, Filter, MatchValue
    from sqlalchemy import delete, select

    from vms_face.config import settings
    from vms_face.domain.models import Camera, Track
    from vms_face.infra.minio_store import get_object_store
    from vms_face.infra.postgres import session_scope
    from vms_face.infra.qdrant import get_qdrant_tracks

    job = _jobs.get(import_id)
    if job:
        job.cancel.set()
    code = camera_code(import_id)
    async with session_scope() as s:
        cam = (await s.execute(select(Camera).where(Camera.tenant_id == tenant_id, Camera.code == code))).scalar_one_or_none()
        if cam is None:
            return 0
        keys = [k for (k,) in (await s.execute(select(Track.best_crop_key).where(Track.camera_id == cam.id))).all() if k]
        await s.execute(delete(Track).where(Track.camera_id == cam.id))
        await s.delete(cam)
    store = get_qdrant_tracks()
    await store.client.delete(store.collection, points_selector=Filter(must=[
        FieldCondition(key="tenant_id", match=MatchValue(value=str(tenant_id))),
        FieldCondition(key="camera_id", match=MatchValue(value=str(cam.id))),
    ]))

    def _rm() -> None:
        client = get_object_store()._client  # noqa: SLF001 — same as retention
        for k in keys:
            with contextlib.suppress(Exception):
                client.remove_object(settings.minio_bucket_investigate, k)

    await asyncio.get_running_loop().run_in_executor(None, _rm)
    _jobs.pop(import_id, None)
    return len(keys)
