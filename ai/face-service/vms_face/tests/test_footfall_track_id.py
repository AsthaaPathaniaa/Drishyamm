"""Footfall association: the caller's track id, and the fallback radius.

The gate counted nobody while looking perfectly healthy. Counting is
face-only by decision, so the boxes are faces, 40-80 px tall; the counter is
fed only on frames that produced detections, which under attention
scheduling (settings.attention_latched_every_n = 4 at target_fps 4) is about
once a second. A walking person covers several hundred pixels in that
second, far outside the old flat 60 px centroid radius, so every update
opened a brand-new track, no track ever reached _MIN_TRACK_FRAMES = 3, and
nothing was ever counted.

The pipeline already knew who was who -- services/face_tracker.py is SORT
(Kalman + Hungarian) with ids that survive a detector miss -- and threw the
id away at the boundary. Now it is passed, and the centroid radius is a
fallback that scales with box height and the gap being bridged.

What is checked here: the walker that used to be lost is counted exactly
once (with an id, and on the fallback path too); an id carries a person
through a missed detection; two people close together stay two people; and
the guards that stop false counts -- dead band, 3-frame minimum, cooldown,
between-the-ends -- are all still in force.

Run inside the ai container (no GPU, no Redis, no Postgres needed):

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_footfall_track_id -v
"""
from __future__ import annotations

import asyncio
import unittest
import uuid
from unittest import mock

from vms_face.services import footfall
from vms_face.services.footfall import FootfallConfig, FootfallRegistry

W, H = 1000, 1000
CAM = uuid.uuid4()
TENANT = uuid.uuid4()

# A level line across the middle. For a left-to-right line, "right of a->b"
# is BELOW it on screen, so walking down counts IN.
LINE = {"a": [0.1, 0.5], "b": [0.9, 0.5]}

# Face boxes: 60 px tall, the middle of the 40-80 px the detector gives.
FACE_H = 60.0
FACE_W = 60.0

# Fed once every half second -- optimistic next to the ~1 s attention
# scheduling allows, and still 120 px of travel per update below.
TICK = 0.5


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def face_box(cx: float, cy: float, track_id: str | None = None):
    """A face box centred on (cx, cy), with or without the caller's id."""
    box = (cx - FACE_W / 2, cy - FACE_H / 2, cx + FACE_W / 2, cy + FACE_H / 2, 0.9)
    return box if track_id is None else (*box, track_id)


def registry() -> FootfallRegistry:
    reg = FootfallRegistry()
    cfg = FootfallConfig.from_camera_config(
        {"footfall": {"enabled": True, "line": LINE, "direction": "right_is_in"}},
    )
    asyncio.run(reg.configure_camera(CAM, TENANT, cfg))
    return reg


def counts(reg: FootfallRegistry) -> tuple[int, int]:
    st = reg._cameras[CAM]
    return st.live_in, st.live_out


def tracks(reg: FootfallRegistry) -> int:
    return len(reg._cameras[CAM].tracks)


# Six updates straight down the middle, 120 px apart. The line at y=500 is
# crossed between the 4th (y=460, above) and the 5th (y=580, below), by
# which point the track has the 3 frames the counter insists on.
DESCENT = [100.0, 220.0, 340.0, 460.0, 580.0, 700.0]


class TrackIdTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        patcher = mock.patch.object(footfall.time, "monotonic", self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tick(self):
        self.clock.t += TICK

    # ── the walker that used to be lost ──────────────────────────────────

    def test_a_walker_moving_120px_per_update_is_counted_once(self):
        reg = registry()
        for y in DESCENT:
            reg.update(CAM, W, H, [face_box(500.0, y, "t1")], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (1, 0))
        # One person, one track -- not six.
        self.assertEqual(tracks(reg), 1)

    def test_the_same_walk_also_works_without_an_id(self):
        # The fallback radius has to cover the same gap, or a caller that
        # cannot supply an id (the YOLO body path) is back where we started.
        reg = registry()
        for y in DESCENT:
            reg.update(CAM, W, H, [face_box(500.0, y)], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (1, 0))
        self.assertEqual(tracks(reg), 1)

    def test_the_old_flat_radius_could_not_have_done_either(self):
        # Guards the premise: 120 px per update against the 60 px that used
        # to be the whole rule. If someone reverts the radius to a constant,
        # this is the line that says why it was not one.
        self.assertGreater(120.0, 60.0)
        self.assertGreaterEqual(footfall._match_radius(FACE_H, TICK), 120.0)
        # A still person with a tiny box keeps the old tolerance exactly.
        self.assertEqual(footfall._match_radius(0.0, 0.0), 60.0)
        # ...and it is capped: "could have walked there" stops being evidence.
        self.assertEqual(footfall._match_radius(5000.0, 10.0), footfall._RADIUS_MAX_PX)
        # Bigger box, or a longer gap, earns more room. Never less.
        self.assertGreater(footfall._match_radius(80.0, TICK), footfall._match_radius(40.0, TICK))
        self.assertGreater(footfall._match_radius(FACE_H, 1.0), footfall._match_radius(FACE_H, 0.1))

    # ── an id survives a detector miss ───────────────────────────────────

    def test_an_id_carries_one_person_through_a_missed_detection(self):
        # The face tracker keeps a track alive across misses, so the id comes
        # back. A second person keeps update() being called meanwhile --
        # which is what really happens, since the orchestrator only calls us
        # when it has at least one box.
        reg = registry()
        bystander = face_box(120.0, 120.0, "t-still")
        for i, y in enumerate(DESCENT):
            boxes = [bystander]
            if i != 2:                      # the walker is missed once
                boxes.append(face_box(500.0, y, "t1"))
            reg.update(CAM, W, H, boxes, anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (1, 0))
        # The walker plus the bystander. The miss did not open a third.
        self.assertEqual(tracks(reg), 2)

    def test_a_miss_longer_than_the_ttl_is_a_new_person(self):
        # Unchanged behaviour, pinned: _TRACK_TTL_SEC still forgets a track,
        # id or no id, so state cannot accumulate for ever.
        reg = registry()
        reg.update(CAM, W, H, [face_box(500.0, 100.0, "t1")], anchor="center")
        self.clock.t += footfall._TRACK_TTL_SEC + 0.1
        reg.update(CAM, W, H, [face_box(500.0, 120.0, "t2")], anchor="center")
        self.assertEqual(tracks(reg), 1)

    # ── two people stay two people ───────────────────────────────────────

    def test_two_people_80px_apart_are_not_merged(self):
        reg = registry()
        for y in DESCENT:
            reg.update(CAM, W, H, [
                face_box(460.0, y, "tA"),
                face_box(540.0, y, "tB"),       # 80 px to the right
            ], anchor="center")
            self.tick()
        # Two tracks, and both crossings counted.
        self.assertEqual(tracks(reg), 2)
        self.assertEqual(counts(reg), (2, 0))

    def test_two_people_80px_apart_are_not_merged_without_ids(self):
        # On the fallback path the generous radius could reach the other
        # person -- but one observation per track is enforced, so the worst
        # case is a swap, never a merge. Two people in, two people counted.
        reg = registry()
        for y in DESCENT:
            reg.update(CAM, W, H, [
                face_box(460.0, y),
                face_box(540.0, y),
            ], anchor="center")
            self.tick()
        self.assertEqual(tracks(reg), 2)
        self.assertEqual(counts(reg), (2, 0))

    def test_a_second_person_cannot_steal_an_identified_track(self):
        # An unidentified box sitting right on top of an identified one must
        # not claim its track: ids are matched first, for exactly this.
        reg = registry()
        for y in DESCENT:
            reg.update(CAM, W, H, [
                face_box(500.0, y),             # no id, same place
                face_box(500.0, y, "t1"),       # the identified walker
            ], anchor="center")
            self.tick()
        self.assertEqual(tracks(reg), 2)
        self.assertEqual(reg._cameras[CAM].tracks.get(footfall._ext_key("t1")).frames, 6)

    def test_ids_and_unidentified_boxes_mix_in_one_update(self):
        reg = registry()
        reg.update(CAM, W, H, [
            face_box(200.0, 100.0, "t1"),
            face_box(800.0, 100.0),
        ], anchor="center")
        self.assertEqual(tracks(reg), 2)
        self.assertIn(footfall._ext_key("t1"), reg._cameras[CAM].tracks)
        # Ours are still plain ints, so the two namespaces cannot collide.
        self.assertIn(1, reg._cameras[CAM].tracks)

    # ── the guards are untouched ─────────────────────────────────────────

    def test_the_three_frame_minimum_still_applies(self):
        # A ghost that appears mid-air on the far side and vanishes: two
        # updates is not enough to be believed, whatever its id.
        reg = registry()
        reg.update(CAM, W, H, [face_box(500.0, 400.0, "ghost")], anchor="center")
        self.tick()
        reg.update(CAM, W, H, [face_box(500.0, 600.0, "ghost")], anchor="center")
        self.assertEqual(counts(reg), (0, 0))

    def test_jitter_inside_the_dead_band_still_counts_nothing(self):
        reg = registry()
        for i in range(12):
            y = 498.0 if i % 2 else 502.0       # +-2 px, inside the band
            reg.update(CAM, W, H, [face_box(500.0, y, "t1")], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (0, 0))

    def test_walking_past_the_end_of_the_segment_still_counts_nothing(self):
        # The line spans x 100..900; this walker crosses its extension at
        # x=970, outside the door.
        reg = registry()
        for y in DESCENT:
            reg.update(CAM, W, H, [face_box(970.0, y, "t1")], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (0, 0))

    def test_the_cooldown_still_absorbs_a_flip_straight_back(self):
        reg = registry()
        for y in DESCENT[:5]:                   # counts IN at y=580
            reg.update(CAM, W, H, [face_box(500.0, y, "t1")], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (1, 0))
        # Step back over the line inside _RECOUNT_COOLDOWN_SEC of the count.
        self.clock.t -= TICK                    # back to just after the count
        reg.update(CAM, W, H, [face_box(500.0, 420.0, "t1")], anchor="center")
        self.assertEqual(counts(reg), (1, 0))

    def test_in_then_out_on_one_id_counts_both(self):
        reg = registry()
        for y in DESCENT:
            reg.update(CAM, W, H, [face_box(500.0, y, "t1")], anchor="center")
            self.tick()
        for y in reversed(DESCENT):
            reg.update(CAM, W, H, [face_box(500.0, y, "t1")], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (1, 1))
        self.assertEqual(tracks(reg), 1)

    def test_direction_still_decides_which_way_is_in(self):
        reg = FootfallRegistry()
        cfg = FootfallConfig.from_camera_config(
            {"footfall": {"enabled": True, "line": LINE, "direction": "left_is_in"}},
        )
        asyncio.run(reg.configure_camera(CAM, TENANT, cfg))
        for y in DESCENT:
            reg.update(CAM, W, H, [face_box(500.0, y, "t1")], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (0, 1))

    # ── the body path is untouched ───────────────────────────────────────

    def test_a_five_tuple_body_box_still_works_on_the_feet_anchor(self):
        reg = registry()
        for y in DESCENT:
            # 80x200 body box whose FEET are at y.
            reg.update(CAM, W, H, [(460.0, y - 200.0, 540.0, y, 0.9)], anchor="feet")
            self.tick()
        self.assertEqual(counts(reg), (1, 0))

    def test_a_malformed_box_is_skipped_not_fatal(self):
        reg = registry()
        reg.update(CAM, W, H, [
            (1.0, 2.0),                                  # too short
            None,                                        # not a box at all
            (500.0, 500.0, 400.0, 400.0, 0.9),           # inverted -> w,h <= 0
            face_box(500.0, 100.0, "t1"),                # the real one
        ], anchor="center")
        self.assertEqual(tracks(reg), 1)
        self.assertEqual(counts(reg), (0, 0))

    def test_a_disabled_gate_still_counts_nothing(self):
        reg = FootfallRegistry()
        cfg = FootfallConfig.from_camera_config({"footfall": {"enabled": False, "line": LINE}})
        asyncio.run(reg.configure_camera(CAM, TENANT, cfg))
        for y in DESCENT:
            reg.update(CAM, W, H, [face_box(500.0, y, "t1")], anchor="center")
            self.tick()
        self.assertEqual(counts(reg), (0, 0))


if __name__ == "__main__":
    unittest.main()
