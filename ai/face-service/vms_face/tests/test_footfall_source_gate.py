"""The footfall body source is refused out loud, and faces keep counting.

PIPELINE_PERSON_DETECTION_ENABLED selects YOLO person boxes as footfall's
box source. Those boxes carry no track id, and footfall cannot count a
crossing without one: given id-less boxes the registry falls back to
matching one centroid per update, which under the every_n cadence opens a
new track every time, never reaches _MIN_TRACK_FRAMES = 3, and counts
nothing while every health signal stays green. Turning the flag on would
therefore not degrade the count -- it would ZERO it, silently, undoing the
track-id fix that made the gate work at all.

So the flag stays false, and this is the rail that makes holding that
decision safe: the body source is refused rather than quietly accepted,
the refusal is logged once per camera at warning level naming the flag so
the cause is findable from a log alone, and counting continues from the
face tracker on every fed frame.

What is checked here: the refusal fires with the flag on and the model
loaded, once per camera, naming the flag; nothing at all is logged with
the flag off; "off" is distinguishable from "broken"; a source that DOES
carry ids is accepted unchanged; a source that claims ids but omits them
is refused too; and a face-fed camera's counts are identical with the flag
on and off.

Run inside the ai container (no GPU, no Redis, no Postgres needed):

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_footfall_source_gate -v
"""
from __future__ import annotations

import asyncio
import unittest
import uuid
from unittest import mock

from vms_face.services import footfall, footfall_source
from vms_face.services.footfall import FootfallConfig, FootfallRegistry
from vms_face.services.footfall_source import FootfallSourceGate, source_emits_track_ids

W, H = 1000, 1000
TENANT = uuid.uuid4()
LINE = {"a": [0.1, 0.5], "b": [0.9, 0.5]}

FACE_W = FACE_H = 60.0
BODY_W, BODY_H = 80.0, 200.0
TICK = 0.5

# Six updates straight down the middle, 120 px apart; the line at y=500 is
# crossed between the 4th and the 5th. Same walk as test_footfall_track_id.
DESCENT = [100.0, 220.0, 340.0, 460.0, 580.0, 700.0]


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class FakeDetector:
    """Stands in for YOLOPersonDetector. `emits_track_ids` is the contract
    the gate reads; the real class sets it False."""

    def __init__(self, emits_track_ids: bool) -> None:
        self.emits_track_ids = emits_track_ids


class NoAttrDetector:
    """A detector that never heard of the attribute. Must be treated as
    id-less: a source has to opt in, silence is not consent."""


def face_box(cx: float, cy: float, track_id):
    return (
        cx - FACE_W / 2, cy - FACE_H / 2, cx + FACE_W / 2, cy + FACE_H / 2,
        0.9, track_id,
    )


def body_box(cx: float, feet_y: float, track_id=None):
    """A whole-body box, anchored at the feet. A 5-tuple like the real
    detector's output, or 6 if a tracker has been put in front of it."""
    box = (cx - BODY_W / 2, feet_y - BODY_H, cx + BODY_W / 2, feet_y, 0.9)
    return box if track_id is None else (*box, track_id)


