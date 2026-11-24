"""I-1 search index: turn every person pass into one searchable record.

Two halves, so the live pipeline never waits on the index:

``CameraIndexer`` (hot path, one per camera, pure Python + array slicing)
    Follows YOLO person boxes with the ``BoxTracker``. Per live track it keeps
    the best crop so far (big, confident, not cut off by the frame edge), up
    to ``SAMPLES`` smaller crops spread over time for colour voting, one box
    position per second, and which face tracks / known people it overlapped.
    When a track ends, or every ``heartbeat_s`` for a long one, it hands a
    ``TrackSummary`` to a sink. Junk (shorter than ``min_seconds`` or fewer
    than ``min_hits`` matched frames) is dropped.

``IndexWriter`` (one per process, asyncio task)
    Takes summaries from a bounded queue (full → the summary is dropped and
    counted, never blocks the camera), batches them every ~0.5 s, and per
    batch: one SigLIP call for all crops, colour votes + IR check on CPU,
    then writes the crop to MinIO, the row + points + activity count to
    Postgres and the vector + payload to Qdrant ``vms_tracks``.

Off unless ``investigate_index_enabled`` (and person detection, which
provides the boxes). Tracks are written with ``source='live'``.
"""
from __future__ import annotations

import asyncio
import collections
import datetime as dt
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

import numpy as np

from vms_face.core.logging import get_logger
from vms_face.investigate.box_tracker import BoxTrack, BoxTracker
from vms_face.investigate import index_schema as ix

log = get_logger(__name__)

SAMPLES = 4                 # crops kept per track for colour voting
SAMPLE_SPACING_S = 1.0      # at most one sample per this many seconds
SAMPLE_MAX_H = 160          # px; colour needs little resolution
CROP_PAD = 0.08             # pad the box by this fraction before cropping
EDGE_MARGIN = 0.01          # a box this close to the frame edge is cut off
IR_SATURATION_MAX = 18.0    # mean HSV saturation below this = IR / greyscale

Face = tuple[Sequence[float], str, "str | None"]   # (bbox, face track id, known person_id or None)


def _utc(ts: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc)


def crop_box(frame: np.ndarray, bbox: Sequence[float], *, pad: float = CROP_PAD, max_h: int | None = None) -> np.ndarray:
    """Padded crop of ``bbox`` from ``frame`` as an owned array, optionally downscaled."""
    import cv2

    h, w = frame.shape[:2]
    x1, y1, x2, y2 = (float(v) for v in bbox[:4])
    px, py = (x2 - x1) * pad, (y2 - y1) * pad
    xa, ya = max(0, int(x1 - px)), max(0, int(y1 - py))
    xb, yb = min(w, int(x2 + px)), min(h, int(y2 + py))
    if xb <= xa or yb <= ya:
        return np.zeros((0, 0, 3), dtype=np.uint8)
    crop = frame[ya:yb, xa:xb]
    if max_h and crop.shape[0] > max_h:
        s = max_h / crop.shape[0]
        return cv2.resize(crop, (max(1, int(crop.shape[1] * s)), max_h), interpolation=cv2.INTER_AREA)
    return crop.copy()


def crop_quality(bbox: Sequence[float], score: float, frame_w: int, frame_h: int) -> float:
    """Bigger, more confident, and not cut off by the frame edge is better."""
    x1, y1, x2, y2 = (float(v) for v in bbox[:4])
    area = max(0.0, x2 - x1) * max(0.0, y2 - y1) / float(frame_w * frame_h)
    mx, my = EDGE_MARGIN * frame_w, EDGE_MARGIN * frame_h
    cut = x1 <= mx or y1 <= my or x2 >= frame_w - mx or y2 >= frame_h - my
    return area * max(0.05, float(score)) * (0.4 if cut else 1.0)


def _contains(person: Sequence[float], face: Sequence[float]) -> bool:
    cx, cy = (face[0] + face[2]) / 2.0, (face[1] + face[3]) / 2.0
    return person[0] <= cx <= person[2] and person[1] <= cy <= person[1] + (person[3] - person[1]) * 0.5


