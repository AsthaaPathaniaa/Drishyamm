"""Click to track (I-3): picking the clicked person, ranking proposed sightings,
and the journey made of what a person confirmed.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_journey -v
"""
from __future__ import annotations

import datetime as dt
import unittest

from vms_face.investigate import journey as j

T0 = dt.datetime(2026, 11, 24, 10, 0, tzinfo=dt.timezone.utc)


def at(s: float) -> dt.datetime:
    return T0 + dt.timedelta(seconds=s)


def cand(tid, cam, start, end, cos, top=None, person=None):
    attrs = {"top_colour": {"value": top, "conf": 0.9}} if top else {}
    return j.Candidate(track_id=tid, camera_id=cam, first_seen=at(start), last_seen=at(end), cosine=cos,
                       attributes=attrs, person_id=person)


SEED = cand("seed", "gate", 0, 20, 1.0, top="red")


class PickTest(unittest.TestCase):
    def test_click_inside_a_box_at_that_moment_picks_that_person(self):
        pts = {"a": [(at(10), [100, 200, 300, 900])], "b": [(at(10), [500, 200, 700, 900])]}
        self.assertEqual(j.pick_track_at(pts, at(10.4), 600, 500), "b")
        self.assertEqual(j.pick_track_at(pts, at(10.4), 150, 500), "a")

    def test_click_just_outside_still_picks_far_away_or_late_does_not(self):
        pts = {"a": [(at(10), [100, 200, 300, 900])]}
        self.assertEqual(j.pick_track_at(pts, at(10), 320, 500), "a")
        self.assertIsNone(j.pick_track_at(pts, at(10), 500, 500))
        self.assertIsNone(j.pick_track_at(pts, at(20), 150, 500))

    def test_smaller_box_wins_when_boxes_nest(self):
        pts = {"crowd": [(at(5), [0, 0, 1000, 1000])], "person": [(at(5), [400, 300, 500, 800])]}
        self.assertEqual(j.pick_track_at(pts, at(5), 450, 500), "person")


class RankTest(unittest.TestCase):
    def test_labels_by_score_and_drops_weak_ones(self):
        out = j.rank(SEED, [cand("l", "lobby", 60, 70, 0.95), cand("p", "park", 120, 130, 0.89),
                            cand("x", "park", 200, 210, 0.80)], {})
        self.assertEqual([(c.track_id, c.status) for c in out], [("seed", "seed"), ("l", "likely"), ("p", "possible")])

    def test_colour_evidence_moves_the_score(self):
        same = j.rank(SEED, [cand("s", "lobby", 60, 70, 0.915, top="red")], {})[1]
        diff = j.rank(SEED, [cand("d", "lobby", 60, 70, 0.915, top="blue")], {})
        self.assertEqual(same.status, "likely")
        self.assertIn("same top colour (red)", same.reasons)
        self.assertEqual(len(diff), 2)
        self.assertEqual(diff[1].status, "possible")

    def test_nobody_is_on_two_cameras_at_once(self):
        out = j.rank(SEED, [cand("twin", "lobby", 5, 15, 0.95)], {})
        self.assertEqual(out[1].status, "possible")
        self.assertIn("seen at the same time on another camera", out[1].reasons)

    def test_two_tracks_on_one_camera_at_once_are_two_people(self):
        self.assertEqual(len(j.rank(SEED, [cand("other", "gate", 10, 30, 0.99)], {})), 1)

    def test_reviews_win_over_scores(self):
        out = j.rank(SEED, [cand("weak", "lobby", 60, 70, 0.70), cand("strong", "park", 90, 99, 0.99)],
                     {"weak": "confirmed", "strong": "rejected"})
        self.assertEqual([(c.track_id, c.status) for c in out], [("seed", "seed"), ("weak", "confirmed")])

    def test_same_known_face_joins_without_a_click(self):
        seed = cand("seed", "gate", 0, 20, 1.0, person="p1")
        out = j.rank(seed, [cand("f", "lobby", 60, 70, 0.85, person="p1")], {})
        self.assertEqual(out[1].status, "same_face")


class JourneyTest(unittest.TestCase):
    def test_journey_is_seed_plus_confirmed_in_time_order_and_route_collapses_repeats(self):
        ranked = j.rank(SEED, [
            cand("c2", "park", 300, 310, 0.9), cand("c1", "lobby", 60, 70, 0.9),
            cand("c0", "gate", 40, 50, 0.9), cand("lk", "corridor", 100, 110, 0.97),
        ], {"c1": "confirmed", "c2": "confirmed", "c0": "confirmed"})
        stops = j.journey(ranked)
        self.assertEqual([c.track_id for c in stops], ["seed", "c0", "c1", "c2"])        # likely not yet confirmed
        self.assertEqual(j.route(stops, {"gate": "Gate 3", "lobby": "Lobby", "park": "Parking"}),
                         ["Gate 3", "Lobby", "Parking"])


if __name__ == "__main__":
    unittest.main()
