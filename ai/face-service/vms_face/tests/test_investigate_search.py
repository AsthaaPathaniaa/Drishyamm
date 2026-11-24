"""Smart Search API: tenant scoping, chip overrides, ranking, off switch.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_search -v
"""
from __future__ import annotations

import asyncio
import datetime as dt
import unittest
import uuid
from types import SimpleNamespace

from vms_face.investigate.search import SearchFilters, assert_tenant_scoped, build_filter, query_tracks, rerank

TENANT = uuid.UUID("11111111-1111-1111-1111-111111111111")
OTHER = uuid.UUID("99999999-9999-9999-9999-999999999999")


class FakeClient:
    def __init__(self, points):
        self.points = points
        self.calls = []

    async def query_points(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(points=self.points)


def hit(i, cos, **payload):
    return SimpleNamespace(id=f"00000000-0000-0000-0000-00000000000{i}", score=cos,
                           payload={"tenant_id": str(TENANT), "camera_id": "c1", "first_seen_ts": 1_800_000_000, **payload})


class TenantScopeTest(unittest.TestCase):
    def test_every_track_query_carries_the_callers_tenant(self):
        client = FakeClient([hit(1, 0.3)])
        asyncio.run(query_tracks(client, "vms_tracks", tenant_id=TENANT, vector=[0.0] * 4,
                                 filters=SearchFilters(camera_ids=["c1"]), limit=10))
        must = client.calls[0]["query_filter"].must
        self.assertEqual((must[0].key, must[0].match.value), ("tenant_id", str(TENANT)))

    def test_a_filter_for_another_tenant_is_refused(self):
        with self.assertRaises(ValueError):
            assert_tenant_scoped(build_filter(OTHER, SearchFilters()), TENANT)

    def test_every_investigate_route_takes_the_tenant_from_the_jwt(self):
        from vms_face.api.deps import current_tenant_id
        from vms_face.api.routes.investigate import router

        def deps(d):
            for sub in d.dependencies:
                yield sub.call
                yield from deps(sub)

        for route in router.routes:
            self.assertIn(current_tenant_id, list(deps(route.dependant)), route.path)


class RankingTest(unittest.TestCase):
    def test_colour_chip_is_a_soft_boost(self):
        hits = [
            {"id": "a", "cosine": 0.20, "payload": {"attr_top_colour": "blue"}},
            {"id": "b", "cosine": 0.19, "payload": {"attr_top_colour": "red"}},
            {"id": "c", "cosine": 0.18, "payload": {}},
        ]
        out = rerank(hits, SearchFilters(top_colour="red"), to_score=lambda c: c, top_k=10)
        self.assertEqual([r["id"] for r in out], ["b", "c", "a"])
        self.assertEqual(out[0]["boosts"], ["top_colour=red"])
        self.assertEqual(len(out), 3)            # a mismatch is ranked down, not removed

    def test_ir_tracks_are_not_judged_on_colour(self):
        hits = [{"id": "a", "cosine": 0.2, "payload": {"ir": True}}]
        self.assertEqual(rerank(hits, SearchFilters(top_colour="red"), to_score=lambda c: c, top_k=1)[0]["score"], 0.2)


class RelevanceTest(unittest.TestCase):
    def test_scale_maps_measured_range_to_0_1(self):
        from vms_face.investigate.search import text_relevance

        self.assertEqual(text_relevance(0.03), 0.0)
        self.assertAlmostEqual(text_relevance(0.105), 0.5)
        self.assertEqual(text_relevance(0.3), 1.0)


class OverridesTest(unittest.TestCase):
    def setUp(self):
        from vms_face.api.routes import investigate as r
        from vms_face.investigate.query_parser import parse

        self.r = r
        self.parsed = parse("red top gate 3 1-4 pm", now=dt.datetime(2026, 11, 24, 18, tzinfo=dt.timezone.utc),
                            cameras=[("cid-3", "m3", "Gate 3")])

    def test_parse_becomes_filters(self):
        f = self.r._filters(self.parsed, self.r.Overrides(), {"m3": "cid-3"})
        self.assertEqual((f.camera_ids, f.object_classes, f.top_colour), (["cid-3"], ["person"], "red"))
        self.assertIsNotNone(f.since)

    def test_removed_and_edited_chips_win(self):
        ov = self.r.Overrides(clear=["time", "top_colour"], camera_codes=["m4"])
        f = self.r._filters(self.parsed, ov, {"m3": "cid-3", "m4": "cid-4"})
        self.assertEqual((f.since, f.top_colour, f.camera_ids), (None, None, ["cid-4"]))

    def test_scope_limits_results_to_the_callers_cameras(self):
        ids = {"m3": "cid-3", "m4": "cid-4"}
        f = self.r._filters(self.parsed, self.r.Overrides(), ids, scope_codes=["m4"])
        self.assertEqual(f.camera_ids, [self.r.NO_CAMERA])          # asked for gate 3, may only see m4
        f = self.r._filters(None, self.r.Overrides(), ids, scope_codes=["m4"])
        self.assertEqual(f.camera_ids, ["cid-4"])                    # no camera asked: all of theirs

    def test_cameras_of_another_tenant_match_nothing(self):
        f = self.r._filters(None, self.r.Overrides(camera_codes=["not-mine"]), {"m3": "cid-3"})
        self.assertEqual(f.camera_ids, ["00000000-0000-0000-0000-000000000000"])


class OffSwitchTest(unittest.TestCase):
    def test_search_is_404_while_the_index_is_off(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from vms_face.api import deps
        from vms_face.api.routes import investigate as r
        from vms_face.config import settings

        app = FastAPI()
        app.include_router(r.router)

        async def no_db():
            yield None

        app.dependency_overrides[deps.current_tenant_id] = lambda: TENANT
        app.dependency_overrides[deps.operator_id] = lambda: "tester"
        app.dependency_overrides[deps.db_session] = no_db
        old = settings.investigate_index_enabled
        settings.investigate_index_enabled = False
        try:
            c = TestClient(app)
            self.assertEqual(c.post("/investigate/search", json={"q": "red top"}).status_code, 404)
            self.assertEqual(c.get(f"/investigate/tracks/{uuid.uuid4()}").status_code, 404)
            self.assertEqual(c.get("/investigate/status").json()["enabled"], False)
        finally:
            settings.investigate_index_enabled = old


if __name__ == "__main__":
    unittest.main()
