"""Smart Search, second pass: what users actually type, and honest results.

Reported on the testing server (2026-11-25):
  * "man" returned women too            → gender is a wish, applied only where the
                                           account allows it, confident readings only;
  * "red top" returned other colours    → asked-for colours are filters now;
  * "movement at gate 2" ignored gate 2 → cameras the AI doesn't watch can still be
                                           named (and are reported), "gate no. 2",
                                           "गेट 2", part of a longer name all match;
                                           an unknown place is reported, never searched
                                           blind; "movement" lists everyone, newest first.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_smart_search_v2 -v
"""
from __future__ import annotations

import asyncio
import datetime as dt
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

import numpy as np

from vms_face.investigate import query_parser as qp
from vms_face.investigate.search import (
    GENDER_SURE, SearchFilters, browse_tracks, build_filter, count_unknown_colour, gender_filter, rerank,
)

NOW = dt.datetime(2026, 11, 25, 10, 0, tzinfo=dt.timezone.utc)
TENANT = uuid.UUID("11111111-1111-1111-1111-111111111111")
CAMS = [
    ("c-ws", "m-ws", "Camera WorkStation"), ("c-ws2", "m-ws2", "Camera WorkStation 2"),
    ("c-ws1", "m-ws1", "Camera WORKSTATION 1"), ("c-g2", "m-g2", "Camera Gate2"),
    ("c-main", "m-main", "Main Gate 3 Entry"), ("c-rec", "m-rec", "Reception Cam 01"),
    ("c-in", "m-in", "Gate 5 In"), ("c-out", "m-out", "Gate 5 Out"),
]


def p(q, cameras=CAMS):
    return qp.parse(q, now=NOW, tz="Asia/Kolkata", cameras=cameras)


# ── the parser ───────────────────────────────────────────────────────────────

class GenderWordsTest(unittest.TestCase):
    def test_man_and_woman_words_set_a_gender_wish_and_a_chip(self):
        for q, g in [("man", "male"), ("guy in a cap", "male"), ("two boys", "male"), ("gents", "male"),
                     ("woman", "female"), ("lady in pink", "female"), ("girls near the door", "female"),
                     ("आदमी", "male"), ("लाल शर्ट वाला लड़का", "male"), ("औरत", "female"), ("महिला", "female")]:
            r = p(q)
            self.assertEqual(r.gender, g, q)
            self.assertEqual(r.object_class, "person", q)
            self.assertIn(("gender", g), [(c.kind, c.value) for c in r.chips], q)

    def test_no_gender_word_no_gender(self):
        for q in ["person in red", "someone with a backpack", "red top", "people at gate 2", "movement"]:
            self.assertIsNone(p(q).gender, q)

    def test_the_first_gender_word_wins(self):
        self.assertEqual(p("man talking to a woman").gender, "male")


class BrowseTest(unittest.TestCase):
    def test_activity_words_mean_everyone_newest_first(self):
        for q in ["movement", "movement at gate 2", "any activity", "anyone", "who came", "people",
                  "visitors today", "हलचल", "कोई आया"]:
            self.assertTrue(p(q).browse, q)

    def test_movement_alone_keeps_people_and_vehicles(self):
        self.assertIsNone(p("movement at gate 2").object_class)
        self.assertEqual(p("people at gate 2").object_class, "person")

    def test_anything_that_describes_someone_is_a_real_search(self):
        for q in ["red top", "man", "person with a backpack", "white car", "movement of a man in black"]:
            self.assertFalse(p(q).browse, q)

    def test_colour_only_queries_are_phrased_as_a_person_wearing_it(self):
        self.assertEqual(p("red top").text, "a photo of a person wearing a red top")
        self.assertEqual(p("black jacket").text, "a photo of a person wearing a black jacket")
        self.assertIn("man", p("man in red top").text)            # their own words kept when they name someone


