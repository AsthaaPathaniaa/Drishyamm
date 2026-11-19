"""Per-camera customer-footfall counter.

This service does two things:

  1. **Frame-by-frame**: when the orchestrator has fresh person (or face)
     boxes for a camera, it calls `registry.update(camera, w, h, boxes)`.
     Each box may carry the caller's own track id, which is what the face
     pipeline passes (its SORT tracker already knows who is who); boxes
     without one are matched to a track by distance. Either way the counter
     detects when each tracked person's anchor point
     crosses the operator's counting line -- a segment a->b at any angle --
     and increments either IN or OUT (which side is IN is up to the
     operator). Optional fall heuristic: bbox width > 1.2 * height triggers
     a fall once per track.

  2. **Periodic flush**: every few seconds a background task UPSERTs the
     in-memory deltas into `footfall_minute_buckets` for the current
     wall-clock minute. Crash-safety = at most ~5 s of counts lost. We
     deliberately don't write per crossing — that'd be hundreds of writes
     per minute on a busy mall camera.

Design choices worth remembering:

- The tracker is process-local. If you scale to multiple orchestrator
  processes per camera (you shouldn't), neither centroids nor caller track
  ids will match across them.
- Prefer passing a track id. Centroid matching has to guess from a single
  point, and the guess gets harder the slower the counter is fed -- which
  attention scheduling made much slower than when this was written.
- The line is a SEGMENT, not a full-width height: a crossing counts only
  when the step that changed sides passes between a and b (plus half a box
  of slack at each end), so a short line across one doorway ignores people
  walking past its ends, and two doors on one camera don't count each other.
- Side test is the cross product of a->b with the anchor point. A dead band
  of a few percent of the box height either side of the line absorbs
  detector jitter: a point inside the band leaves the committed side alone.
- Each track counts every real crossing (in, then out again, counts both),
  with a short per-track cooldown so a person dithering on the line doesn't
  yo-yo the counter. A flip inside the cooldown is not committed, so if the
  person really stays on the new side it counts once the cooldown ends.
- Direction policy: `right_is_in` / `left_is_in`, relative to a->b as seen
  on screen (y grows down). The pre-angle values `down_is_in` / `up_is_in`
  and `line_y_frac` are still read, and map onto a full-width line, so a
  gate saved before the change counts exactly as it did.
- All of it lives in the camera's config_json, so no DB migration.

For wiring details see api/routes/footfall.py (REST surface),
pipeline/orchestrator.py (where update() is called from), and the
0005_footfall.py migration (table schema).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import math
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable

from sqlalchemy.dialects.postgresql import insert as pg_insert

from vms_face.core.logging import get_logger
from vms_face.domain.models import FootfallMinuteBucket
from vms_face.infra.postgres import session_scope

log = get_logger(__name__)


# ── Config ────────────────────────────────────────────────────────────────

# ── Matching an observation to a track ───────────────────────────────────
#
# Preferred: the id the caller already has. The face pipeline tracks with
# SORT (Kalman + Hungarian, services/face_tracker.py) and hands us its
# track_id, which survives a detector miss and an occlusion. Nothing we
# could compute from one centroid competes with that.
#
# Fallback, for a caller with no id (the YOLO body path): nearest centroid
# within a radius. It used to be a flat 60 px "for 1080p at 8 fps", which
# quietly stopped working once attention scheduling landed: at target_fps 4
# with attention_latched_every_n 4 the counter is fed about ONCE A SECOND,
# and a walking person covers far more than 60 px in that second. Every
# update therefore started a fresh track, no track ever reached
# _MIN_TRACK_FRAMES, and the gate counted nobody while looking healthy.
#
# So the radius is now how far the person could plausibly have got:
#   * box height -- perspective. A near (big) box means the same real step
#     is more pixels. Calibrated on FACE boxes, which are 40-80 px tall.
#   * seconds since that track was last seen -- the gap we are bridging,
#     which is what actually changed under us.
# Floored at the old 60 px (a still person, a tiny box) and capped, because
# past a point "could have walked there" stops being evidence of identity.
_RADIUS_MIN_PX = 60.0
_RADIUS_BOX_H_MULT = 2.0
_RADIUS_TRAVEL_PX_PER_SEC = 300.0
_RADIUS_MAX_PX = 250.0

# How long an unmatched track stays alive before we forget it. Bumps
# resilience to one-frame detector misses (person walks behind another).
_TRACK_TTL_SEC = 2.0

# How often the registry flushes in-memory deltas to Postgres.
_FLUSH_INTERVAL_SEC = 5.0

# Dead band either side of the line: a point closer than this (pixels) has
# not cleared the line yet. Scales with the box so a near, tall person and a
# far, small one get the same tolerance relative to their own jitter.
_BAND_BOX_FRAC = 0.08
_BAND_MIN_PX = 3.0

# A track must have been seen this many frames before a crossing counts --
# the same guard as activity-monitor's LineCrosser (min_frames=3). Kills the
# one-frame ghost a detector spawns on the line.
_MIN_TRACK_FRAMES = 3

# After a track counts, a flip back within this window is not committed yet.
_RECOUNT_COOLDOWN_SEC = 1.0

# Slack past each end of the segment, as a fraction of its length, capped:
# half the box width, so a person whose anchor passes just beyond the end
# but whose body walks through the door still counts.
_END_TOLERANCE_MAX = 0.25


# ── Line geometry (pure; pixel space) ─────────────────────────────────────

# A line shorter than this (normalised) cannot be told apart from a point.
_MIN_LINE_LEN = 0.03

# Where a gate with no line saved yet starts: across the frame a bit below
# centre (typical entrance cam), inset so both handles are on the picture.
_DEFAULT_LINE = (0.1, 0.6, 0.9, 0.6)

_DIRECTIONS = ("right_is_in", "left_is_in")
_LEGACY_DIRECTIONS = ("down_is_in", "up_is_in")


def signed_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """Distance of (px, py) from the line through a->b, signed: positive is
    the RIGHT of a->b as seen on screen (image y grows downward), so for a
    left-to-right line, positive is below it. Same cross product as
    activity-monitor's crossing._side, divided by |a->b| to get pixels."""
    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy)
    if length <= 0.0:
        return 0.0
    return (dx * (py - ay) - dy * (px - ax)) / length


