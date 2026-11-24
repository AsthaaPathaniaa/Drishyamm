"""Vehicle journey (I-10): vehicles from the same YOLO pass as people, their
type voted over the pass, vehicle colour and type chips in search.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_vehicles -v
"""
from __future__ import annotations

import datetime as dt
import unittest
import uuid

import numpy as np

from vms_face.infra.person_detector import COCO_VEHICLES, _decode_class_group
from vms_face.investigate import indexer as ixr
from vms_face.investigate.query_parser import parse


def fake_pred(dets):
    """A YOLOv8 (84, N) output: rows 0-3 cxcywh, 4.. class scores. dets: [(cx, cy, w, h, cls, score)]."""
    p = np.zeros((84, len(dets)), np.float32)
    for i, (cx, cy, w, h, cls, sc) in enumerate(dets):
        p[:4, i] = (cx, cy, w, h)
        p[4 + cls, i] = sc
    return p


class DecodeTest(unittest.TestCase):
    def test_people_and_each_vehicle_type_from_one_output(self):
        pred = fake_pred([(100, 100, 40, 120, 0, 0.9), (300, 300, 200, 100, 2, 0.8), (500, 300, 80, 60, 3, 0.7),
                          (300, 302, 198, 98, 7, 0.4)])           # overlaps the car, weaker: suppressed by NMS
        args = (0.35, 0.45, 1.0, 0, 0, 640, 640)
        people = _decode_class_group(pred, [0], ["person"], *args)
        vehicles = _decode_class_group(pred, list(COCO_VEHICLES), list(COCO_VEHICLES.values()), *args)
        self.assertEqual(len(people), 1)
        self.assertEqual(sorted(v[5] for v in vehicles), ["car", "motorcycle"])

    def test_low_scores_are_dropped(self):
        pred = fake_pred([(100, 100, 40, 40, 2, 0.2)])
        self.assertEqual(_decode_class_group(pred, [2], ["car"], 0.35, 0.45, 1.0, 0, 0, 640, 640), [])


class VehicleIndexerTest(unittest.TestCase):
    def test_type_is_voted_over_the_pass(self):
        t = {"v": 1_800_000_000.0}
        out = []
        idx = ixr.CameraIndexer(uuid.uuid4(), uuid.uuid4(), out.append, clock=lambda: t["v"], object_class="vehicle")
        frame = np.full((720, 1280, 3), 90, np.uint8)
        for i in range(12):
            kind = "truck" if i == 3 else "car"                 # one confused frame
            idx.step(frame, [(300 + i, 300, 700 + i, 600, 0.8, kind)])
            t["v"] += 0.25
        t["v"] += 2
        idx.step(frame, [])
        self.assertEqual(out[0].object_class, "vehicle")
        self.assertEqual(out[0].vehicle_type[0], "car")
        self.assertAlmostEqual(out[0].vehicle_type[1], 11 / 12)

    def test_vehicles_get_vehicle_colour_and_type_people_get_clothes(self):
        class Stub:
            def classify(self, vecs, labels, template):
                return [("white" if "vehicle" in template else "red", 0.9)] * len(vecs)

        v = np.zeros((3, 4), np.float32)
        out = ixr.colour_attributes(Stub(), v, v, [False, False, True], ["vehicle", "person", "vehicle"],
                                    [("car", 0.9), None, ("truck", 1.0)])
        self.assertEqual(out[0], {"vehicle_type": {"value": "car", "conf": 0.9}, "vehicle_colour": {"value": "white", "conf": 0.9}})
        self.assertIn("top_colour", out[1])
        self.assertEqual(out[2], {"vehicle_type": {"value": "truck", "conf": 1.0}})   # night: type, no colour


class ParserTest(unittest.TestCase):
    NOW = dt.datetime(2026, 11, 24, 12, tzinfo=dt.timezone.utc)

    def test_vehicle_words_and_colours(self):
        r = parse("white SUV at gate 2", now=self.NOW, cameras=[("c", "x", "Gate 2")])
        self.assertEqual((r.object_class, r.vehicle_type, r.vehicle_colour, r.camera_ids), ("vehicle", "car", "white", ["c"]))
        r = parse("लाल बाइक", now=self.NOW)
        self.assertEqual((r.vehicle_type, r.vehicle_colour), ("motorcycle", "red"))
        r = parse("auto rickshaw", now=self.NOW)
        self.assertEqual((r.object_class, r.vehicle_type), ("vehicle", None))   # not a COCO class: vehicle only


if __name__ == "__main__":
    unittest.main()