class CameraNamesTest(unittest.TestCase):
    def test_the_reported_query_finds_the_gate2_camera(self):
        r = p("movement at gate 2")
        self.assertEqual(r.camera_ids, ["c-g2"])
        self.assertEqual(r.unknown_places, [])

    def test_numbering_styles(self):
        for q in ["gate no. 2", "gate number 2", "gate #2", "gate-02", "Gate2", "GATE 2", "गेट 2"]:
            self.assertEqual(p(f"anyone at {q}").camera_ids, ["c-g2"], q)

    def test_part_of_a_longer_name(self):
        self.assertEqual(p("anyone at gate 3").camera_ids, ["c-main"])

    def test_one_phrase_can_name_several_cameras(self):
        self.assertEqual(sorted(p("movement at gate 5").camera_ids), ["c-in", "c-out"])

    def test_an_exact_name_wins_over_cameras_that_merely_contain_the_word(self):
        self.assertEqual(p("anyone at workstation").camera_ids, ["c-ws"])

    def test_a_word_no_camera_is_named_exactly_names_every_camera_that_has_it(self):
        cams = [("a", "ma", "Workstation 1"), ("b", "mb", "Workstation 2"), ("c", "mc", "Lobby")]
        self.assertEqual(sorted(p("anyone at the workstation", cameras=cams).camera_ids), ["a", "b"])

    def test_a_number_after_a_word_means_that_number_only(self):
        self.assertEqual(p("anyone at workstation 2").camera_ids, ["c-ws2"])
        self.assertEqual(p("movement at gate 7").camera_ids, [])          # not "every gate"

    def test_single_distinctive_word_with_a_preposition(self):
        self.assertEqual(p("woman at reception").camera_ids, ["c-rec"])

    def test_camera_words_never_reach_the_description(self):
        for q in ["red top at gate 2", "man near workstation 2", "anyone at gate 7"]:
            self.assertNotRegex(p(q).text.lower(), r"gate|workstation|\b7\b|\b2\b", q)


class UnknownPlacesTest(unittest.TestCase):
    def test_a_numbered_place_with_no_camera_is_reported_with_suggestions(self):
        r = p("movement at gate 7")
        self.assertEqual(r.unknown_places, ["gate 7"])
        self.assertIn("Camera Gate2", r.suggestions["gate 7"])
        self.assertNotIn("gate", r.text.lower())

    def test_a_named_place_with_no_camera(self):
        r = p("man at the parking")
        self.assertEqual(r.unknown_places, ["parking"])
        self.assertEqual(r.camera_ids, [])

    def test_known_places_are_not_reported(self):
        for q in ["movement at gate 2", "anyone at gate no 3", "woman at reception"]:
            self.assertEqual(p(q).unknown_places, [], q)

    def test_no_cameras_at_all_reports_the_place(self):
        self.assertEqual(p("anyone at gate 2", cameras=[]).unknown_places, ["gate 2"])

    def test_plain_descriptions_have_no_places(self):
        for q in ["red top", "man with a backpack", "woman in yellow kurta yesterday 2-4 pm", "white car"]:
            self.assertEqual(p(q).unknown_places, [], q)

    def test_to_dict_carries_the_new_fields(self):
        d = p("man at gate 7").to_dict()
        for k in ("gender", "browse", "unknown_places", "suggestions"):
            self.assertIn(k, d)


# ── search ───────────────────────────────────────────────────────────────────

def keys(flt):
    out = []
    for c in flt.must:
        if hasattr(c, "key"):
            out.append((c.key, getattr(getattr(c, "match", None), "value", None)))
        else:
            out.append(("nested", tuple(getattr(s, "key", None) for s in c.should)))
    return out


