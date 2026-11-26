"""Associations (phase 4): who was with whom, from 1 pt/s box trails.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_associations -v
"""
from __future__ import annotations

import datetime as dt
import unittest

from vms_face.investigate import associations as a

T0 = dt.datetime(2026, 11, 24, 10, 0, tzinfo=dt.timezone.utc)


def trail(start_s, secs, x0, dx=10, y=300, h=300, w=100, offset=0.3):
    return [(T0 + dt.timedelta(seconds=start_s + i + offset), [x0 + i * dx, y, x0 + i * dx + w, y + h]) for i in range(secs)]


class TogetherTest(unittest.TestCase):
    def test_walking_side_by_side_counts_every_second(self):
        seed = trail(0, 20, 100, offset=0.0)
        friend = trail(0, 20, 220)                      # 120 grid units apart, boxes 300 tall: 0.4 heights
        secs, first, last, closest = a.together(seed, friend)
        self.assertEqual(secs, 20)
        self.assertAlmostEqual(closest, 0.4, places=2)

    def test_far_apart_or_different_times_is_not_together(self):
        seed = trail(0, 20, 100, offset=0.0)
        self.assertEqual(a.together(seed, trail(0, 20, 800))[0], 0.0)     # other side of the frame
        self.assertEqual(a.together(seed, trail(60, 20, 120))[0], 0.0)    # same place, a minute later

    def test_short_gaps_merge_long_gaps_split(self):
        seed = trail(0, 40, 100, dx=0, offset=0.0)
        other = trail(0, 10, 150, dx=0) + trail(13, 10, 150, dx=0) + trail(35, 5, 150, dx=0)
        secs, *_ = a.together(seed, other)
        self.assertEqual(secs, 23 + 5)                  # 0-22 as one stretch (3 s gap), 35-39 separately

    def test_companions_need_a_few_seconds_and_sort_longest_first(self):
        seed = trail(0, 30, 100, dx=0, offset=0.0)
        out = a.companions(seed, {
            "long": trail(0, 25, 180, dx=0), "brief": trail(0, 2, 180, dx=0), "short": trail(10, 6, 160, dx=0),
            "stranger": trail(0, 30, 900, dx=0),
        })
        self.assertEqual([c.track_id for c in out], ["long", "short"])
        self.assertEqual(out[0].seconds, 25)



class SynopsisPlanTest(unittest.TestCase):
    def test_speed_keeps_the_reel_near_three_minutes(self):
        from vms_face.investigate import synopsis as sy

        T = lambda s: T0 + dt.timedelta(seconds=s)   # noqa: E731
        # 8 hours, 20 min of activity in 10 stretches of 2 min → 1200 s busy → 7× → about 171 s of reel.
        segs = [(T(i * 2880), T(i * 2880 + 120)) for i in range(10)]
        p = sy.plan(segs, T0, T(8 * 3600))
        self.assertEqual((len(p.pieces), p.busy_s, p.speed), (10, 1200.0, 7.0))
        self.assertLessEqual(p.out_s, 180)
        quiet = sy.plan([(T(0), T(20))], T0, T(3600))
        self.assertEqual(quiet.speed, 2.0)                  # never slower than 2×
        busy = sy.plan([(T(0), T(7200))], T0, T(7200))
        self.assertEqual(busy.speed, 16.0)                  # never faster than 16×
        clipped = sy.plan([(T(-50), T(30)), (T(3590), T(3700))], T0, T(3600))
        self.assertEqual([(a - T0).total_seconds() for a, _ in clipped.pieces], [0.0, 3590.0])


if __name__ == "__main__":
    unittest.main()