@dataclass(slots=True)
class TrackSummary:
    """Everything the writer needs for one track. Same ``track_uid`` across
    heartbeats and the final write, so later writes update the same row."""

    track_uid: uuid.UUID
    tenant_id: uuid.UUID
    camera_id: uuid.UUID
    tracker_id: str
    first_seen: dt.datetime
    last_seen: dt.datetime
    hits: int
    frame_w: int
    frame_h: int
    best_crop: np.ndarray
    best_ts: dt.datetime
    best_quality: float
    samples: list[np.ndarray]
    points: list[tuple[dt.datetime, list[int]]]   # only the points not written before
    person_id: str | None
    face_track_ids: list[str]
    final: bool
    first_write: bool
    object_class: str = "person"
    source: str = "live"
    vehicle_type: tuple[str, float] | None = None    # (type, share of looks) for vehicles


@dataclass(slots=True)
class _Live:
    uid: uuid.UUID
    best: tuple[float, np.ndarray, float] | None = None    # (quality, crop, ts)
    samples: list[tuple[float, np.ndarray]] = field(default_factory=list)   # (ts, crop)
    points: list[tuple[float, list[int]]] = field(default_factory=list)
    unsent_from: int = 0
    last_point_ts: float = -1e18
    people: collections.Counter = field(default_factory=collections.Counter)
    faces: set = field(default_factory=set)
    last_emit: float | None = None
    emitted: bool = False
    classes: collections.Counter = field(default_factory=collections.Counter)


class CameraIndexer:
    def __init__(
        self,
        camera_id: uuid.UUID,
        tenant_id: uuid.UUID,
        sink: Callable[[TrackSummary], None],
        *,
        clock: Callable[[], float] = time.time,
        max_gap_s: float = 1.0,
        min_seconds: float = 1.0,
        min_hits: int = 3,
        heartbeat_s: float = 30.0,
        point_interval_s: float = 1.0,
        crop_max_h: int = 256,
        object_class: str = "person",
    ) -> None:
        self.object_class = object_class        # "person" or "vehicle" (I-10)
        self.camera_id = camera_id
        self.tenant_id = tenant_id
        self._sink = sink
        self._clock = clock
        self._tracker = BoxTracker(max_gap_s=max_gap_s, id_prefix="p", clock=clock)
        self._live: dict[str, _Live] = {}
        self.min_seconds = min_seconds
        self.min_hits = min_hits
        self.heartbeat_s = heartbeat_s
        self.point_interval_s = point_interval_s
        self.crop_max_h = crop_max_h
        self._frame_wh = (1, 1)
        self.emitted = 0
        self.junk = 0

    def step(
        self,
        frame_bgr: np.ndarray,
        person_boxes: Iterable[Sequence[float]],
        faces: Iterable[Face] = (),
    ) -> None:
        """Feed one frame's YOLO boxes ``(x1, y1, x2, y2, score)``. Call only on
        frames where YOLO ran: the tracker ends tracks by time, not by frame."""
        now = self._clock()
        h, w = frame_bgr.shape[:2]
        self._frame_wh = (w, h)
        # (x1, y1, x2, y2, score[, type]): vehicles carry their YOLO type, voted per pass.
        raw = list(person_boxes)
        boxes = [tuple(float(v) for v in b[:5]) for b in raw]
        score_of = {b[:4]: (b[4] if len(b) > 4 else 0.5) for b in boxes}
        type_of = {tuple(float(v) for v in b[:4]): b[5] for b in raw if len(b) > 5}
        live = self._tracker.step(boxes)
        faces = list(faces)
        for tr in live:
            st = self._live.get(tr.track_id)
            if st is None:
                st = self._live[tr.track_id] = _Live(uid=uuid.uuid4())
            bbox = tr.bbox
            q = crop_quality(bbox, score_of.get(tuple(bbox), 0.5), w, h)
            if st.best is None or q > st.best[0]:
                st.best = (q, crop_box(frame_bgr, bbox, max_h=self.crop_max_h), now)
            if (not st.samples or now - st.samples[-1][0] >= SAMPLE_SPACING_S) and len(st.samples) < SAMPLES:
                st.samples.append((now, crop_box(frame_bgr, bbox, pad=0.0, max_h=SAMPLE_MAX_H)))
            kind = type_of.get(tuple(bbox))
            if kind:
                st.classes[kind] += 1
            if now - st.last_point_ts >= self.point_interval_s:
                st.points.append((now, ix.bbox_to_grid(bbox, w, h)))
                st.last_point_ts = now
            for fb, face_tid, person_id in faces:
                if _contains(bbox, fb):
                    st.faces.add(face_tid)
                    if person_id:
                        st.people[person_id] += 1
            if now - tr.first_seen >= self.heartbeat_s and (st.last_emit is None or now - st.last_emit >= self.heartbeat_s):
                self._emit(tr, st, final=False)
        for tr in self._tracker.closed:
            self._close(tr)

    def flush(self) -> None:
        """Camera stopping: write out every live track."""
        for tr in self._tracker.flush():
            self._close(tr)

    def _close(self, tr: BoxTrack) -> None:
        st = self._live.pop(tr.track_id, None)
        if st is None:
            return
        if not st.emitted and (tr.duration < self.min_seconds or tr.hits < self.min_hits):
            self.junk += 1
            return
        self._emit(tr, st, final=True)

    def _emit(self, tr: BoxTrack, st: _Live, *, final: bool) -> None:
        if st.best is None or st.best[1].size == 0:
            return
        w, h = self._frame_wh
        summary = TrackSummary(
            track_uid=st.uid, tenant_id=self.tenant_id, camera_id=self.camera_id, tracker_id=tr.track_id,
            first_seen=_utc(tr.first_seen), last_seen=_utc(tr.last_seen), hits=tr.hits, frame_w=w, frame_h=h,
            best_crop=st.best[1], best_ts=_utc(st.best[2]), best_quality=float(st.best[0]),
            samples=[c for _, c in st.samples if c.size],
            points=[(_utc(t), b) for t, b in st.points[st.unsent_from:]],
            person_id=st.people.most_common(1)[0][0] if st.people else None,
            face_track_ids=sorted(st.faces), final=final, first_write=not st.emitted,
            object_class=self.object_class,
            vehicle_type=((st.classes.most_common(1)[0][0], st.classes.most_common(1)[0][1] / sum(st.classes.values()))
                          if st.classes else None),
        )
        st.unsent_from = len(st.points)
        st.last_emit = self._clock()
        st.emitted = True
        self.emitted += 1
        self._sink(summary)