class GateTest(unittest.TestCase):
    def setUp(self):
        self.log = mock.patch.object(footfall_source, "log").start()
        self.addCleanup(mock.patch.stopall)

    # -- helpers ---------------------------------------------------------

    def warnings(self):
        return self.log.warning.call_args_list

    def assert_named_the_flag(self, call):
        """A log line is only useful here if an operator can find the cause
        from it with no code in hand. That means the flag's own name."""
        self.assertEqual(call.kwargs["flag"], "PIPELINE_PERSON_DETECTION_ENABLED")
        self.assertIn("footfall", call.args[0].lower())
        self.assertTrue(call.kwargs["reason"])

    # -- the refusal -----------------------------------------------------

    def test_flag_on_with_the_model_loaded_is_refused_and_logged_once(self):
        gate = FootfallSourceGate("CAM-1")
        detector = FakeDetector(emits_track_ids=False)
        boxes = [body_box(500.0, 400.0)]

        # Twenty frames, i.e. the warning is not per-frame noise.
        for _ in range(20):
            self.assertFalse(
                gate.allows_body(enabled=True, detector=detector, boxes=boxes),
            )

        self.assertTrue(gate.refused)
        self.assertEqual(len(self.warnings()), 1)
        self.assert_named_the_flag(self.warnings()[0])
        # The prerequisite is in the message, not only in a comment.
        self.assertIn("tracker", self.warnings()[0].kwargs["reason"])

    def test_the_refusal_is_decided_before_anyone_walks_past(self):
        # An empty scene says nothing about the tuple shape, so the decision
        # is read off the detector. An operator must not have to wait for
        # footfall traffic to learn the source was rejected.
        gate = FootfallSourceGate("CAM-1")
        self.assertFalse(
            gate.allows_body(enabled=True, detector=FakeDetector(False), boxes=[]),
        )
        self.assertEqual(len(self.warnings()), 1)

        gate_none = FootfallSourceGate("CAM-2")
        self.assertFalse(
            gate_none.allows_body(
                enabled=True, detector=FakeDetector(False), boxes=None,
            ),
        )
        self.assertEqual(len(self.warnings()), 2)

    def test_a_detector_with_no_opinion_counts_as_id_less(self):
        gate = FootfallSourceGate("CAM-1")
        self.assertFalse(source_emits_track_ids(NoAttrDetector()))
        self.assertFalse(
            gate.allows_body(enabled=True, detector=NoAttrDetector(), boxes=None),
        )
        self.assertEqual(len(self.warnings()), 1)

    def test_once_per_camera_not_once_per_process(self):
        # Each orchestrator owns its own gate, so a second camera with the
        # same misconfiguration still gets told.
        detector = FakeDetector(emits_track_ids=False)
        for code in ("CAM-1", "CAM-2", "CAM-3"):
            gate = FootfallSourceGate(code)
            for _ in range(5):
                gate.allows_body(enabled=True, detector=detector, boxes=None)
        self.assertEqual(len(self.warnings()), 3)
        self.assertEqual(
            [c.kwargs["camera"] for c in self.warnings()],
            ["CAM-1", "CAM-2", "CAM-3"],
        )

    # -- silence, where silence is correct -------------------------------

    def test_nothing_is_logged_when_the_flag_is_off(self):
        # Faces are the intended source. There is nothing to warn about, and
        # a warning on every camera in the fleet would train operators to
        # ignore the one that matters.
        gate = FootfallSourceGate("CAM-1")
        for _ in range(20):
            self.assertFalse(
                gate.allows_body(
                    enabled=False,
                    detector=FakeDetector(False),
                    boxes=[body_box(500.0, 400.0)],
                ),
            )
        self.assertFalse(gate.refused)
        self.assertEqual(self.warnings(), [])

    def test_flag_off_stays_silent_even_with_no_detector(self):
        gate = FootfallSourceGate("CAM-1")
        self.assertFalse(gate.allows_body(enabled=False, detector=None, boxes=None))
        self.assertEqual(self.warnings(), [])

    # -- off vs broken ---------------------------------------------------

    def test_flag_on_with_no_detector_says_so(self):
        # The gap this closes: a missing or unloadable model made footfall
        # fall back to faces with no trace, so an operator who had set the
        # flag could not tell "off" from "broken".
        gate = FootfallSourceGate("CAM-1")
        self.assertFalse(gate.allows_body(enabled=True, detector=None, boxes=None))
        self.assertEqual(len(self.warnings()), 1)
        self.assert_named_the_flag(self.warnings()[0])
        self.assertIn("no detector", self.warnings()[0].kwargs["reason"])

    # -- the other direction: ids are accepted, unchanged ----------------

    def test_an_id_carrying_source_is_accepted_silently(self):
        # The prerequisite, once met: a tracker in front of the detector.
        # This branch must then light up with no further edit.
        gate = FootfallSourceGate("CAM-1")
        detector = FakeDetector(emits_track_ids=True)
        for y in DESCENT:
            self.assertTrue(
                gate.allows_body(
                    enabled=True,
                    detector=detector,
                    boxes=[body_box(500.0, y, "p1")],
                ),
            )
        self.assertFalse(gate.refused)
        self.assertEqual(self.warnings(), [])

    def test_an_id_carrying_source_is_accepted_on_a_skipped_frame_too(self):
        # every_n means most frames carry no boxes at all. That is not a
        # reason to re-decide the source.
        gate = FootfallSourceGate("CAM-1")
        detector = FakeDetector(emits_track_ids=True)
        self.assertTrue(gate.allows_body(enabled=True, detector=detector, boxes=None))
        self.assertTrue(gate.allows_body(enabled=True, detector=detector, boxes=[]))
        self.assertEqual(self.warnings(), [])

    def test_a_source_that_claims_ids_but_omits_them_is_refused(self):
        # Belt and braces. A detector lying about its contract would
        # reintroduce the exact silent zero this gate exists to prevent, so
        # the claim is checked against the boxes before the count is
        # entrusted to it.
        gate = FootfallSourceGate("CAM-1")
        self.assertFalse(
            gate.allows_body(
                enabled=True,
                detector=FakeDetector(True),
                boxes=[body_box(500.0, 400.0, "p1"), body_box(300.0, 400.0)],
            ),
        )
        self.assertEqual(len(self.warnings()), 1)
        self.assert_named_the_flag(self.warnings()[0])
        self.assertIn("declares", self.warnings()[0].kwargs["reason"])

    def test_the_refusal_is_sticky(self):
        # Once refused, a camera stays refused: re-deciding per frame would
        # mean feeding faces only on the frames YOLO happened to run, and
        # starving the face source in between.
        gate = FootfallSourceGate("CAM-1")
        gate.allows_body(enabled=True, detector=FakeDetector(False), boxes=None)
        self.assertTrue(gate.refused)
        # Even when handed a perfectly good source afterwards.
        self.assertFalse(
            gate.allows_body(
                enabled=True,
                detector=FakeDetector(True),
                boxes=[body_box(500.0, 400.0, "p1")],
            ),
        )
        self.assertEqual(len(self.warnings()), 1)

    # -- the real detector's own contract --------------------------------

    def test_the_shipped_detector_declares_itself_id_less(self):
        # If someone puts a tracker in front of YOLO and forgets to flip
        # this, body counting stays off and the warning keeps firing -- the
        # safe direction. If someone flips it without writing the tracker,
        # the box-shape check above catches it.
        from vms_face.infra.person_detector import YOLOPersonDetector

        self.assertFalse(YOLOPersonDetector.emits_track_ids)
        self.assertFalse(source_emits_track_ids(YOLOPersonDetector))