def crosses_segment(
    p: tuple[float, float], q: tuple[float, float],
    dp: float, dq: float,
    ax: float, ay: float, bx: float, by: float,
    tolerance: float = 0.0,
) -> bool:
    """Does the step p->q (whose signed distances dp, dq have opposite signs)
    cross the line WITHIN the segment a-b? `tolerance` widens the segment by
    that fraction of its length at each end."""
    if dp == dq:
        return False
    alpha = dp / (dp - dq)
    xx = p[0] + alpha * (q[0] - p[0])
    yy = p[1] + alpha * (q[1] - p[1])
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    if len2 <= 0.0:
        return False
    t = ((xx - ax) * dx + (yy - ay) * dy) / len2
    return -tolerance <= t <= 1.0 + tolerance


def parse_line(raw: Any) -> tuple[float, float, float, float] | None:
    """{"a":[x,y],"b":[x,y]} (or activity-monitor's {x1,y1,x2,y2}),
    normalised 0..1 -> (ax, ay, bx, by), clamped to the frame. None when it
    is missing, malformed or too short to be a line."""
    if not isinstance(raw, dict):
        return None
    try:
        if "a" in raw and "b" in raw:
            (ax, ay), (bx, by) = raw["a"], raw["b"]
        else:
            ax, ay, bx, by = raw["x1"], raw["y1"], raw["x2"], raw["y2"]
        pts = [float(v) for v in (ax, ay, bx, by)]
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in pts):
        return None
    ax, ay, bx, by = (round(max(0.0, min(1.0, v)), 4) for v in pts)
    if math.hypot(bx - ax, by - ay) < _MIN_LINE_LEN:
        return None
    return ax, ay, bx, by


# ── Per-camera config (mirrored from cameras.config_json) ─────────────────