# ── attribute voting (writer side, CPU) ─────────────────────────────────────

def is_ir(crop: np.ndarray) -> bool:
    import cv2

    if crop.size == 0:
        return False
    return float(cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[..., 1].mean()) < IR_SATURATION_MAX


def vote(values: Iterable[str | None], *, min_votes: int = 2) -> dict | None:
    """Majority value with a confidence: its share of the votes, damped when
    there are few. ``None`` unless at least ``min_votes`` agree."""
    vals = [v for v in values if v]
    if not vals:
        return None
    value, n = collections.Counter(vals).most_common(1)[0]
    if n < min(min_votes, len(vals)):
        return None
    conf = (n / len(vals)) * min(1.0, len(vals) / 3.0)
    return {"value": value, "conf": round(conf, 3)}


COLOURS = ("black", "white", "grey", "red", "orange", "yellow", "green", "blue", "navy", "purple", "pink", "brown", "beige")
TOP_PROMPT = "a photo of a person wearing a {c} top"
VEHICLE_PROMPT = "a photo of a {c} vehicle"
BOTTOM_PROMPT = "a photo of {c} trousers or a {c} skirt"


def track_is_ir(samples: Sequence[np.ndarray], best: np.ndarray) -> bool:
    crops = [c for c in samples if c.size] or [best]
    votes = [is_ir(c) for c in crops]
    return sum(votes) * 2 > len(votes)


def lower_half(crop: np.ndarray) -> np.ndarray:
    """Legs region of a person crop (drops the feet and floor at the very bottom)."""
    h = crop.shape[0]
    return crop[int(h * 0.5):max(int(h * 0.92), int(h * 0.5) + 1)]


