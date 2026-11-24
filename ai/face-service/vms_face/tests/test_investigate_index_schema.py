"""I-1 search index shapes: tenant-scoped filters, IR / sensitive attribute
rules, crop keys, box grid, and the vms_tracks collection settings.

Run inside the ai container (no GPU, no Qdrant, no Postgres needed):

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_index_schema -v
"""
from __future__ import annotations

import datetime as dt
import unittest
import uuid

from vms_face.investigate import index_schema as ix

TENANT = uuid.UUID("11111111-1111-1111-1111-111111111111")
CAMERA = uuid.UUID("22222222-2222-2222-2222-222222222222")
T0 = dt.datetime(2026, 11, 24, 18, 45, 30, 500000, tzinfo=dt.timezone(dt.timedelta(hours=5, minutes=30)))


def keys(flt):
    return [c.key for c in flt.must]


class TrackFilterTest(unittest.TestCase):
    def test_every_filter_is_scoped_to_the_tenant(self):
        flt = ix.track_filter(TENANT)
        self.assertEqual(keys(flt), ["tenant_id"])
        self.assertEqual(flt.must[0].match.value, str(TENANT))

    def test_no_tenant_no_filter(self):
        for missing in (None, ""):
            with self.assertRaises(ValueError):
                ix.track_filter(missing)

    def test_filters_combine_with_the_tenant(self):
        flt = ix.track_filter(
            TENANT, camera_ids=[CAMERA], object_classes=["person"],
            since=T0, until=T0 + dt.timedelta(hours=3),
            attributes={"top_colour": "Red", "bag": ["backpack", "handbag"]},
        )
        self.assertEqual(keys(flt), ["tenant_id", "camera_id", "object_class", "first_seen_ts", "attr_top_colour", "attr_bag"])
        self.assertEqual(flt.must[3].range.gte, int(T0.timestamp()))
        self.assertEqual(flt.must[4].match.any, ["red"])

    def test_unknown_attribute_or_class_is_refused(self):
        with self.assertRaises(ValueError):
            ix.track_filter(TENANT, attributes={"suspicious": "yes"})
        with self.assertRaises(ValueError):
            ix.track_filter(TENANT, object_classes=["dog"])


class AttributeRulesTest(unittest.TestCase):
    ATTRS = {
        "top_colour": {"value": "Red", "conf": 0.9},
        "bag": {"value": "backpack", "conf": 0.7},
        "gender": {"value": "male", "conf": 0.95},
        "emotion": {"value": "angry", "conf": 0.99},
        "bottom_colour": {"value": "blue", "conf": 0.3},
    }

    def test_ir_tracks_carry_no_colour(self):
        out = ix.clean_attributes(self.ATTRS, ir=True)
        self.assertEqual(set(out), {"bag"})

    def test_sensitive_only_when_the_tenant_opted_in(self):
        self.assertNotIn("gender", ix.clean_attributes(self.ATTRS, ir=False))
        self.assertIn("gender", ix.clean_attributes(self.ATTRS, ir=False, allow_sensitive=True))

    def test_unknown_attributes_never_stored(self):
        self.assertNotIn("emotion", ix.clean_attributes(self.ATTRS, ir=False, allow_sensitive=True))

    def test_payload_keeps_only_confident_attributes(self):
        p = ix.track_payload(tenant_id=TENANT, camera_id=CAMERA, object_class="person",
                             first_seen=T0, last_seen=T0 + dt.timedelta(seconds=8), attributes=self.ATTRS)
        self.assertEqual(p["tenant_id"], str(TENANT))
        self.assertEqual(p["attr_top_colour"], "red")
        self.assertEqual(p["attr_bag"], "backpack")
        self.assertNotIn("attr_bottom_colour", p)     # conf 0.3: kept in Postgres, not a hard filter
        self.assertNotIn("attr_gender", p)
        self.assertEqual(p["first_seen_ts"], int(T0.timestamp()))
        self.assertFalse(p["ir"])

    def test_payload_needs_a_tenant(self):
        with self.assertRaises(ValueError):
            ix.track_payload(tenant_id="", camera_id=CAMERA, object_class="person", first_seen=T0, last_seen=T0)