@dataclass(slots=True)
class FootfallConfig:
    """What the operator picked for this camera. Mirrored from the camera's
    `config_json["footfall"]` block at orchestrator startup (and refreshed
    whenever the API saves new settings). Sensible defaults below cover the
    'enable it and forget it' case."""

    enabled: bool = False
    # The counting line, a->b, normalised to the frame (0,0 top-left,
    # 1,1 bottom-right). Any angle.
    ax: float = 0.1
    ay: float = 0.6
    bx: float = 0.9
    by: float = 0.6
    # "right_is_in" = crossing toward the right of a->b (on screen) counts
    # as IN; "left_is_in" inverts that. Operator-driven; see config UI.
    direction: str = "right_is_in"
    # Optional fall detection. Off by default — the heuristic
    # (bbox.w > 1.2 * bbox.h) has a non-trivial false-positive rate on
    # crouching, bending or carrying-large-items, and most deployments
    # don't want those alerts.
    falls_enabled: bool = False

    @property
    def line(self) -> dict[str, list[float]]:
        return {"a": [self.ax, self.ay], "b": [self.bx, self.by]}

    @property
    def line_y_frac(self) -> float:
        """Height of the line's midpoint: the pre-angle field, still served
        so an older client reads something sensible. Exact for a level line."""
        return round((self.ay + self.by) / 2.0, 3)

    @property
    def in_sign(self) -> int:
        """Sign of signed_distance() on the IN side."""
        return 1 if self.direction == "right_is_in" else -1

    @classmethod
    def from_camera_config(cls, config_json: dict | None) -> "FootfallConfig":
        """Read the footfall sub-block from cameras.config_json. Missing
        block → all-defaults (disabled). Bad types are coerced silently —
        we'd rather start a camera with a working config than fail the
        whole orchestrator on a stray string.

        Pre-angle blocks ({line_y_frac, down_is_in|up_is_in}) are read as a
        full-width level line, so they count exactly as before.

        Defaults are written literally rather than read via `cls.<field>`
        because @dataclass(slots=True) replaces the class-level attribute
        with a slot descriptor — `cls.ay` evaluates to a `member_descriptor`,
        not 0.6, and arithmetic on it blows up with TypeError at runtime."""
        block = (config_json or {}).get("footfall") or {}

        line = parse_line(block.get("line"))
        if line is None and block.get("line_y_frac") is not None:
            try:
                y = float(block["line_y_frac"])
            except (TypeError, ValueError):
                y = 0.6
            y = round(max(0.05, min(0.95, y)), 4)
            line = (0.0, y, 1.0, y)
        if line is None:
            line = _DEFAULT_LINE
        ax, ay, bx, by = line

        direction = str(block.get("direction", "")).strip().lower()
        if direction in _LEGACY_DIRECTIONS:
            # "Down" is the right of a->b when a->b runs left to right.
            down_is_right = (bx - ax) >= 0
            wants_down = direction == "down_is_in"
            direction = "right_is_in" if wants_down == down_is_right else "left_is_in"
        elif direction not in _DIRECTIONS:
            direction = "right_is_in"

        return cls(
            enabled=bool(block.get("enabled", False)),
            ax=ax, ay=ay, bx=bx, by=by,
            direction=direction,
            falls_enabled=bool(block.get("falls_enabled", False)),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "line": self.line,
            "direction": self.direction,
            "falls_enabled": self.falls_enabled,
            # Read-only echo for pre-angle clients; `line` wins on read.
            "line_y_frac": self.line_y_frac,
        }


# ── Per-camera tracker state ──────────────────────────────────────────────


@dataclass(slots=True)
class _Track:
    x: float                  # anchor point last seen (pixels)
    y: float
    last_seen: float
    side: int                 # committed side: -1 left of a->b, 1 right,
                              # 0 = has not cleared the dead band yet
    rx: float = 0.0           # last point seen clear on the committed side;
    ry: float = 0.0           # a crossing is the step from here
    frames: int = 1
    last_count_t: float = float("-inf")
    fall_counted: bool = False


@dataclass(slots=True)
class _CameraState:
    # camera_id is the dict key, but we also carry the tenant for flush.
    tenant_id: uuid.UUID
    config: FootfallConfig
    # Numbering for tracks WE opened (an observation with no caller id).
    next_id: int = 1
    # Keyed either by one of those ints, or by _ext_key(caller's track id).
    tracks: dict[Any, _Track] = field(default_factory=dict)
    # Pending deltas: counts accumulated since the last flush, keyed by the
    # minute they happened in. We accumulate per-minute so a late flush
    # doesn't merge crossings from 10:59:58 into the 11:00 bucket.
    pending: dict[dt.datetime, dict[str, int]] = field(default_factory=dict)
    # Lightweight stats for the live API. These are cumulative since the
    # service started; persisted totals come from Postgres.
    live_in: int = 0
    live_out: int = 0
    live_falls: int = 0
    last_update_ts: float = 0.0