class ColourFilterTest(unittest.TestCase):
    def test_asked_colours_are_hard_filters(self):
        f = build_filter(TENANT, SearchFilters(top_colour="red", bottom_colour="Blue"))
        self.assertIn(("attr_top_colour", "red"), keys(f))
        self.assertIn(("attr_bottom_colour", "blue"), keys(f))
        self.assertEqual(keys(f)[0], ("tenant_id", str(TENANT)))

    def test_vehicle_type_and_colour_too(self):
        f = build_filter(TENANT, SearchFilters(object_classes=["vehicle"], vehicle_type="car", vehicle_colour="white"))
        self.assertIn(("attr_vehicle_type", "car"), keys(f))
        self.assertIn(("attr_vehicle_colour", "white"), keys(f))

    def test_show_unread_colours_accepts_a_missing_colour_but_never_another_one(self):
        f = build_filter(TENANT, SearchFilters(top_colour="red", include_unknown_colour=True))
        nested = [c for c in f.must if not hasattr(c, "key")]
        self.assertEqual(len(nested), 1)
        exact, empty = nested[0].should
        self.assertEqual((exact.key, exact.match.value), ("attr_top_colour", "red"))
        self.assertEqual(empty.is_empty.key, "attr_top_colour")

    def test_no_chips_no_attribute_conditions(self):
        self.assertEqual([k for k in keys(build_filter(TENANT, SearchFilters())) if k[0].startswith("attr_")], [])

    def test_unread_count_is_the_difference_of_two_tenant_scoped_counts(self):
        class C:
            def __init__(self):
                self.filters = []

            async def count(self, collection_name, count_filter, exact):
                self.filters.append(count_filter)
                return SimpleNamespace(count=30 if len(self.filters) == 1 else 4)
        c = C()
        n = asyncio.run(count_unknown_colour(c, "vms_tracks", tenant_id=TENANT, filters=SearchFilters(top_colour="red")))
        self.assertEqual(n, 26)
        for flt in c.filters:
            self.assertEqual(keys(flt)[0], ("tenant_id", str(TENANT)))

    def test_no_count_without_a_colour_chip_or_when_already_showing_them(self):
        class Boom:
            async def count(self, **kw):
                raise AssertionError("should not count")
        for f in (SearchFilters(), SearchFilters(top_colour="red", include_unknown_colour=True)):
            self.assertEqual(asyncio.run(count_unknown_colour(Boom(), "v", tenant_id=TENANT, filters=f)), 0)


class GenderFilterTest(unittest.TestCase):
    # Two text vectors (man, woman) and image vectors built to give a chosen p(man).
    TV = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)

    def hit(self, pm, i=0):
        d = np.log(pm / (1 - pm))                    # logit difference at scale 1
        return {"id": f"t{i}", "cosine": 0.2, "payload": {}, "vector": [d, 0.0]}

    def test_only_confident_readings_are_kept(self):
        hits = [self.hit(0.95, 1), self.hit(0.85, 2), self.hit(0.6, 3), self.hit(0.3, 4), self.hit(0.05, 5)]
        men, unsure = gender_filter(hits, "male", self.TV, 1.0)
        self.assertEqual([h["id"] for h in men], ["t1", "t2"])
        self.assertEqual(unsure, 2)                       # 0.6 and 0.3; the 0.05 is a woman, not unsure
        women, unsure_w = gender_filter(hits, "female", self.TV, 1.0)
        self.assertEqual([h["id"] for h in women], ["t5"])
        self.assertEqual(unsure_w, 2)

    def test_threshold_is_the_documented_one(self):
        self.assertEqual(GENDER_SURE, 0.8)
        men, _ = gender_filter([self.hit(0.79), self.hit(0.81, 1)], "male", self.TV, 1.0)
        self.assertEqual([h["id"] for h in men], ["t1"])

    def test_order_is_kept_and_empty_is_fine(self):
        hits = [self.hit(0.9, i) for i in range(5)]
        self.assertEqual([h["id"] for h in gender_filter(hits, "male", self.TV, 1.0)[0]], [f"t{i}" for i in range(5)])
        self.assertEqual(gender_filter([], "male", self.TV, 1.0), ([], 0))