def colour_attributes(embedder, full_vecs: np.ndarray, lower_vecs: np.ndarray, ir_flags: Sequence[bool],
                      classes: Sequence[str] | None = None, vehicle_types: Sequence | None = None) -> list[dict]:
    """People: top colour from the whole person, bottom colour from the lower
    half. Vehicles: the vehicle's colour, and its type as voted over the pass.
    SigLIP zero-shot (one prompt per colour); measured on real crops it beats
    the HSV heuristic, which picked up floors and walls. IR: no colours."""
    classes = list(classes or ["person"] * len(ir_flags))
    vehicle_types = list(vehicle_types or [None] * len(ir_flags))
    tops = embedder.classify(full_vecs, COLOURS, TOP_PROMPT) if len(full_vecs) else []
    bottoms = embedder.classify(lower_vecs, COLOURS, BOTTOM_PROMPT) if len(lower_vecs) else []
    vcols = embedder.classify(full_vecs, COLOURS, VEHICLE_PROMPT) if "vehicle" in classes and len(full_vecs) else []
    out = []
    for i, ir in enumerate(ir_flags):
        attrs: dict = {}
        if classes[i] == "vehicle":
            vt = vehicle_types[i]
            if vt:
                attrs["vehicle_type"] = {"value": vt[0], "conf": round(float(vt[1]), 3)}
            if not ir:
                attrs["vehicle_colour"] = {"value": vcols[i][0], "conf": round(vcols[i][1], 3)}
        elif not ir:
            attrs["top_colour"] = {"value": tops[i][0], "conf": round(tops[i][1], 3)}
            attrs["bottom_colour"] = {"value": bottoms[i][0], "conf": round(bottoms[i][1], 3)}
        out.append(attrs)
    return out


# ── writer ──────────────────────────────────────────────────────────────────

