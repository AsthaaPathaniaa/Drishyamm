"""I-1 indexer hot path + writer queue — pure logic, fake clock, no GPU/DB.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_indexer -v
"""
from __future__ import annotations

import asyncio
import unittest
import uuid

import numpy as np

from vms_face.investigate import indexer as ixr

CAM = uuid.uuid4()
TENANT = uuid.uuid4()


class Clock:
    def __init__(self) -> None:
        self.t = 1_800_000_000.0

    def __call__(self) -> float:
        return self.t


def frame(colour=(0, 0, 200)) -> np.ndarray:
    f = np.full((720, 1280, 3), 40, dtype=np.uint8)
    f[200:600, 400:600] = colour       # a "person" in a (BGR) red top
    return f


def make(**kw):
    clock = Clock()
    out: list[ixr.TrackSummary] = []
    idx = ixr.CameraIndexer(CAM, TENANT, out.append, clock=clock, **kw)
    return idx, clock, out


def walk(idx, clock, seconds, *, dt=0.25, box=(400, 200, 600, 600, 0.9), faces=(), shift=2.0, f=None):
    f = frame() if f is None else f
    x = 0.0
    for _ in range(int(seconds / dt)):
        b = (box[0] + x, box[1], box[2] + x, box[3], box[4])
        idx.step(f, [b], faces)
        x += shift
        clock.t += dt


class CameraIndexerTest(unittest.TestCase):
    def test_a_pass_becomes_one_summary_when_it_ends(self):
        idx, clock, out = make()
        walk(idx, clock, 5)
        self.assertEqual(out, [])                 # still in view: nothing yet
        clock.t += 2
        idx.step(frame(), [])                      # gone for > max_gap
        self.assertEqual(len(out), 1)
        s = out[0]
        self.assertTrue(s.final and s.first_write)
        self.assertEqual((s.tenant_id, s.camera_id), (TENANT, CAM))
        self.assertGreater(s.best_crop.size, 0)
        self.assertLessEqual(s.best_crop.shape[0], 256)
        self.assertTrue(4 <= len(s.points) <= 6)   # ~1 point/s over 5 s
        self.assertTrue(all(0 <= v <= 1000 for _, b in s.points for v in b))
        self.assertEqual(len(s.samples), ixr.SAMPLES)

    def test_flicker_is_not_indexed(self):
        idx, clock, out = make()
        walk(idx, clock, 0.5)
        clock.t += 2
        idx.step(frame(), [])
        self.assertEqual(out, [])
        self.assertEqual(idx.junk, 1)

    def test_long_tracks_write_a_heartbeat_then_the_rest(self):
        idx, clock, out = make(heartbeat_s=10)
        walk(idx, clock, 25, shift=0.5)
        beats = [s for s in out if not s.final]
        self.assertEqual(len(beats), 2)            # at ~10 s and ~20 s
        self.assertTrue(beats[0].first_write)
        self.assertFalse(beats[1].first_write)
        self.assertEqual(len({s.track_uid for s in out}), 1)
        clock.t += 2
        idx.step(frame(), [])
        final = out[-1]
        self.assertTrue(final.final)
        self.assertFalse(final.first_write)
        sent = [t for s in out for t, _ in s.points]
        self.assertEqual(len(sent), len(set(sent)))   # each point written once

    def test_a_heartbeat_track_is_written_even_if_its_end_is_short(self):
        idx, clock, out = make(heartbeat_s=1, min_seconds=100)
        walk(idx, clock, 2)
        clock.t += 2
        idx.step(frame(), [])
        self.assertTrue(out[-1].final)

    def test_face_inside_the_upper_body_links_track_and_person(self):
        idx, clock, out = make()
        faces = [((470, 210, 530, 280), "t00000007", "8a0d9a4e-0000-0000-0000-000000000001")]
        walk(idx, clock, 3, faces=faces, shift=0)
        clock.t += 2
        idx.step(frame(), [])
        self.assertEqual(out[0].face_track_ids, ["t00000007"])
        self.assertEqual(out[0].person_id, "8a0d9a4e-0000-0000-0000-000000000001")

    def test_flush_writes_live_tracks(self):
        idx, clock, out = make()
        walk(idx, clock, 3)
        idx.flush()
        self.assertEqual(len(out), 1)

    def test_a_box_cut_off_by_the_frame_edge_is_a_worse_crop(self):
        full = ixr.crop_quality((400, 200, 600, 600), 0.9, 1280, 720)
        cut = ixr.crop_quality((0, 200, 200, 600), 0.9, 1280, 720)
        self.assertGreater(full, cut)


class AttributesTest(unittest.TestCase):
    def test_vote_needs_agreement(self):
        self.assertEqual(ixr.vote(["red", "red", "blue"])["value"], "red")
        self.assertIsNone(ixr.vote(["red", "blue"]))
        self.assertIsNone(ixr.vote([None, None]))
        self.assertLess(ixr.vote(["red"])["conf"], 0.5)      # one look: stored, not a hard filter

    def test_grey_crops_are_ir(self):
        grey = np.full((160, 80, 3), 120, dtype=np.uint8)
        self.assertTrue(ixr.track_is_ir([grey, grey, grey], grey))

    def test_colours_come_from_the_model_and_ir_gets_none(self):
        class Stub:
            def classify(self, vecs, labels, template):
                return [("white" if "top" in template else "black", 0.8)] * len(vecs)

        v = np.zeros((2, 4), np.float32)
        out = ixr.colour_attributes(Stub(), v, v, [False, True])
        self.assertEqual(out[0], {"top_colour": {"value": "white", "conf": 0.8}, "bottom_colour": {"value": "black", "conf": 0.8}})
        self.assertEqual(out[1], {})

    def test_lower_half_is_the_legs(self):
        crop = np.zeros((200, 80, 3), np.uint8)
        self.assertEqual(ixr.lower_half(crop).shape[0], 84)

    def test_colour_crops_are_not_ir(self):
        red = np.zeros((160, 80, 3), dtype=np.uint8)
        red[..., 2] = 200
        self.assertFalse(ixr.is_ir(red))


class WriterQueueTest(unittest.TestCase):
    def test_full_queue_drops_instead_of_blocking(self):
        async def run():
            w = ixr.IndexWriter(queue_max=2, batch_wait_s=0.01)
            got = []

            async def fake_write(batch):
                got.extend(batch)

            w.write_batch = fake_write
            for i in range(5):
                w.submit(i)      # the camera loop never awaits
            self.assertEqual(w.dropped, 3)
            await asyncio.sleep(0.05)
            self.assertEqual(len(got), 2)
            self.assertEqual(w.written, 2)
            w._task.cancel()

        asyncio.run(run())

    def test_a_failed_batch_is_counted_and_the_writer_keeps_going(self):
        async def run():
            w = ixr.IndexWriter(queue_max=10, batch_wait_s=0.01)
            calls = []

            async def flaky(batch):
                calls.append(batch)
                if len(calls) == 1:
                    raise RuntimeError("qdrant down")

            w.write_batch = flaky
            w.submit("a")
            await asyncio.sleep(0.05)
            w.submit("b")
            await asyncio.sleep(0.05)
            self.assertEqual((w.failed, w.written), (1, 1))
            w._task.cancel()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
