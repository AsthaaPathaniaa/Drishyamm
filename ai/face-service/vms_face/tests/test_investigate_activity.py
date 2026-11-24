"""Smart Skim (I-6): density bins and busy segments from track spans.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_activity -v
"""
from __future__ import annotations

import datetime as dt
import unittest

from vms_face.investigate import activity as a

T0 = dt.datetime(2026, 11, 24, 10, 0, tzinfo=dt.timezone.utc)


def t(s: float) -> dt.datetime:
    return T0 + dt.timedelta(seconds=s)


class BinsTest(unittest.TestCase):
    def test_a_person_counts_in_every_bin_they_are_on_screen(self):
        out = a.bins([(t(5), t(25)), (t(12), t(14))], T0, t(40), 10)
        self.assertEqual(out, [1, 2, 1, 0])

    def test_spans_outside_the_window_are_ignored_and_edges_clamped(self):
        self.assertEqual(a.bins([(t(-100), t(-50)), (t(-5), t(3))], T0, t(20), 10), [1, 0])

    def test_bin_width_caps_the_number_of_bins(self):
        self.assertEqual(a.bin_seconds(T0, t(86400), 1), 86400 / a.MAX_BINS)
        self.assertEqual(a.bin_seconds(T0, t(60), 5), 5)


class SegmentsTest(unittest.TestCase):
    def test_close_passes_merge_and_far_ones_do_not(self):
        segs = a.segments([(t(10), t(20)), (t(25), t(30)), (t(100), t(110))], pad_s=2, merge_gap_s=5)
        self.assertEqual(segs, [(t(8), t(32)), (t(98), t(112))])

    def test_segments_are_clamped_to_the_window(self):
        self.assertEqual(a.segments([(t(-10), t(5))], pad_s=0, since=T0, until=t(60)), [(T0, t(5))])

    def test_nothing_on_screen_means_nothing_to_play(self):
        self.assertEqual(a.segments([]), [])


if __name__ == "__main__":
    unittest.main()
