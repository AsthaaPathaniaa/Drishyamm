"""What zone-guard costs to run, pinned.

Every test here is about LOAD, and the first thing each one guards is that the
load cut did not change what is detected: the model, the confidence floor, the
rate and the input size are untouched, and the assertions below check the
arguments that carry them.

Four properties, in the order they were cut:

  one model     per-camera instances existed for the TRACKER, which carries
                per-stream state. Tracking is off by default now, plain
                detection is stateless, and three cameras share one model --
                while tracking on still gets a model each, and the shared path
                REFUSES to be built for tracking.
  the sub-stream  preferred, with main as the fallback, and the choice reported
                so the worker can log it.
  grab/retrieve  every frame is still taken off the socket; only the frames
                actually inferred on are decoded. The inference rate is
                unchanged at ZONE_SIM_FPS.

Stdlib only. `cv2` and `ultralytics` are stubbed, so this runs with neither
OpenCV nor torch installed. Run from this directory:

    cd ai/zone-guard && python -m unittest test_zone_sim -v
"""
from __future__ import annotations

import logging
import sys
import types
import unittest

# zone_sim imports cv2 at module level; ultralytics is imported inside
# _load_model. Both are stubbed so this file runs anywhere.
_cv2 = sys.modules.setdefault("cv2", types.ModuleType("cv2"))
_cv2.CAP_FFMPEG = 1900
_cv2.CAP_PROP_BUFFERSIZE = 38

_ultra = types.ModuleType("ultralytics")


class FakeYOLO:
    """Counts its own instantiations: the whole point of the first test."""

    created: list[FakeYOLO] = []

    def __init__(self, path):
        self.path = path
        self.predict_calls: list[dict] = []
        self.track_calls: list[dict] = []
        FakeYOLO.created.append(self)

    def predict(self, source, **kw):
        self.predict_calls.append({"source": source, **kw})
        frames = source if isinstance(source, list) else [source]
        return [FakeResults(f) for f in frames]

    def track(self, source, **kw):
        self.track_calls.append({"source": source, **kw})
        frames = source if isinstance(source, list) else [source]
        return [FakeResults(f) for f in frames]


class FakeResults:
    """Just enough of an ultralytics Results to be identified by its frame."""

    def __init__(self, frame):
        self.frame = frame
        self.boxes = None


_ultra.YOLO = FakeYOLO
sys.modules["ultralytics"] = _ultra

import zone_sim  # noqa: E402

zone_sim.log.setLevel(logging.ERROR)


def cam(monitor_id: str, **over) -> dict:
    """A camera row as /api/internal/zone-guard/cameras returns it: BOTH URLs."""
    return {
        "monitorId": monitor_id,
        "userId": "owner-1",
        "name": monitor_id.upper(),
        "rtsp": f"rtsp://relay/cam_{monitor_id}",
        "rtspSub": f"rtsp://relay/cam_{monitor_id}_sub",
        **over,
    }


class Reset(unittest.TestCase):
    """Every test starts with no shared model and no flags left set."""

    def setUp(self):
        FakeYOLO.created.clear()
        zone_sim.reset_shared_detector()
        self._track = zone_sim.TRACK
        self._pref = zone_sim.STREAM_PREF
        self._fps = zone_sim.FPS
        zone_sim.TRACK = False
        zone_sim.STREAM_PREF = "sub"

    def tearDown(self):
        zone_sim.TRACK = self._track
        zone_sim.STREAM_PREF = self._pref
        zone_sim.FPS = self._fps
        zone_sim.reset_shared_detector()


# ── One model, not one per camera ───────────────────────────────────────────