class ShapesTest(unittest.TestCase):
    def test_crop_key_is_tenant_prefixed_and_dated_in_utc(self):
        track = uuid.UUID("33333333-3333-3333-3333-333333333333")
        self.assertEqual(ix.crop_key(TENANT, track, T0), f"{TENANT}/tracks/2026-11-24/{track}.jpg")
        late = dt.datetime(2026, 11, 25, 2, 0, tzinfo=dt.timezone(dt.timedelta(hours=5, minutes=30)))
        self.assertIn("/2026-11-24/", ix.crop_key(TENANT, track, late))

    def test_naive_timestamps_are_refused(self):
        with self.assertRaises(ValueError):
            ix.crop_key(TENANT, TENANT, dt.datetime(2026, 11, 24))

    def test_bbox_grid_is_resolution_independent_and_clamped(self):
        self.assertEqual(ix.bbox_to_grid((960, 270, 1920, 1080), 1920, 1080), [500, 250, 1000, 1000])
        self.assertEqual(ix.bbox_to_grid((-10, 5, 2000, 540), 1920, 1080), [0, 5, 1000, 500])

    def test_minute_floor(self):
        self.assertEqual(ix.minute_floor(T0), dt.datetime(2026, 11, 24, 13, 15, tzinfo=dt.timezone.utc))

    def test_every_attribute_is_indexed_in_qdrant(self):
        indexed = {name for name, _ in ix.TRACKS_PAYLOAD_INDEXES}
        self.assertTrue({f"attr_{a}" for a in ix.ATTRIBUTES} <= indexed)
        self.assertIn("tenant_id", indexed)


class CollectionSettingsTest(unittest.TestCase):
    def test_tracks_collection_has_its_own_shape_and_face_collections_keep_theirs(self):
        from vms_face.config import settings
        from vms_face.infra import qdrant

        qdrant._stores.clear()
        try:
            tracks = qdrant.get_qdrant_tracks()
            self.assertEqual(tracks.collection, settings.qdrant_collection_tracks)
            self.assertEqual(tracks._vector_size, settings.investigate_embed_dim)
            self.assertTrue(tracks._quantize_int8)
            self.assertEqual(tracks._payload_indexes, ix.TRACKS_PAYLOAD_INDEXES)

            appearance = qdrant.get_qdrant_appearance()
            self.assertEqual(appearance._vector_size, settings.qdrant_vector_size)
            self.assertFalse(appearance._quantize_int8)
            self.assertEqual(appearance._payload_indexes, qdrant.QdrantStore.DEFAULT_PAYLOAD_INDEXES)
        finally:
            qdrant._stores.clear()

    def test_index_is_off_by_default(self):
        from vms_face.config.settings import Settings

        self.assertFalse(Settings.model_fields["investigate_index_enabled"].default)


class OrmMatchesMigrationTest(unittest.TestCase):
    def test_orm_tables_exist_with_the_migration_columns(self):
        from vms_face.domain.models import ActivityBucket, Track, TrackPoint

        cols = set(Track.__table__.columns.keys())
        for c in ("tenant_id", "camera_id", "source", "case_id", "tracker_id", "object_class", "first_seen",
                  "last_seen", "best_crop_key", "attributes", "ir", "model_info", "appearance_id", "body_vector_id"):
            self.assertIn(c, cols)
        self.assertEqual([c.name for c in TrackPoint.__table__.primary_key], ["track_id", "ts"])
        self.assertEqual([c.name for c in ActivityBucket.__table__.primary_key], ["camera_id", "minute", "object_class"])


if __name__ == "__main__":
    unittest.main()