class IndexWriter:
    def __init__(self, *, queue_max: int = 512, batch_max: int = 16, batch_wait_s: float = 0.5) -> None:
        self._queue: asyncio.Queue[TrackSummary] | None = None
        self._queue_max = queue_max
        self._batch_max = batch_max
        self._batch_wait_s = batch_wait_s
        self._task: asyncio.Task | None = None
        self.written = 0
        self.dropped = 0
        self.failed = 0

    def submit(self, summary: TrackSummary) -> None:
        """Never blocks: a full queue drops the summary (counted)."""
        if self._queue is None:
            self._queue = asyncio.Queue(maxsize=self._queue_max)
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._run(), name="investigate-index-writer")
        try:
            self._queue.put_nowait(summary)
        except asyncio.QueueFull:
            self.dropped += 1
            _metric("dropped")

    def snapshot(self) -> dict:
        return {"written": self.written, "dropped": self.dropped, "failed": self.failed,
                "queued": self._queue.qsize() if self._queue else 0}

    async def _run(self) -> None:
        assert self._queue is not None
        while True:
            batch = [await self._queue.get()]
            deadline = time.monotonic() + self._batch_wait_s
            while len(batch) < self._batch_max:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                try:
                    batch.append(await asyncio.wait_for(self._queue.get(), left))
                except asyncio.TimeoutError:
                    break
            try:
                await self.write_batch(batch)
                self.written += len(batch)
                _metric("written", len(batch))
            except Exception as e:   # one bad batch must not stop the index
                self.failed += len(batch)
                _metric("failed", len(batch))
                log.warning("investigate index write failed", n=len(batch), err=str(e))

    async def write_batch(self, batch: list[TrackSummary]) -> None:
        import cv2
        from qdrant_client.http.models import PointStruct
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        from vms_face.config import settings
        from vms_face.core.executors import get_gpu_pool
        from vms_face.domain.models import ActivityBucket, Track, TrackPoint
        from vms_face.infra.minio_store import get_object_store
        from vms_face.infra.postgres import session_scope
        from vms_face.infra.qdrant import get_qdrant_tracks
        from vms_face.investigate.embedder import SiglipEmbedder

        loop = asyncio.get_running_loop()
        embedder = await loop.run_in_executor(None, SiglipEmbedder.shared)
        n = len(batch)
        # One GPU call: the best crops (the searchable fingerprint) and their
        # lower halves (bottom colour).
        both = await loop.run_in_executor(
            get_gpu_pool(), embedder.embed_images, [s.best_crop for s in batch] + [lower_half(s.best_crop) for s in batch])
        vectors, lower = both[:n], both[n:]
        irs = await loop.run_in_executor(None, lambda: [track_is_ir(s.samples, s.best_crop) for s in batch])
        colours = await loop.run_in_executor(get_gpu_pool(), colour_attributes, embedder, vectors, lower, irs,
                                             [s.object_class for s in batch], [s.vehicle_type for s in batch])
        derived = list(zip(colours, irs))
        jpegs = await loop.run_in_executor(
            None, lambda: [cv2.imencode(".jpg", s.best_crop, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes() for s in batch])

        objects = get_object_store()
        bucket = settings.minio_bucket_investigate
        model_info = {"embedder": embedder.model_tag, "detector": "yolov8n-coco", "attributes": f"{embedder.model_tag} zero-shot colours v1",
                      "tracker": "investigate.box_tracker@v1"}
        points: list[PointStruct] = []
        async with session_scope() as session:
            for s, vec, (attrs, ir), jpg in zip(batch, vectors, derived, jpegs):
                key = ix.crop_key(s.tenant_id, s.track_uid, s.first_seen)
                await loop.run_in_executor(None, objects.put_bytes, bucket, key, jpg, "image/jpeg")
                attrs = ix.clean_attributes(attrs, ir=ir, allow_sensitive=False)
                person = _uuid_or_none(s.person_id)
                row = dict(
                    id=s.track_uid, tenant_id=s.tenant_id, camera_id=s.camera_id, source=s.source,
                    tracker_id=s.tracker_id, object_class=s.object_class, first_seen=s.first_seen,
                    last_seen=s.last_seen, hits=s.hits, best_crop_key=key, best_crop_ts=s.best_ts,
                    attributes=attrs, person_id=person, quality=s.best_quality, ir=ir, model_info=model_info,
                )
                stmt = pg_insert(Track).values(**row)
                stmt = stmt.on_conflict_do_update(index_elements=["id"], set_={
                    k: stmt.excluded[k] for k in ("last_seen", "hits", "best_crop_key", "best_crop_ts", "attributes",
                                                  "person_id", "quality", "ir", "model_info")
                } | {"updated_at": dt.datetime.now(dt.timezone.utc)})
                await session.execute(stmt)
                if s.points:
                    await session.execute(pg_insert(TrackPoint).values(
                        [{"track_id": s.track_uid, "ts": t, "bbox": b} for t, b in s.points]
                    ).on_conflict_do_nothing())
                if s.first_write:
                    b = pg_insert(ActivityBucket).values(tenant_id=s.tenant_id, camera_id=s.camera_id,
                                                         minute=ix.minute_floor(s.first_seen),
                                                         object_class=s.object_class, count=1)
                    await session.execute(b.on_conflict_do_update(
                        index_elements=["camera_id", "minute", "object_class"],
                        set_={"count": ActivityBucket.count + 1}))
                payload = ix.track_payload(
                    tenant_id=s.tenant_id, camera_id=s.camera_id, object_class=s.object_class,
                    first_seen=s.first_seen, last_seen=s.last_seen, source=s.source, attributes=attrs, ir=ir,
                ) | {"crop_key": key, "quality": round(s.best_quality, 5)}
                if person:
                    payload["person_id"] = str(person)
                points.append(PointStruct(id=str(s.track_uid), vector=vec.tolist(), payload=payload))
            await session.commit()
        await get_qdrant_tracks().upsert_batch(points)


def _uuid_or_none(v: str | None) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v)) if v else None
    except ValueError:
        return None


def _metric(outcome: str, n: int = 1) -> None:
    try:
        from vms_face.core.metrics import INVESTIGATE_INDEX_TRACKS
    except Exception:
        return
    INVESTIGATE_INDEX_TRACKS.labels(outcome=outcome).inc(n)


_writer: IndexWriter | None = None


def get_index_writer() -> IndexWriter:
    global _writer
    if _writer is None:
        from vms_face.config import settings

        _writer = IndexWriter(queue_max=settings.investigate_queue_max)
    return _writer
