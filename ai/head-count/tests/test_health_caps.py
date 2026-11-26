"""GET /health reports how many cameras this service will open.

The caps lived only in config.py and in a log line: a camera past the limit was
skipped with a warning nobody reads, so the Head Count page could only say "the
detector has not started it yet" -- true, and useless to somebody who had been
waiting ten minutes. The page now reads these two numbers, says the real thing,
and warns BEFORE a ninth camera is ticked. They are a contract with the VMS,
not diagnostics.

HOW THIS RUNS ANYWHERE. `health()` is called UNBOUND, on a stand-in carrying
only the four attributes it touches. So no StreamManager is constructed, no
model file is opened and no GPU is needed -- in CI, which has ultralytics, or
on a laptop that does not. The code under test is the real `health()`; only its
`self` is substituted. A stub for `ultralytics` is installed only when the real
one is absent, so CI always imports its own.
"""
from __future__ import annotations

import sys
import time
import types
import unittest

def _stub_if_absent(name: str, **attrs) -> None:
    """Install a placeholder module only when the real one is not installed.

    CI installs ultralytics and OpenCV, so it always imports its own. On a
    machine without them the placeholders let `manager` import; nothing in
    them is ever called, because no worker and no detector is constructed.
    """
    try:                                    # pragma: no cover - CI path
        __import__(name)
        return
    except ModuleNotFoundError:             # pragma: no cover - lean machines
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        sys.modules[name] = module


_stub_if_absent("ultralytics", YOLO=object)
_stub_if_absent("cv2", CAP_PROP_BUFFERSIZE=38, VideoCapture=object)

from headcount.config import AppConfig      # noqa: E402
from headcount.manager import StreamManager  # noqa: E402


def health_for(max_streams=8, per_host=4):
    """The real `health()`, run against a stand-in `self`."""
    cfg = AppConfig(**{
        "source": {
            "enabled": True,
            "max_streams": max_streams,
            "max_streams_per_host": per_host,
        },
    })

    class Stand:
        config = cfg
        detectors = []
        _started_at = time.time()

        def all_snapshots(self):
            return []

    return StreamManager.health(Stand())


class HealthReportsCapsTest(unittest.TestCase):
    def test_health_carries_both_caps(self):
        h = health_for()
        self.assertIn("max_streams", h)
        self.assertIn("max_streams_per_host", h)
        self.assertEqual(h["max_streams"], 8)
        self.assertEqual(h["max_streams_per_host"], 4)

    def test_they_are_plain_ints_the_browser_can_compare(self):
        # The page does `counting >= max`. A STRING compares as greater than
        # every number in JavaScript, so a quoted cap would report a full
        # detector for ever and warn on every camera.
        h = health_for()
        self.assertIsInstance(h["max_streams"], int)
        self.assertIsInstance(h["max_streams_per_host"], int)

    def test_a_raised_limit_is_reported_as_raised(self):
        # The point of making it a deployment setting: HEADCOUNT_SOURCE__
        # MAX_STREAMS=16 must reach the page, or the page warns at 8 for ever.
        h = health_for(max_streams=16, per_host=8)
        self.assertEqual(h["max_streams"], 16)
        self.assertEqual(h["max_streams_per_host"], 8)

    def test_the_fields_the_page_already_used_are_untouched(self):
        h = health_for()
        for key in ("status", "uptime_seconds", "device", "streams_online",
                    "streams_total", "version"):
            self.assertIn(key, h, f"{key} disappeared from /health")


if __name__ == "__main__":
    unittest.main()