class CountsUnchangedTest(unittest.TestCase):
    """The hard guarantee: this change must not alter a single count on any
    camera that counts today. Every such camera is face-fed, so the walk
    below is run twice -- flag off, then flag on with the model loaded --
    and the two must agree exactly."""

    def setUp(self):
        self.clock = Clock()
        mock.patch.object(footfall.time, "monotonic", self.clock).start()
        mock.patch.object(footfall_source, "log").start()
        self.addCleanup(mock.patch.stopall)

    def walk(self, *, enabled: bool, detector) -> tuple[int, int, int]:
        """One camera, one person walking down through the line.

        The source selection mirrors orchestrator._consume_loop: ask the
        gate, take body boxes if it allows them, otherwise the face
        tracker's 6-tuples, and never both."""
        self.clock.t = 100.0
        cam = uuid.uuid4()
        reg = FootfallRegistry()
        cfg = FootfallConfig.from_camera_config(
            {"footfall": {"enabled": True, "line": LINE, "direction": "right_is_in"}},
        )
        asyncio.run(reg.configure_camera(cam, TENANT, cfg))
        gate = FootfallSourceGate("CAM-1")

        for y in DESCENT:
            person_boxes = [body_box(500.0, y + 70.0)]   # same person, feet lower
            body_source = gate.allows_body(
                enabled=enabled, detector=detector, boxes=person_boxes,
            )
            src = person_boxes if body_source else [face_box(500.0, y, "t1")]
            reg.update(cam, W, H, src, anchor="feet" if body_source else "center")
            self.clock.t += TICK

        st = reg._cameras[cam]
        return st.live_in, st.live_out, len(st.tracks)

    def test_a_face_fed_camera_counts_the_same_with_the_flag_on(self):
        off = self.walk(enabled=False, detector=FakeDetector(False))
        on = self.walk(enabled=True, detector=FakeDetector(False))
        self.assertEqual(off, (1, 0, 1))    # the walk is counted at all
        self.assertEqual(on, off)           # and the flag changed nothing

    def test_a_broken_model_also_counts_the_same(self):
        self.assertEqual(
            self.walk(enabled=True, detector=None),
            self.walk(enabled=False, detector=FakeDetector(False)),
        )

    def test_the_two_runs_used_different_sources_or_this_proves_nothing(self):
        # Guards the premise: with ids available the body branch really is
        # taken, so the equality above is a fallback being exercised and not
        # two identical code paths.
        self.assertTrue(
            FootfallSourceGate("CAM-1").allows_body(
                enabled=True,
                detector=FakeDetector(True),
                boxes=[body_box(500.0, 400.0, "p1")],
            ),
        )
        self.assertFalse(
            FootfallSourceGate("CAM-2").allows_body(
                enabled=True, detector=FakeDetector(False), boxes=None,
            ),
        )


if __name__ == "__main__":
    unittest.main()
