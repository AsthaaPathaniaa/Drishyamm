"""Which box source is allowed to feed the footfall counter.

Footfall counts a *crossing*: the same person observed on one side of the
line and then the other. That needs identity across updates, and the
registry (services/footfall.py) can only get it from a `track_id` the
caller supplies. Given boxes with no id it falls back to nearest-centroid
matching from a single point per update -- which is exactly the failure
already paid for once: under attention scheduling the counter is fed about
once a second, a walking person covers hundreds of pixels in that gap, so
every update opened a fresh track, no track reached
`footfall._MIN_TRACK_FRAMES` (3), and the gate counted nobody while every
health signal stayed green.

So an id-less source is not a degraded footfall count. It is a ZERO count
that looks healthy. This gate refuses such a source outright and says so,
once per camera, at warning level, naming the env flag that selected it --
because the thing that made the original bug expensive was silence, not
the miscount.

Two sources exist today:

  * SCRFD face tracker boxes -- 6-tuples carrying the SORT track id from
    services/face_tracker.py (Kalman + Hungarian, ids that survive a
    detector miss). Accepted. This is what every counting camera uses.
  * YOLOv8 person boxes -- 5-tuples from infra/person_detector.py, no id,
    and produced only every Nth frame on top of the detect cadence.
    Refused.

PREREQUISITE for body counting (deliberately NOT implemented): the person
boxes need a tracker of their own, the same pattern as
services/face_tracker.py, emitting (x1, y1, x2, y2, score, track_id) with
ids that survive a miss. A detector that does that sets
`emits_track_ids = True` and this gate accepts it with no further change.

ONE source per camera, always. Mixing face and body boxes to paper over
the missing ids is not an option: two different anchor points (face centre
one frame, feet the next) for the same person is a worse failure than the
one being fixed. A camera whose body source is refused counts from faces
on *every* fed frame, exactly as it does with the flag off.
"""
from __future__ import annotations

from typing import Any, Sequence

from vms_face.core.logging import get_logger

log = get_logger(__name__)

# The flag an operator sets to select the body source. Named in the warning
# so the cause is findable from a log line alone, with no code reading.
_FLAG = "PIPELINE_PERSON_DETECTION_ENABLED"

# A box carries an id when it has a sixth field; see FootfallRegistry.update.
_ID_FIELD_INDEX = 5


def source_emits_track_ids(detector: Any) -> bool:
    """Does this detector promise a `track_id` on every box?

    Read off the detector rather than guessed from a frame's worth of
    boxes, so the refusal is decided (and logged) on the first footfall
    frame instead of waiting for someone to walk past. Absent attribute
    means no -- a source has to opt in.
    """
    return bool(getattr(detector, "emits_track_ids", False))


class FootfallSourceGate:
    """Per-camera decision: may the body source feed footfall?

    Stateful on purpose. Once refused, a camera stays refused for the life
    of the process: the answer cannot change under us, and re-deciding per
    frame would mean feeding faces only on the frames YOLO happened to run
    (starving the face source between runs). The warning is emitted once
    for the same reason -- a per-frame warning on every camera is noise an
    operator learns to ignore.
    """

    __slots__ = ("_camera_code", "_refused")

    def __init__(self, camera_code: str) -> None:
        self._camera_code = camera_code
        self._refused = False

    @property
    def refused(self) -> bool:
        return self._refused

    def allows_body(
        self,
        *,
        enabled: bool,
        detector: Any,
        boxes: Sequence[tuple] | None = None,
    ) -> bool:
        """True when `boxes` from `detector` may be fed to the registry.

        `enabled` is settings.pipeline_person_detection_enabled. When it is
        false nothing is logged at all: faces are the intended source and
        there is nothing to warn about.
        """
        if not enabled:
            return False
        if self._refused:
            return False

        if detector is None:
            # Flag on, no detector: the model is missing or failed to load.
            # Footfall silently falls back to faces, which is the right
            # count -- but an operator who set the flag deserves to be able
            # to tell "off" from "broken" without reading code.
            self._refuse("person detection is enabled but no detector is loaded")
            return False

        if not source_emits_track_ids(detector):
            self._refuse(
                "person boxes carry no track id, so a crossing counter fed from "
                "them would count zero; person boxes need a tracker of their own "
                "(see services/face_tracker.py) before they can feed footfall"
            )
            return False

        # Belt and braces: the source says it emits ids, so check that it
        # does before trusting the count to it. A detector that lies here
        # would reintroduce the silent zero this module exists to prevent.
        if boxes and any(len(b) <= _ID_FIELD_INDEX for b in boxes):
            self._refuse(
                "detector declares emits_track_ids but produced boxes without one"
            )
            return False

        return True

    def _refuse(self, reason: str) -> None:
        self._refused = True
        log.warning(
            "footfall refusing body boxes; counting from the face tracker instead",
            camera=self._camera_code,
            flag=_FLAG,
            reason=reason,
        )
