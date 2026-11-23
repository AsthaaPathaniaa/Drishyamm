"""ZONE_SIM_MONITORS can only ever NARROW what the product says.

Selection used to come from this environment variable alone, read once at
import. Set to `all` it opened every camera in the deployment on the main
stream and held the session permanently -- cameras with no zone, cameras whose
AI a human had switched off, cameras on accounts without an AI plan. The
backend answers now, on four conditions this service cannot see
(AI switch, an enabled zone, the plan, and the per-camera
`settings.ai.zoneBodyDetection`), and the env var survives only as a
development filter over that answer.

The property pinned here is the one that makes the whole arrangement safe:
there is NO value of ZONE_SIM_MONITORS, and no ZONE_SIM_SOURCES override, that
adds a camera the backend did not list. Every test below is a way someone might
accidentally reintroduce widening.

Stdlib only, and `cv2` is stubbed so the module imports without OpenCV
installed. Run from this directory:

    cd ai/zone-guard && python -m unittest test_camera_selection -v
"""
from __future__ import annotations

import logging
import sys
import types
import unittest

# zone_sim imports cv2 at module level for the video capture it does not do
# here. A stub keeps this test runnable anywhere, including CI with no OpenCV.
sys.modules.setdefault("cv2", types.ModuleType("cv2"))

import zone_sim  # noqa: E402

# The "names a camera the product does not list" warning is deliberate
# behaviour (and asserted for elsewhere by reading the code, not the log), but
# the exhaustive subset test below triggers it hundreds of times. Silenced so a
# failure is readable.
zone_sim.log.setLevel(logging.ERROR)


def cam(monitor_id: str, **over) -> dict:
    """A camera row as /api/internal/zone-guard/cameras returns it."""
    return {
        "monitorId": monitor_id,
        "userId": "owner-1",
        "name": monitor_id.upper(),
        "rtsp": f"rtsp://relay/cam_{monitor_id}",
        **over,
    }


def monitors_of(picked: list[dict]) -> list[str]:
    return sorted(c["monitorId"] for c in picked)


LISTED = [cam("cam-a"), cam("cam-b"), cam("cam-c")]


class ParseFilterTest(unittest.TestCase):
    def test_all_means_no_filter_not_everything(self):
        # The distinction that matters: None is "whatever the product says",
        # which is not the same as a set containing the whole fleet.
        for raw in ("all", "ALL", "*", "", "   ", "  all  "):
            self.assertIsNone(zone_sim.parse_monitor_filter(raw), raw)

    def test_a_list_becomes_a_set(self):
        self.assertEqual(zone_sim.parse_monitor_filter("cam-a,cam-b"), {"cam-a", "cam-b"})

    def test_whitespace_and_empty_entries_are_tolerated(self):
        self.assertEqual(zone_sim.parse_monitor_filter(" cam-a , , cam-b ,"), {"cam-a", "cam-b"})

    def test_none_and_missing_are_no_filter(self):
        self.assertIsNone(zone_sim.parse_monitor_filter(None))