class RankingTest(unittest.TestCase):
    def test_unrelated_results_are_dropped(self):
        hits = [{"id": "a", "cosine": 0.3, "payload": {}}, {"id": "b", "cosine": 0.0, "payload": {}}]
        out = rerank(hits, SearchFilters(), to_score=lambda c: max(0.0, c - 0.05), top_k=10)
        self.assertEqual([h["id"] for h in out], ["a"])

    def test_browse_hits_keep_their_order_and_have_no_score(self):
        hits = [{"id": i, "cosine": None, "payload": {}} for i in "cba"]
        out = rerank(hits, SearchFilters(), to_score=lambda c: c, top_k=2)
        self.assertEqual([(h["id"], h["score"]) for h in out], [("c", None), ("b", None)])

    def test_browse_lists_newest_first_under_the_same_filters(self):
        class C:
            async def scroll(self, **kw):
                self.kw = kw
                return [SimpleNamespace(id="x", payload={"first_seen_ts": 1}, vector=None)], None
        c = C()
        out = asyncio.run(browse_tracks(c, "vms_tracks", tenant_id=TENANT, filters=SearchFilters(camera_ids=["c1"]), limit=5))
        self.assertEqual(out[0]["cosine"], None)
        self.assertEqual((c.kw["order_by"].key, c.kw["order_by"].direction), ("first_seen_ts", "desc"))
        self.assertEqual(keys(c.kw["scroll_filter"])[0], ("tenant_id", str(TENANT)))
        self.assertIn(("camera_id", None), [(k, None) for k, _ in keys(c.kw["scroll_filter"])])


class UpperBodyColourTest(unittest.TestCase):
    def test_upper_body_is_shoulders_to_waist(self):
        from vms_face.investigate.indexer import upper_body
        crop = np.arange(100 * 10 * 3, dtype=np.uint8).reshape(100, 10, 3)
        self.assertEqual(upper_body(crop).shape[:2], (40, 10))
        self.assertTrue(np.array_equal(upper_body(crop), crop[15:55]))
        self.assertEqual(upper_body(np.zeros((3, 2, 3), np.uint8)).shape[0], 1)     # tiny crops never empty

    def test_top_colour_comes_from_the_upper_body_when_given(self):
        from vms_face.investigate.indexer import colour_attributes

        class E:
            def __init__(self):
                self.seen = []

            def classify(self, vecs, labels, template):
                self.seen.append((template, np.asarray(vecs).tolist()))
                return [("red", 0.9)] * len(vecs)
        e = E()
        full, lower, upper = np.ones((1, 2)), np.zeros((1, 2)), np.full((1, 2), 7.0)
        colour_attributes(e, full, lower, [False], upper_vecs=upper)
        top_calls = [v for t, v in e.seen if "top" in t]
        self.assertEqual(top_calls, [[[7.0, 7.0]]])

    def test_without_upper_vectors_the_old_behaviour_stays(self):
        from vms_face.investigate.indexer import colour_attributes

        class E:
            def classify(self, vecs, labels, template):
                self.last = np.asarray(vecs).tolist()
                return [("blue", 0.9)] * len(vecs)
        e = E()
        out = colour_attributes(e, np.ones((1, 2)), np.zeros((1, 2)), [False])
        self.assertEqual(out[0]["top_colour"]["value"], "blue")
        self.assertEqual(colour_attributes(e, np.ones((1, 2)), np.zeros((1, 2)), [True], upper_vecs=np.ones((1, 2))), [{}])


# ── the route: never search blind, gender only where allowed ────────────────

class FakeEmbedder:
    model_tag = "fake@0"
    _scale = 1.0

    def embed_texts(self, texts):
        return np.array([[1.0, 0.0] if "woman" not in t else [0.0, 1.0] for t in texts], dtype=np.float32)


class FakeQdrant:
    def __init__(self, points):
        self.points = points
        self.calls = []

    async def query_points(self, **kw):
        self.calls.append(("query", kw))
        return SimpleNamespace(points=self.points)

    async def scroll(self, **kw):
        self.calls.append(("scroll", kw))
        return self.points, None

    async def count(self, **kw):
        self.calls.append(("count", kw))
        return SimpleNamespace(count=0)


class FakeSession:
    def __init__(self, rows):
        self.rows = rows

    async def execute(self, _stmt):
        return SimpleNamespace(all=lambda: self.rows)


def point(i, pm=0.95):
    d = float(np.log(pm / (1 - pm)))
    return SimpleNamespace(id=str(uuid.UUID(int=i)), score=0.15, vector=[d, 0.0],
                           payload={"tenant_id": str(TENANT), "camera_id": "ai-g2", "first_seen_ts": 1_800_000_000 + i,
                                    "object_class": "person"})