class SharedModelTest(Reset):
    def test_three_cameras_create_exactly_one_model(self):
        detectors = [zone_sim.acquire_detector() for _ in range(3)]
        self.assertEqual(len(FakeYOLO.created), 1)
        # And it is literally the same detector object, so there is one queue
        # and one inference lock rather than three of each.
        self.assertIs(detectors[0], detectors[1])
        self.assertIs(detectors[1], detectors[2])
        self.assertFalse(detectors[0].per_camera)

    def test_tracking_on_still_allocates_a_model_per_camera(self):
        zone_sim.TRACK = True
        detectors = [zone_sim.acquire_detector() for _ in range(3)]
        self.assertEqual(len(FakeYOLO.created), 3)
        self.assertIsNot(detectors[0], detectors[1])
        self.assertTrue(all(d.per_camera for d in detectors))

    def test_the_shared_path_REFUSES_to_run_with_tracking(self):
        # The safety property. Sharing a tracker between cameras would blend
        # identities between them, so this must be impossible to do quietly.
        with self.assertRaises(RuntimeError) as caught:
            zone_sim.SharedDetector(FakeYOLO("m.pt"), track=True)
        self.assertIn("tracking", str(caught.exception))

        zone_sim.TRACK = True
        with self.assertRaises(RuntimeError):
            zone_sim.shared_detector()

    def test_the_detection_arguments_are_unchanged(self):
        # Nothing detected before may stop being detected: same class, same
        # confidence floor, same input size.
        det = zone_sim.acquire_detector()
        det.detect("frame-1")
        call = FakeYOLO.created[0].predict_calls[0]
        self.assertEqual(call["classes"], [zone_sim.PERSON_CLASS])
        self.assertEqual(call["conf"], zone_sim.CONF)
        self.assertEqual(call["imgsz"], zone_sim.IMGSZ)

    def test_a_frame_gets_its_own_results_back(self):
        det = zone_sim.acquire_detector()
        [res] = det.detect("frame-7")
        self.assertEqual(res.frame, "frame-7")

    def test_waiting_frames_go_through_as_ONE_call_in_order(self):
        # Batching, and the part that would be a real bug: each caller must get
        # ITS OWN frame's results back, not the batch's first.
        det = zone_sim.acquire_detector()
        model = FakeYOLO.created[0]
        got: dict[str, object] = {}
        order = ["a", "b", "c"]

        # The model is "busy" with frame a while b and c arrive, which is
        # exactly the condition a batch forms under in the real service.
        real_predict = model.predict

        def predict_once_then_batch(source, **kw):
            if len(model.predict_calls) == 0:
                for f in order[1:]:
                    slot = {"frame": f, "res": None, "err": None, "done": False}
                    det._queue.append(slot)   # noqa: SLF001 — simulating arrivals
                    got[f] = slot
            return real_predict(source, **kw)

        model.predict = predict_once_then_batch
        [res_a] = det.detect("a")

        self.assertEqual(res_a.frame, "a")
        # Two calls in total: "a" alone, then "b" and "c" together.
        self.assertEqual(len(model.predict_calls), 2)
        self.assertEqual(model.predict_calls[0]["source"], ["a"])
        self.assertEqual(model.predict_calls[1]["source"], ["b", "c"])
        self.assertEqual(det.frames, 3)
        self.assertEqual(det.calls, 2)
        # Each of the batched frames got its own results.
        for f in ("b", "c"):
            self.assertTrue(got[f]["done"])
            self.assertEqual([r.frame for r in got[f]["res"]], [f])

    def test_a_batch_never_grows_past_the_cap(self):
        det = zone_sim.SharedDetector(FakeYOLO("m.pt"), max_batch=2)
        for f in ("b", "c", "d"):
            det._queue.append({"frame": f, "res": None, "err": None, "done": False})  # noqa: SLF001
        det.detect("a")
        sources = [c["source"] for c in det._model.predict_calls]  # noqa: SLF001
        # Four frames waiting, two per call, in the order they queued -- "a"
        # joined last because the other three were already waiting. The runner
        # keeps going until the queue is empty, so none is left behind.
        self.assertEqual(sources, [["b", "c"], ["d", "a"]])
        self.assertEqual(det.calls, 2)
        self.assertEqual(det.frames, 4)

    def test_an_inference_failure_reaches_the_caller_that_asked(self):
        # The worker's failure streak and CPU fallback depend on detect()
        # raising in the worker's own thread, as an unbatched call did.
        det = zone_sim.acquire_detector()
        model = FakeYOLO.created[0]

        def boom(source, **kw):
            raise RuntimeError("CUDA is sulking")

        model.predict = boom
        with self.assertRaises(RuntimeError):
            det.detect("frame-1")

    def test_the_cpu_fallback_moves_the_one_model_once(self):
        det = zone_sim.acquire_detector()
        self.assertEqual(len(FakeYOLO.created), 1)
        self.assertTrue(det.to_cpu())
        # Rebuilt once, on the CPU, for every camera at the same time.
        self.assertEqual(len(FakeYOLO.created), 2)
        self.assertFalse(det.to_cpu())
        det.detect("frame-1")
        self.assertEqual(FakeYOLO.created[1].predict_calls[0]["device"], "cpu")