def _ext_key(track_id: Any) -> tuple[str, Any]:
    """Key for a track the CALLER identified. Tupled so a caller's id can
    never collide with one of our own internally-numbered tracks."""
    return ("ext", track_id)


def _match_radius(box_h: float, since_last: float) -> float:
    """How far from its last position an unidentified observation may be and
    still be the same person. See the constants above for the reasoning."""
    gap = min(max(since_last, 0.0), _TRACK_TTL_SEC)
    r = _RADIUS_BOX_H_MULT * box_h + _RADIUS_TRAVEL_PX_PER_SEC * gap
    return min(_RADIUS_MAX_PX, max(_RADIUS_MIN_PX, r))


def _side_of(distance: float, box_h: float) -> int:
    """-1 / 1 for a point clear of the line's dead band, 0 inside it."""
    band = max(_BAND_MIN_PX, _BAND_BOX_FRAC * box_h)
    if distance > band:
        return 1
    if distance < -band:
        return -1
    return 0


def _minute_bucket(now: dt.datetime) -> dt.datetime:
    """Truncate to the minute, keep timezone."""
    return now.replace(second=0, microsecond=0)


# ── The registry (singleton-ish; lives for the lifetime of the API process) ─


class FootfallRegistry:
    """Holds per-camera tracker state and runs the periodic Postgres flush.
    One instance per process — the `get_registry()` helper below returns it.
    Thread-safe via an asyncio Lock; the orchestrator calls update() from
    its own asyncio task, the flush coroutine reads/clears pending under
    the same lock."""

    def __init__(self) -> None:
        self._cameras: dict[uuid.UUID, _CameraState] = {}
        self._lock = asyncio.Lock()
        self._flusher: asyncio.Task | None = None
        self._stop = asyncio.Event()

    # ── Lifecycle ────────────────────────────────────────────────────────

    def start(self) -> None:
        """Idempotently start the periodic flusher. Called from app lifespan."""
        if self._flusher is None or self._flusher.done():
            self._stop.clear()
            self._flusher = asyncio.create_task(self._flush_loop(), name="footfall-flusher")

    async def aclose(self) -> None:
        self._stop.set()
        if self._flusher is not None:
            self._flusher.cancel()
            try:
                await self._flusher
            except (asyncio.CancelledError, Exception):
                pass
            self._flusher = None
        # One last best-effort flush so we don't lose counts at shutdown.
        await self._flush_once()

    # ── Per-camera config / lifecycle ────────────────────────────────────

    async def configure_camera(
        self,
        camera_id: uuid.UUID,
        tenant_id: uuid.UUID,
        config: FootfallConfig,
    ) -> None:
        """Called when an orchestrator starts (or when the operator saves
        new footfall settings via the API). Creating fresh state per camera
        means stale tracks from a previous config don't carry over.

        The COUNTS, though, are not stale -- they already happened. Replacing
        the state used to throw away whatever had not reached Postgres yet, so
        an operator nudging a gate's line at a busy doorway silently lost up to
        _FLUSH_INTERVAL_SEC of real crossings, and the busier the gate the more
        there was to lose. The pending buckets are carried out of the old state
        and written before it is forgotten.

        A flush failure is logged, not raised: by the time this runs the new
        config is already committed, and failing here would report "not saved"
        about a gate that was saved.
        """
        async with self._lock:
            previous = self._cameras.get(camera_id)
            # Detach the deltas under the lock, write them outside it -- the
            # same shape remove_camera uses, so no caller is held up behind a
            # Postgres round-trip.
            pending = previous.pending if previous is not None else None
            previous_tenant = previous.tenant_id if previous is not None else tenant_id
            if previous is not None:
                previous.pending = {}
            self._cameras[camera_id] = _CameraState(tenant_id=tenant_id, config=config)

        if pending:
            try:
                await self._write_buckets(camera_id, previous_tenant, pending)
            except Exception as e:
                log.warning(
                    "footfall: could not flush counts before reconfiguring",
                    camera_id=str(camera_id),
                    buckets=len(pending),
                    err=str(e),
                )

    async def remove_camera(self, camera_id: uuid.UUID) -> None:
        async with self._lock:
            state = self._cameras.pop(camera_id, None)
        # Drain any leftover deltas before we forget them.
        if state is not None and state.pending:
            await self._flush_one(camera_id, state, force=True)

    def get_config(self, camera_id: uuid.UUID) -> FootfallConfig | None:
        state = self._cameras.get(camera_id)
        return state.config if state else None

    # ── Per-frame update ─────────────────────────────────────────────────

    def update(
        self,
        camera_id: uuid.UUID,
        frame_w: int,
        frame_h: int,
        persons: Iterable[tuple[float, float, float, float, float]],
        *,
        anchor: str = "center",
    ) -> None:
        """Synchronous, non-blocking (no I/O). Safe to call from the
        orchestrator's hot loop.

        `persons` is one tuple per detection, in pixels of a frame_w x
        frame_h picture:

            (x1, y1, x2, y2, score)             -- as before
            (x1, y1, x2, y2, score, track_id)   -- with the caller's own id

        The sixth field is optional, so the body/YOLO path and any older
        caller keep working unchanged. When it IS there we match on it and
        skip centroid guessing entirely: the face pipeline's ids come from a
        Kalman tracker that has the whole frame history, and we have one
        point. `track_id` is opaque -- any hashable value.

        `anchor` is the point of each box tested against the line: "feet"
        (bottom-centre) for whole-body boxes, so the line is drawn on the
        floor across the doorway; "center" for face boxes, which have no
        feet."""
        state = self._cameras.get(camera_id)
        if state is None or not state.config.enabled or frame_w <= 0 or frame_h <= 0:
            return

        cfg = state.config
        line = (cfg.ax * frame_w, cfg.ay * frame_h, cfg.bx * frame_w, cfg.by * frame_h)
        feet = anchor == "feet"
        now_t = time.monotonic()
        now_dt = dt.datetime.now(dt.timezone.utc)
        bucket = _minute_bucket(now_dt)
        bucket_counts = state.pending.setdefault(
            bucket, {"in": 0, "out": 0, "falls": 0},
        )

        # Build (px, py, w, h, track_id) -- the anchor point, the box size and
        # whoever the caller says this is -- per detection.
        new_obs = []
        for box in persons:
            try:
                x1, y1, x2, y2 = float(box[0]), float(box[1]), float(box[2]), float(box[3])
                ext_id = box[5] if len(box) > 5 else None
            except (TypeError, ValueError, IndexError):
                continue
            w, h = x2 - x1, y2 - y1
            if w <= 0 or h <= 0:
                continue
            px = x1 + w * 0.5
            py = y2 if feet else y1 + h * 0.5
            new_obs.append((px, py, w, h, ext_id))

        used_tracks: set[Any] = set()

        # Pass 1: everything the caller identified. ALL of them, before any
        # centroid matching happens -- otherwise a distance guess could claim
        # the track an id owns, and the person it really belonged to would be
        # given a new track and lose its frame count.
        unidentified: list[tuple[float, float, float, float]] = []
        for px, py, w, h, ext_id in new_obs:
            if ext_id is None:
                unidentified.append((px, py, w, h))
                continue
            key = _ext_key(ext_id)
            tr = state.tracks.get(key)
            if tr is not None and key not in used_tracks:
                self._step_track(state, tr, px, py, w, h, line, bucket_counts, now_t, cfg)
            else:
                # An id we have not seen: a person the caller's tracker has
                # just started following. Not centroid-matched to anything --
                # its tracker already decided this is somebody new.
                self._birth(state, key, px, py, w, h, line, bucket_counts, now_t, cfg)
            used_tracks.add(key)

        # Pass 2: observations with no id. Nearest track inside the radius
        # that track has earned, per _match_radius -- so each candidate is
        # judged on its own box size and its own gap, not one global number.
        # Greedy, not Hungarian: at ~5-10 people per frame the loss is
        # invisible.
        for px, py, w, h in unidentified:
            best_key, best_d = None, None
            for key, tr in state.tracks.items():
                if key in used_tracks:
                    continue
                d = math.hypot(px - tr.x, py - tr.y)
                if d <= _match_radius(h, now_t - tr.last_seen) and (best_d is None or d < best_d):
                    best_key, best_d = key, d
            if best_key is not None:
                self._step_track(
                    state, state.tracks[best_key], px, py, w, h, line, bucket_counts, now_t, cfg,
                )
                used_tracks.add(best_key)
            else:
                key = state.next_id
                state.next_id += 1
                self._birth(state, key, px, py, w, h, line, bucket_counts, now_t, cfg)
                used_tracks.add(key)

        # Age out stale tracks. Doing this every frame is O(N) but N is
        # tiny (active people on this camera). Without TTL, fallen_ids /
        # counted state would leak forever.
        stale = [tid for tid, tr in state.tracks.items() if now_t - tr.last_seen > _TRACK_TTL_SEC]
        for tid in stale:
            state.tracks.pop(tid, None)

        state.last_update_ts = now_t

    @staticmethod
    def _birth(
        state: _CameraState,
        key: Any,
        px: float, py: float, w: float, h: float,
        line: tuple[float, float, float, float],
        bucket_counts: dict[str, int],
        now_t: float,
        cfg: FootfallConfig,
    ) -> _Track:
        """Open a track for a person seen for the first time, on whichever
        side of the line they are already standing. Both matching passes come
        through here, so "first sight" means one thing -- including the fall
        heuristic, which has to fire on sight or a person who is already down
        when the camera starts is never counted."""
        side = _side_of(signed_distance(px, py, *line), h)
        tr = _Track(x=px, y=py, last_seen=now_t, side=side, rx=px, ry=py)
        state.tracks[key] = tr
        if cfg.falls_enabled and w > h * 1.2:
            tr.fall_counted = True
            bucket_counts["falls"] += 1
            state.live_falls += 1
        return tr

    @staticmethod
    def _step_track(
        state: _CameraState,
        tr: _Track,
        px: float, py: float, w: float, h: float,
        line: tuple[float, float, float, float],
        bucket_counts: dict[str, int],
        now_t: float,
        cfg: FootfallConfig,
    ) -> None:
        tr.frames += 1
        side = _side_of(signed_distance(px, py, *line), h)

        if side != 0:
            if tr.side == 0 or side == tr.side:
                # First clear of the band, or still on the same side.
                tr.side, tr.rx, tr.ry = side, px, py
            elif tr.frames >= _MIN_TRACK_FRAMES and now_t - tr.last_count_t >= _RECOUNT_COOLDOWN_SEC:
                # A flip. It counts only if the step crossed the drawn
                # segment; one that went round the end of the line just
                # moves the track to the other side.
                ax, ay, bx, by = line
                seg_len = math.hypot(bx - ax, by - ay)
                tolerance = min(_END_TOLERANCE_MAX, (w * 0.5) / seg_len) if seg_len > 0 else 0.0
                d_ref = signed_distance(tr.rx, tr.ry, *line)
                d_now = signed_distance(px, py, *line)
                if crosses_segment((tr.rx, tr.ry), (px, py), d_ref, d_now, ax, ay, bx, by, tolerance):
                    if side == cfg.in_sign:
                        bucket_counts["in"] += 1
                        state.live_in += 1
                    else:
                        bucket_counts["out"] += 1
                        state.live_out += 1
                    tr.last_count_t = now_t
                tr.side, tr.rx, tr.ry = side, px, py
            # else: a flip from a track too young, or inside the cooldown.
            # Not committed -- the next frame re-checks, so someone who
            # really stays on the new side is counted once the guard lapses.

        # Fall heuristic — once per track only.
        if cfg.falls_enabled and not tr.fall_counted and w > h * 1.2:
            tr.fall_counted = True
            bucket_counts["falls"] += 1
            state.live_falls += 1

        tr.x, tr.y, tr.last_seen = px, py, now_t

    # ── Live read paths (no I/O) ─────────────────────────────────────────

    def live_snapshot(self) -> dict[uuid.UUID, dict[str, Any]]:
        """Return the current per-camera in-memory counters. Used by the
        live API endpoint — cheap and lock-free for read."""
        out: dict[uuid.UUID, dict[str, Any]] = {}
        for cam_id, st in self._cameras.items():
            out[cam_id] = {
                "tenant_id": str(st.tenant_id),
                "enabled": st.config.enabled,
                "line": st.config.line,
                "line_y_frac": st.config.line_y_frac,
                "direction": st.config.direction,
                "falls_enabled": st.config.falls_enabled,
                "in_count_session": st.live_in,
                "out_count_session": st.live_out,
                "falls_count_session": st.live_falls,
                "active_tracks": len(st.tracks),
                "last_update_age_sec": (
                    round(time.monotonic() - st.last_update_ts, 1)
                    if st.last_update_ts > 0 else None
                ),
            }
        return out

    # ── Flush loop ───────────────────────────────────────────────────────

    async def _flush_loop(self) -> None:
        log.info("footfall flusher started", interval_sec=_FLUSH_INTERVAL_SEC)
        try:
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=_FLUSH_INTERVAL_SEC)
                    break    # stop signal received
                except asyncio.TimeoutError:
                    pass
                try:
                    await self._flush_once()
                except Exception as e:
                    log.warning("footfall flush failed", err=str(e))
        finally:
            log.info("footfall flusher stopped")

    async def _flush_once(self) -> None:
        # Snapshot the pending deltas under the lock, then drain them
        # outside the lock so the orchestrator can keep updating.
        snapshots: list[tuple[uuid.UUID, _CameraState, dict[dt.datetime, dict[str, int]]]] = []
        async with self._lock:
            for cam_id, st in self._cameras.items():
                if not st.pending:
                    continue
                snapshots.append((cam_id, st, st.pending))
                st.pending = {}
        if not snapshots:
            return

        async with session_scope() as session:
            for cam_id, st, pending in snapshots:
                await self._upsert(session, cam_id, st.tenant_id, pending)
            await session.commit()

    async def _flush_one(self, camera_id: uuid.UUID, state: _CameraState, *, force: bool) -> None:
        """Drain just one camera (used on remove_camera), scoped tightly so it
        doesn't touch other cameras' state."""
        if not state.pending and not force:
            return
        pending = state.pending
        state.pending = {}
        await self._write_buckets(camera_id, state.tenant_id, pending)

    # -- The one UPSERT -------------------------------------------------
    #
    # Three paths drain into Postgres: the periodic flusher, a camera being
    # removed, and a camera being reconfigured. They differ only in which
    # state they take the deltas from, so the write lives here once. Three
    # copies of an ON CONFLICT clause is three places for the "add, never
    # overwrite" rule to drift apart.

    @staticmethod
    async def _upsert(
        session: Any,
        camera_id: uuid.UUID,
        tenant_id: uuid.UUID,
        pending: dict[dt.datetime, dict[str, int]],
    ) -> None:
        """Apply one camera's per-minute deltas on an already-open session.
        The caller commits."""
        for bucket, counts in pending.items():
            stmt = pg_insert(FootfallMinuteBucket).values(
                tenant_id=tenant_id,
                camera_id=camera_id,
                bucket_minute=bucket,
                in_count=counts["in"],
                out_count=counts["out"],
                falls_count=counts["falls"],
            )
            # The bucket exists when an earlier flush already wrote to the
            # same (camera, minute). We ADD deltas; we never overwrite --
            # several flush cycles per minute is the normal case (every 5 s),
            # and so is a reconfigure landing inside a minute already written.
            stmt = stmt.on_conflict_do_update(
                index_elements=["camera_id", "bucket_minute"],
                set_={
                    "in_count":    FootfallMinuteBucket.in_count + counts["in"],
                    "out_count":   FootfallMinuteBucket.out_count + counts["out"],
                    "falls_count": FootfallMinuteBucket.falls_count + counts["falls"],
                },
            )
            await session.execute(stmt)

    async def _write_buckets(
        self,
        camera_id: uuid.UUID,
        tenant_id: uuid.UUID,
        pending: dict[dt.datetime, dict[str, int]],
    ) -> None:
        """Write one camera's already-detached deltas in their own
        transaction. Nothing to write is not an error."""
        if not pending:
            return
        async with session_scope() as session:
            await self._upsert(session, camera_id, tenant_id, pending)
            await session.commit()


# Module-level singleton. Lazy-built so import order doesn't matter.

_registry: FootfallRegistry | None = None


def get_registry() -> FootfallRegistry:
    global _registry
    if _registry is None:
        _registry = FootfallRegistry()
    return _registry