class RouteTest(unittest.TestCase):
    def run_search(self, q, *, points=(), allow_gender=False, overrides=None, cameras=None):
        from vms_face.api.routes import investigate as r
        from vms_face.investigate import embedder as emb

        client = FakeQdrant(list(points))
        store = SimpleNamespace(client=client, collection="vms_tracks")
        cams = cameras if cameras is not None else [r.CameraHint(code="m-g2", name="Camera Gate2"),
                                                     r.CameraHint(code="m-g1", name="Camera Gate1")]
        body = r.SearchRequest(q=q, cameras=cams, scope_codes=[c.code for c in cams], allow_gender=allow_gender,
                               overrides=r.Overrides(**(overrides or {})))
        session = FakeSession([("ai-g2", "m-g2")])             # only Gate2 is watched by the AI
        with mock.patch.object(r.settings, "investigate_index_enabled", True), \
                mock.patch.object(r, "get_qdrant_tracks", return_value=store), \
                mock.patch.object(emb.SiglipEmbedder, "shared", return_value=FakeEmbedder()), \
                mock.patch.object(r.audit_log, "record", mock.AsyncMock()):
            out = asyncio.run(r.search(body, session=session, actor="u1", tenant_id=TENANT))
        return out, client

    def test_unknown_place_searches_nothing_and_suggests(self):
        out, client = self.run_search("movement at gate 7")
        self.assertEqual(out["results"], [])
        self.assertEqual(client.calls, [])
        n = out["notices"][0]
        self.assertEqual((n["kind"], n["place"]), ("unknown_place", "gate 7"))
        self.assertIn({"name": "Camera Gate2", "code": "m-g2"}, n["suggestions"])

    def test_a_camera_without_ai_is_named_not_searched_around(self):
        out, client = self.run_search("movement at gate 1")
        self.assertEqual(out["results"], [])
        self.assertEqual(client.calls, [])
        self.assertEqual(out["notices"][0]["kind"], "camera_not_indexed")
        self.assertIn("Camera Gate1", out["notices"][0]["message"])

    def test_picking_a_camera_by_hand_runs_the_search(self):
        out, client = self.run_search("movement at gate 7", points=[point(1)], overrides={"camera_codes": ["m-g2"]})
        self.assertEqual(len(out["results"]), 1)
        self.assertTrue(client.calls)

    def test_movement_browses_newest_first_without_scores(self):
        out, client = self.run_search("movement at gate 2", points=[point(2), point(1)])
        self.assertEqual(client.calls[0][0], "scroll")
        self.assertEqual([r["score"] for r in out["results"]], [None, None])
        self.assertTrue(out["parsed"]["browse"])
        self.assertEqual(out["notices"][0]["kind"], "browse")

    def test_gender_is_not_applied_without_the_account_switch(self):
        out, client = self.run_search("man", points=[point(1, 0.95), point(2, 0.05)], allow_gender=False)
        self.assertEqual(len(out["results"]), 2)
        self.assertEqual(out["notices"][0]["kind"], "gender_off")
        self.assertFalse(client.calls[0][1]["with_vectors"])            # vectors not even fetched

    def test_gender_is_applied_with_the_account_switch(self):
        out, _ = self.run_search("man", points=[point(1, 0.95), point(2, 0.05), point(3, 0.5)], allow_gender=True)
        self.assertEqual([r["track_id"] for r in out["results"]], [str(uuid.UUID(int=1))])
        self.assertEqual([n["kind"] for n in out["notices"]], ["gender_unsure"])

    def test_removing_the_gender_chip_turns_it_off(self):
        out, _ = self.run_search("man", points=[point(1, 0.95), point(2, 0.05)], allow_gender=True,
                                 overrides={"clear": ["gender"]})
        self.assertEqual(len(out["results"]), 2)

    def test_only_man_or_woman_is_accepted_as_a_gender_chip(self):
        from vms_face.api.routes.investigate import Overrides
        with self.assertRaises(Exception):
            Overrides(gender="other")


if __name__ == "__main__":
    unittest.main()