class NarrowingTest(unittest.TestCase):
    """The safety property, from every angle someone might break it."""

    def test_no_filter_takes_exactly_what_the_backend_listed(self):
        picked = zone_sim.select_cameras(LISTED, None)
        self.assertEqual(monitors_of(picked), ["cam-a", "cam-b", "cam-c"])

    def test_a_filter_takes_a_subset(self):
        picked = zone_sim.select_cameras(LISTED, {"cam-a", "cam-c"})
        self.assertEqual(monitors_of(picked), ["cam-a", "cam-c"])

    def test_naming_a_camera_the_backend_did_NOT_list_adds_nothing(self):
        # The old defect, stated as a test. `cam-z` has no enabled zone, or its
        # AI is off, or its plan lapsed, or body detection is off for it -- the
        # service cannot tell which and must not care.
        picked = zone_sim.select_cameras(LISTED, {"cam-a", "cam-z"})
        self.assertEqual(monitors_of(picked), ["cam-a"])

    def test_naming_only_unlisted_cameras_selects_nothing(self):
        picked = zone_sim.select_cameras(LISTED, {"cam-y", "cam-z"})
        self.assertEqual(picked, [])

    def test_an_empty_backend_list_cannot_be_widened_by_any_filter(self):
        # A backend blip, or a deployment where nobody has opted a camera in.
        # Either way the answer is nothing, not everything.
        for wanted in (None, set(), {"cam-a"}, {"cam-a", "cam-b", "cam-c"}):
            self.assertEqual(zone_sim.select_cameras([], wanted), [])

    def test_an_empty_filter_set_selects_nothing(self):
        # `ZONE_SIM_MONITORS=none` (or any value matching no camera) parses to a
        # non-None set, so it narrows to nothing. That is the compose default,
        # and it must not be confused with `all`.
        self.assertEqual(zone_sim.select_cameras(LISTED, {"none"}), [])
        self.assertEqual(zone_sim.select_cameras(LISTED, set()), [])

    def test_the_result_is_never_larger_than_the_backend_list(self):
        # The invariant itself, over every subset of names that could be asked
        # for -- including names that are not cameras at all.
        candidates = ["cam-a", "cam-b", "cam-c", "cam-z", "", "all"]
        for i in range(1 << len(candidates)):
            wanted = {c for j, c in enumerate(candidates) if i >> j & 1}
            picked = zone_sim.select_cameras(LISTED, wanted)
            self.assertLessEqual(len(picked), len(LISTED))
            for c in picked:
                self.assertIn(c["monitorId"], {x["monitorId"] for x in LISTED})


class SourcesOverrideTest(unittest.TestCase):
    """ZONE_SIM_SOURCES rewrites a URL. It must not be a second way in."""

    def test_an_override_replaces_the_url_of_a_LISTED_camera(self):
        picked = zone_sim.select_cameras(LISTED, {"cam-a"}, {"cam-a": "rtsp://direct/pub"})
        self.assertEqual([c["url"] for c in picked], ["rtsp://direct/pub"])

    def test_an_override_for_an_unlisted_camera_adds_nothing(self):
        # The back door, closed: a URL for a camera the product did not list is
        # a camera the product did not list.
        picked = zone_sim.select_cameras(LISTED, None, {"cam-z": "rtsp://direct/sneaky"})
        self.assertEqual(monitors_of(picked), ["cam-a", "cam-b", "cam-c"])

    def test_an_override_cannot_revive_a_camera_the_filter_dropped(self):
        picked = zone_sim.select_cameras(LISTED, {"cam-a"}, {"cam-b": "rtsp://direct/b"})
        self.assertEqual(monitors_of(picked), ["cam-a"])


class RowShapeTest(unittest.TestCase):
    def test_a_picked_camera_carries_what_a_worker_needs(self):
        [picked] = zone_sim.select_cameras([cam("cam-a")], {"cam-a"})
        self.assertEqual(picked, {
            "monitorId": "cam-a",
            "userId": "owner-1",
            "name": "CAM-A",
            # This fixture offers no sub-stream, so the main one is the
            # fallback -- and the row says which it is, for the worker to log.
            # Stream preference itself is tested in test_zone_sim.py.
            "url": "rtsp://relay/cam_cam-a",
            "stream": "main",
        })

    def test_a_camera_with_no_url_is_skipped_rather_than_opened_blind(self):
        picked = zone_sim.select_cameras([cam("cam-a", rtsp=None), cam("cam-b")], None)
        self.assertEqual(monitors_of(picked), ["cam-b"])

    def test_a_row_with_no_monitorId_is_ignored(self):
        picked = zone_sim.select_cameras([{"rtsp": "rtsp://x"}, {}, cam("cam-a")], None)
        self.assertEqual(monitors_of(picked), ["cam-a"])

    def test_a_nameless_camera_falls_back_to_its_monitor_id(self):
        [picked] = zone_sim.select_cameras([cam("cam-a", name=None)], None)
        self.assertEqual(picked["name"], "cam-a")


if __name__ == "__main__":
    unittest.main()