class SharedModelThreadTest(Reset):
    """The shared model under REAL threads.

    The tests above drive the queue directly, which is precise but proves
    nothing about locking. This one runs the actual contention: several camera
    threads at one model, with inference slow enough that they overlap. What
    must hold is that every thread gets its own frame's results and that none
    of them hangs -- a deadlock here would stop a security feature silently,
    which is worse than any load it saves.
    """

    def test_many_camera_threads_share_one_model_without_losing_a_frame(self):
        import threading

        det = zone_sim.acquire_detector()
        model = FakeYOLO.created[0]
        real_predict = model.predict
        gate = threading.Barrier(9, timeout=10)

        def slow_predict(source, **kw):
            # Hold the model long enough that the other threads are certainly
            # queued behind it, so batches really do form.
            import time as real_time
            real_time.sleep(0.01)
            return real_predict(source, **kw)

        model.predict = slow_predict
        got: dict[str, list] = {}
        errors: list[BaseException] = []

        def one_camera(label):
            try:
                gate.wait()
                for i in range(5):
                    frame = f"{label}-{i}"
                    res = det.detect(frame)
                    assert [r.frame for r in res] == [frame], (frame, res)
                    got.setdefault(label, []).append(frame)
            except BaseException as err:  # noqa: BLE001 — reported below
                errors.append(err)

        threads = [threading.Thread(target=one_camera, args=(f"cam{n}",)) for n in range(8)]
        for t in threads:
            t.start()
        gate.wait()
        for t in threads:
            t.join(timeout=30)
            self.assertFalse(t.is_alive(), "a camera thread hung at the shared model")

        self.assertEqual(errors, [])
        # Every frame answered, and answered with its own results.
        self.assertEqual(sorted(got), [f"cam{n}" for n in range(8)])
        self.assertEqual(sum(len(v) for v in got.values()), 40)
        self.assertEqual(det.frames, 40)
        # The point of batching: 40 frames went through FEWER than 40 calls,
        # and only ever one model was built.
        self.assertLess(det.calls, 40)
        self.assertEqual(len(FakeYOLO.created), 1)

    def test_a_failure_in_a_batch_reaches_every_camera_in_it(self):
        import threading

        det = zone_sim.acquire_detector()
        model = FakeYOLO.created[0]

        def boom(source, **kw):
            import time as real_time
            real_time.sleep(0.01)
            raise RuntimeError("CUDA is sulking")

        model.predict = boom
        raised: list[str] = []

        def one_camera(label):
            try:
                det.detect(label)
            except RuntimeError:
                raised.append(label)

        threads = [threading.Thread(target=one_camera, args=(f"cam{n}",)) for n in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
            self.assertFalse(t.is_alive())
        # Each worker counts the failure against its own streak, as it did when
        # every camera had its own model and its own call.
        self.assertEqual(sorted(raised), [f"cam{n}" for n in range(4)])


# ── The sub-stream ──────────────────────────────────────────────────────────

class StreamChoiceTest(Reset):
    def test_the_sub_stream_is_preferred_and_reported(self):
        url, which = zone_sim.pick_source(cam("cam-a"))
        self.assertEqual(url, "rtsp://relay/cam_cam-a_sub")
        self.assertEqual(which, "sub")

    def test_a_camera_with_only_a_sub_stream_opens_it(self):
        url, which = zone_sim.pick_source(cam("cam-a", rtsp=None))
        self.assertEqual(url, "rtsp://relay/cam_cam-a_sub")
        self.assertEqual(which, "sub")

    def test_a_camera_with_no_sub_stream_falls_back_to_main_and_says_so(self):
        url, which = zone_sim.pick_source(cam("cam-a", rtspSub=None))
        self.assertEqual(url, "rtsp://relay/cam_cam-a")
        # "says so" is this value: the worker logs it, and that line is how a
        # camera reading a 4K main stream is identified later.
        self.assertEqual(which, "main")

    def test_a_camera_with_neither_is_skipped_rather_than_opened_blind(self):
        self.assertEqual(zone_sim.pick_source(cam("cam-a", rtsp=None, rtspSub=None))[0], None)
        picked = zone_sim.select_cameras([cam("cam-a", rtsp=None, rtspSub=None), cam("cam-b")], None)
        self.assertEqual([c["monitorId"] for c in picked], ["cam-b"])

    def test_an_override_wins_over_both_and_is_named_as_itself(self):
        url, which = zone_sim.pick_source(cam("cam-a"), "rtsp://publisher/direct")
        self.assertEqual(url, "rtsp://publisher/direct")
        self.assertEqual(which, "override")

    def test_main_can_be_preferred_for_a_sub_stream_too_small_to_detect_in(self):
        zone_sim.STREAM_PREF = "main"
        self.assertEqual(zone_sim.pick_source(cam("cam-a"))[1], "main")
        # Still never leaves a camera unwatched: with no main stream it takes
        # the sub one.
        self.assertEqual(zone_sim.pick_source(cam("cam-a", rtsp=None))[1], "sub")

    def test_selection_carries_the_chosen_stream_through(self):
        [picked] = zone_sim.select_cameras([cam("cam-a")], None)
        self.assertEqual(picked["url"], "rtsp://relay/cam_cam-a_sub")
        self.assertEqual(picked["stream"], "sub")


# ── grab() between inferences ───────────────────────────────────────────────

class FakeCapture:
    """A capture that counts grabs and decodes separately, and stops the worker
    after `frames` frames so the loop under test terminates."""

    def __init__(self, stop, frames, fail_retrieve=False):
        self.stop = stop
        self.limit = frames
        self.fail_retrieve = fail_retrieve
        self.grabs = 0
        self.retrieves = 0
        self.released = False

    def grab(self):
        self.grabs += 1
        if self.grabs >= self.limit:
            self.stop.set()
        return True

    def retrieve(self):
        self.retrieves += 1
        if self.fail_retrieve:
            return False, None
        return True, FakeFrame()

    def release(self):
        self.released = True


class FakeFrame:
    shape = (720, 1280, 3)


class FakeClock:
    """Advances one source-frame interval per grab, so a run of N grabs is
    exactly N/source_fps seconds of video."""

    def __init__(self, step):
        self.now = 1000.0
        self.step = step

    def monotonic(self):
        return self.now

    def tick(self):
        self.now += self.step


class GrabRetrieveTest(Reset):
    SOURCE_FPS = 25

    def run_worker(self, source_frames, fps=4, fail_retrieve=False):
        """Run camera_worker over `source_frames` frames of a 25 fps stream."""
        import threading

        zone_sim.FPS = fps
        stop = threading.Event()
        clock = FakeClock(1.0 / self.SOURCE_FPS)
        cap = FakeCapture(stop, source_frames, fail_retrieve=fail_retrieve)
        posted: list[dict] = []

        real_grab = cap.grab

        def grab_and_tick():
            ok = real_grab()
            clock.tick()
            return ok

        cap.grab = grab_and_tick

        fake_time = types.SimpleNamespace(monotonic=clock.monotonic, time=lambda: 1.0)
        orig = (zone_sim.open_capture, zone_sim.post_overlay, zone_sim.time)
        zone_sim.open_capture = lambda url: cap
        zone_sim.post_overlay = lambda c, w, h, boxes: posted.append({"w": w, "h": h})
        zone_sim.time = fake_time
        try:
            zone_sim.camera_worker({**cam("cam-a"), "url": "rtsp://x", "stream": "sub"}, stop)
        finally:
            zone_sim.open_capture, zone_sim.post_overlay, zone_sim.time = orig
        return cap, posted

    def test_every_frame_is_grabbed_but_only_the_inferred_ones_are_decoded(self):
        # One second of a 25 fps stream at ZONE_SIM_FPS=4.
        cap, _ = self.run_worker(source_frames=self.SOURCE_FPS, fps=4)
        self.assertEqual(cap.grabs, self.SOURCE_FPS)
        # The decoder stays on the live edge (every frame taken off the socket)
        # while 21 of the 25 cost no decode at all.
        self.assertEqual(cap.retrieves, 4)
        self.assertTrue(cap.released)

    def test_frames_per_inference_is_unchanged_at_ZONE_SIM_FPS(self):
        # The pacing is what it always was, at any rate: the number of
        # inferences a second is ZONE_SIM_FPS, and that is what decides load.
        for fps in (1, 2, 4, 5):
            with self.subTest(fps=fps):
                cap, _ = self.run_worker(source_frames=self.SOURCE_FPS, fps=fps)
                self.assertEqual(cap.grabs, self.SOURCE_FPS)
                self.assertEqual(cap.retrieves, fps)

    def test_one_shared_model_however_many_cameras_ran(self):
        for _ in range(3):
            self.run_worker(source_frames=8, fps=4)
        self.assertEqual(len(FakeYOLO.created), 1)
        self.assertEqual(FakeYOLO.created[0].track_calls, [])

    def test_a_grabbed_frame_that_will_not_decode_does_not_tear_the_stream_down(self):
        # grab() succeeding while retrieve() fails is a codec hiccup, not a
        # dead socket: the worker keeps grabbing rather than reconnecting on
        # the first one.
        cap, posted = self.run_worker(source_frames=10, fps=25, fail_retrieve=True)
        self.assertEqual(posted, [])
        self.assertGreater(cap.grabs, 1)


if __name__ == "__main__":
    unittest.main()
