"""zone-sim — the PERSON-box producer the restricted-zone engine was waiting for.

Why this exists
---------------
The restricted-zone engine (smart-cam-backend/src/services/zoneIntrusion.service.js)
is already complete: it holds the zone polygons, the dwell / K-of-N confirm, the
re-alert heartbeat and the clear timer, and it fans a confirmed intrusion out to
toast + notification bell + email + push. What it does NOT have on this stack is
anything feeding it boxes.

It listens on the `ai.live.overlay` channel, which today only the FACE pipeline
publishes to. A face box only exists when a face is resolvable, so a person who
walks through a restricted zone with their back to the camera, in poor light, or
too far away produces no box at all — and the zone stays silent. That is the gap
this service closes: YOLO person detection, posted to the same ephemeral overlay
channel, so the engine sees a body whether or not there is a usable face.

What is simulated and what is real
----------------------------------
Simulated: the VIDEO. The demo camera is a bundled clip looped into the stream
service by the `local-demo-cam` container, because the real cameras sit on a site
LAN that a dev machine cannot reach.

Real: everything after the frame. The camera is a normal camera row, the zone is
a normal DB row drawn in the Restricted Zone UI, the detection is a real model on
real pixels, and the alert travels the product's real path. Nothing in this file
fabricates an alert or writes one directly — it only reports what it sees, and
the engine decides whether that is worth alerting on.

Which cameras, and who decides
------------------------------
The PRODUCT decides, not this file and not the environment. Cameras come from
`/api/internal/zone-guard/cameras`, which lists a camera only when its own AI
switch is on, it carries at least one restricted zone that is ARMED RIGHT NOW,
the owner's plan includes AI, and body detection is on for that camera. The
list is re-read every `ZONE_SIM_REGISTRY_REFRESH` seconds and workers are
started AND STOPPED to match, so drawing a zone starts coverage and deleting it
— or switching that camera's AI off — releases the stream, with no restart
either way.

ARMED is part of that answer and it moves with the CLOCK, not only with the
database: a zone armed 09:00-17:00 lists its camera at 09:00 and de-lists it at
17:00, and because the list is polled, the camera is acquired and released on
time without anyone touching this service. The engine was always refusing to
alert outside that window; until it was in the list, this service spent sixteen
hours a day decoding and inferring frames whose boxes the engine dropped.

This replaces selection by `ZONE_SIM_MONITORS` alone, which was read once at
import and checked nothing else. Set to `all` it opened every camera in the
deployment on the MAIN stream and held each session permanently, including
cameras with no zone drawn and cameras whose AI an operator had deliberately
switched off — a large, invisible load nobody had asked for, and a service that
disobeyed the one switch the operator is given.

`ZONE_SIM_MONITORS` survives as a development NARROWING filter: it can take a
subset of what the product lists, never widen it.

What it costs, and why it costs that
------------------------------------
Everything below is about load, and NONE of it changes what is detected: the
model, the confidence floor (ZONE_SIM_CONF), the rate (ZONE_SIM_FPS) and the
input size (ZONE_SIM_IMGSZ) are untouched. Nothing detected before stops being
detected.

  one model, not one per camera   The per-camera instance existed for the
      TRACKER, which carries per-stream state. The zone engine ignores trackId
      entirely (zoneIntrusion.service.js contains no reference to it); only the
      overlay's box smoothing benefits, and it has a positional fallback. So
      tracking is OFF by default and plain detection -- which is stateless --
      runs on ONE shared model for every camera, with the frames waiting at the
      same moment batched into one inference call. Turning ZONE_SIM_TRACK back
      on restores a model per camera, because the shared path REFUSES to run
      with tracking rather than quietly blending identities between cameras.

  the sub-stream, not the main one  Frames are letterboxed to ZONE_SIM_IMGSZ
      (640) before the model sees them, so a 720p sub-stream carries as much
      usable detail as a 4K main stream and costs a fraction of the decode.
      Main is the fallback for a camera with no sub-stream, and the worker says
      which one it opened -- that line is how anyone later diagnoses a camera
      whose sub-stream is too small to detect at.

  armed zones only                 The engine refuses to alert outside a zone's
      window, so a camera whose only zone is armed 09:00-17:00 used to be
      decoded and inferred for sixteen hours a day to produce boxes that were
      thrown away. The backend applies the same arm test to the list now
      (backend zoneArming.js), and this service re-reads that list on a timer,
      so a window opening acquires the camera and closing releases it.

  grab() between inferences        Every frame is still taken off the socket --
      that is what keeps the decoder on the live edge and stops a backlog
      forming -- but only the frames actually inferred on are DECODED.

Environment
-----------
  BACKEND_URL          backend base URL          (default http://smart-cam-backend:5000)
  SERVICE_TOKEN        internal-API shared secret (required)
  ZONE_SIM_MONITORS    dev filter: comma list of monitorIds to NARROW the
                       product's list to, or `all`/empty for all of it. It can
                       never add a camera the product did not list.
  ZONE_SIM_SOURCES     optional `monitorId=rtsp://...` overrides, comma separated
  ZONE_SIM_STREAM      `sub` (default) or `main`: which stream to prefer. The
                       other is used when the preferred one does not exist.
  ZONE_SIM_MODEL       YOLO weights path         (default /models/yolov8n.pt)
  ZONE_SIM_FPS         frames analysed per second per camera (default 4)
  ZONE_SIM_CONF        person confidence floor   (default 0.35)
  ZONE_SIM_IMGSZ       model input size          (default 640)
  ZONE_SIM_DEVICE      torch device, e.g. cuda:0 or cpu (default: auto)
  ZONE_SIM_TRACK       track ids (default FALSE). On, each camera gets its own
                       model instance again -- see above.
  ZONE_SIM_MAX_BATCH   most frames in one shared inference call (default 8)
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

import cv2

logging.basicConfig(
    level=os.environ.get("ZONE_SIM_LOG", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("zone-sim")

BACKEND_URL = os.environ.get("BACKEND_URL", "http://smart-cam-backend:5000").rstrip("/")
SERVICE_TOKEN = os.environ.get("SERVICE_TOKEN", "")
MONITORS = os.environ.get("ZONE_SIM_MONITORS", "all").strip()
MODEL_PATH = os.environ.get("ZONE_SIM_MODEL", "/models/yolov8n.pt")
FPS = float(os.environ.get("ZONE_SIM_FPS", "4"))
CONF = float(os.environ.get("ZONE_SIM_CONF", "0.35"))
IMGSZ = int(os.environ.get("ZONE_SIM_IMGSZ", "640"))
DEVICE = os.environ.get("ZONE_SIM_DEVICE", "").strip()
REGISTRY_REFRESH_S = float(os.environ.get("ZONE_SIM_REGISTRY_REFRESH", "60"))
# Consecutive inference failures before a worker gives up on the GPU.
INFER_FAIL_LIMIT = int(os.environ.get("ZONE_SIM_INFER_FAIL_LIMIT", "10"))


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# Track ids, OFF by default. They buy the overlay's box smoothing a stable id
# and buy the zone engine nothing at all -- and they are the only reason a
# model instance was ever needed per camera. See the cost note at the top.
TRACK = _flag("ZONE_SIM_TRACK", False)
# Which stream to prefer. The other one is used when the preferred one does not
# exist, so this never leaves a camera unwatched.
STREAM_PREF = "main" if os.environ.get("ZONE_SIM_STREAM", "sub").strip().lower() == "main" else "sub"
# Most frames in one shared inference call. The batch is whatever happens to be
# waiting -- no frame is ever HELD BACK to fill one, so this caps a burst
# rather than setting a target.
MAX_BATCH = max(1, int(os.environ.get("ZONE_SIM_MAX_BATCH", "8")))
# A safety net, not a timeout anyone should hit: the thread at the model takes
# every waiting frame before it stops, so a frame left this long means
# something is badly wrong and it is better to infer it late than to drop it.
FOLLOWER_WAIT_S = float(os.environ.get("ZONE_SIM_BATCH_WAIT", "20"))
# Consecutive decode failures on frames we DID grab before calling the stream
# stalled. grab() succeeding while retrieve() fails is a codec hiccup, not a
# dead socket, so it gets a few tries before a reconnect.
RETRIEVE_FAIL_LIMIT = int(os.environ.get("ZONE_SIM_RETRIEVE_FAIL_LIMIT", "15"))

# COCO class 0 is `person`. This is the only class we ask the model for — a zone
# breach is about people, and filtering at inference is cheaper than filtering
# the results afterwards.
PERSON_CLASS = 0


def _sources_override() -> dict[str, str]:
    """`ZONE_SIM_SOURCES=mon1=rtsp://a,mon2=rtsp://b` — escape hatch for a camera
    whose registry URL is not what we want to analyse (e.g. read the always-on
    publisher path directly instead of the on-demand `cam_*` egress)."""
    out: dict[str, str] = {}
    for chunk in os.environ.get("ZONE_SIM_SOURCES", "").split(","):
        chunk = chunk.strip()
        if not chunk or "=" not in chunk:
            continue
        mon, _, url = chunk.partition("=")
        out[mon.strip()] = url.strip()
    return out


def _http_json(url: str, method: str = "GET", payload: dict | None = None, timeout: float = 6.0):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("X-Service-Token", SERVICE_TOKEN)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (trusted internal URL)
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)


def fetch_cameras() -> list[dict]:
    """Cameras this service should analyse, as decided by the PRODUCT.

    `/api/internal/zone-guard/cameras` answers the question this service
    actually has, rather than handing over every camera for us to filter. The
    backend qualifies a camera on four conditions we cannot see from here:

      * the camera's own AI switch is on (the operator's switch -- the one that
        matters, and the one this service used to ignore entirely);
      * it has at least one restricted zone that is ARMED NOW -- enabled, and
        inside its own arm window -- so there is something to watch for AND
        something that would be acted on if we saw it;
      * the owner's plan includes AI;
      * `settings.ai.zoneBodyDetection` is on FOR THAT CAMERA -- the per-camera
        switch for this service. It is off by default, because the right answer
        differs per zone: a strict lockout wants our nameless body boxes, an
        allow-list zone is broken by them, and a camera with face recognition
        off needs them or its zone never fires at all. So an operator opts a
        camera in rather than the deployment opting everyone in.

    Before this, selection came from ZONE_SIM_MONITORS alone -- an environment
    variable read once at import. Set to `all` it opened every camera in the
    deployment on the MAIN stream and held the session permanently, including
    cameras with no zone and cameras whose AI a human had switched off. The
    env var survives as a DEVELOPMENT NARROWING filter below: it can only ever
    take a subset of what the product says, never widen it.
    """
    try:
        _, data = _http_json(f"{BACKEND_URL}/api/internal/zone-guard/cameras")
    except Exception as err:  # noqa: BLE001 — any failure is "try again next tick"
        # Deliberately NOT falling back to the full registry. A backend blip
        # must not turn into "watch everything": the previous behaviour is the
        # defect, and an empty list for one 60 s tick is the safe answer.
        log.warning("zone-guard camera list unreachable: %s", err)
        return []

    return select_cameras(
        (data or {}).get("cameras") or [],
        parse_monitor_filter(MONITORS),
        _sources_override(),
    )


def parse_monitor_filter(raw: str) -> set[str] | None:
    """`ZONE_SIM_MONITORS` as a set, or None for "no filter".

    None means "whatever the product says" -- NOT "everything". The distinction
    is the whole safety property: there is no value of this variable that adds
    a camera the backend did not list.
    """
    if (raw or "").strip().lower() in ("all", "*", ""):
        return None
    return {m.strip() for m in (raw or "").split(",") if m.strip()}


def pick_source(cam: dict, override: str | None = None) -> tuple[str | None, str]:
    """Which URL to open for one listed camera, and WHICH STREAM that is.

    The sub-stream by preference. Every frame is letterboxed to ZONE_SIM_IMGSZ
    (640) before the model sees it, so a 1280x720 sub-stream arrives at the
    model carrying the same usable detail a 3840x2160 main stream does -- and
    costs a fraction of the decode to get there. Preferring main was never a
    decision, it was the only field `fetch_cameras` read.

    Main is the FALLBACK, never a failure: a camera with no sub-stream is
    watched on its main stream exactly as before. The second return value is
    which one was chosen, so the worker can say so in its opening log line --
    the one record that tells a later reader why a camera detects badly (its
    sub-stream being, say, 320x180).

    An explicit ZONE_SIM_SOURCES override wins over both and is reported as
    itself: it is usually a publisher path that is neither.
    """
    if override:
        return override, "override"
    sub, main = cam.get("rtspSub"), cam.get("rtsp")
    if STREAM_PREF == "main":
        return (main, "main") if main else (sub, "sub")
    return (sub, "sub") if sub else (main, "main")


def select_cameras(
    cams: list[dict],
    wanted: set[str] | None,
    overrides: dict[str, str] | None = None,
) -> list[dict]:
    """The cameras to open, out of the ones the BACKEND listed.

    `cams` is the product's answer and is the only source of candidates. This
    function can drop from it and can rewrite a URL; it can never add a camera,
    so `ZONE_SIM_MONITORS` is a NARROWING filter and nothing else. That is the
    property the pure signature exists to make testable: the old code read the
    env var alone and opened every camera in the deployment, including ones
    with no zone and ones whose AI a human had switched off.

    `overrides` (ZONE_SIM_SOURCES) replaces a listed camera's URL. It is keyed
    by monitorId and is applied ONLY to cameras already in `cams`, so it cannot
    smuggle an unlisted camera in through the back door either.

    Each listed camera carries BOTH URLs (`rtsp` and `rtspSub`); `pick_source`
    chooses between them and reports which, so the worker can log it.
    """
    overrides = overrides or {}
    picked = []
    for c in cams:
        mon = c.get("monitorId")
        if not mon or (wanted is not None and mon not in wanted):
            continue
        url, stream = pick_source(c, overrides.get(mon))
        if not url:
            log.warning("camera %s has no RTSP egress URL; skipping", mon)
            continue
        picked.append({
            "monitorId": mon,
            "userId": c.get("userId"),
            "name": c.get("name") or mon,
            "url": url,
            # Which stream this is, for the worker's opening line. Chosen here
            # rather than logged here: selection runs every refresh, and a line
            # per camera per minute would bury the one that matters.
            "stream": stream,
        })

    if wanted is not None:
        missing = wanted - {c["monitorId"] for c in picked}
        for mon in sorted(missing):
            log.warning(
                "ZONE_SIM_MONITORS names %s, which the product does not list for zone-guard "
                "(no enabled zone, AI switched off, the plan does not include AI, or body "
                "detection is off for that camera)", mon,
            )
    return picked


def post_overlay(cam: dict, w: int, h: int, boxes: list[dict]) -> None:
    """Publish one frame's person boxes on the ephemeral overlay channel.

    This is the SAME endpoint the face pipeline uses. It is never persisted and
    never becomes an alert on its own — the zone engine subscribes to it and
    applies the zone's own dwell / confirm / cooldown rules before anything
    reaches an operator.
    """
    payload = {
        "userId": cam["userId"],
        "monitorId": cam["monitorId"],
        "ts": int(time.time() * 1000),
        "frameW": w,
        "frameH": h,
        "boxes": boxes,
    }
    try:
        _http_json(f"{BACKEND_URL}/api/internal/ai/overlay", method="POST", payload=payload)
    except urllib.error.HTTPError as err:
        log.warning("[%s] overlay POST rejected: %s %s", cam["name"], err.code, err.reason)
    except Exception as err:  # noqa: BLE001
        log.warning("[%s] overlay POST failed: %s", cam["name"], err)


def open_capture(url: str) -> cv2.VideoCapture | None:
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        cap.release()
        return None
    # A 1-frame buffer keeps us on the live edge. Without it OpenCV queues frames
    # and the boxes drift steadily behind the picture the operator is watching,
    # which makes a zone alert look like it fired at the wrong moment.
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:  # noqa: BLE001 — not supported on every backend
        pass
    return cap


# ── The model, and who gets one ─────────────────────────────────────────────
#
# A model instance per camera was correct for exactly one reason -- the TRACKER
# carries per-stream state, and sharing a tracker between cameras would blend
# identities between them. With tracking off, inference is stateless: the same
# weights answer any frame from any camera, and N instances were N copies of
# the weights and N CUDA contexts for nothing.
#
# So the two paths are separate TYPES rather than a flag inside one, and the
# shared one cannot be constructed for tracking at all. That is the assertion
# this split exists to make unmissable: a change that turns tracking back on
# gets a loud refusal instead of quietly wrong track ids.


class TrackerUnavailable(RuntimeError):
    """`model.track` could not run -- ultralytics' tracker pulls `lap` and will
    try to pip-install it AT RUNTIME on first use, which a container with no
    package index cannot do. The worker falls back to plain detection for the
    rest of its life, as it always did."""


def _load_model():
    """The weights. Imported here so the module loads without ultralytics (the
    camera-selection tests do exactly that), and so every instantiation in this
    file goes through one place that can be counted."""
    from ultralytics import YOLO

    return YOLO(MODEL_PATH)


class SharedDetector:
    """ONE model for every camera, and one inference call for the frames that
    happen to be waiting together.

    The batch is opportunistic: a frame is never held back to fill one. While
    the model is busy the frames that arrive queue up and go through as the
    next call, so a batch grows exactly when the GPU is under pressure and
    stays at one when it is not. That is why there is no batching WINDOW to
    tune -- a window would add latency on an idle service to buy throughput it
    does not need.

    Correctness rests on one invariant: the thread at the model keeps taking
    batches until the queue is EMPTY before it stops being the runner. So every
    queued frame is served by whichever runner is active, and a follower's wait
    is a safety net rather than a race it has to win.
    """

    per_camera = False

    def __init__(self, model, kw=None, max_batch=0, track=False):
        if track:
            raise RuntimeError(
                "the shared detector cannot run with tracking: the tracker carries "
                "per-stream state, so one model across cameras would blend identities "
                "between them. Use a detector per camera for tracking "
                "(TrackingDetector), or leave ZONE_SIM_TRACK off."
            )
        self._model = model
        self._kw = dict(kw or {})
        self._max = max(1, int(max_batch or MAX_BATCH))
        self._cv = threading.Condition()
        # Held across the model call itself, so even the safety-net path cannot
        # put two inferences on one model at the same time.
        self._infer = threading.Lock()
        self._queue = []
        self._running = False
        self._on_cpu = str(self._kw.get("device", "")).lower() == "cpu"
        # Counters, for the log line and for the tests that assert batching
        # actually happens.
        self.calls = 0
        self.frames = 0

    def detect(self, frame):
        """This frame's results, as a list of ultralytics Results (one entry),
        so the caller reads them exactly as it reads an unbatched call."""
        slot = {"frame": frame, "res": None, "err": None, "done": False}
        with self._cv:
            self._queue.append(slot)
            if self._running:
                self._cv.notify_all()
                deadline = time.monotonic() + FOLLOWER_WAIT_S
                while not slot["done"]:
                    left = deadline - time.monotonic()
                    if left <= 0 or not self._cv.wait(timeout=left):
                        break
                if slot["done"]:
                    return self._value(slot)
                # Should not happen (see the invariant above). Take the frame
                # back and run it alone rather than drop it. If the runner was
                # in fact mid-inference on this very slot, the frame is simply
                # inferred twice and the later result wins: one wasted call
                # after a 20-second stall, against a worker that silently
                # stops watching its zone.
                self._queue = [s for s in self._queue if s is not slot]
                log.warning(
                    "shared detector left a frame waiting %.0fs; inferring it alone",
                    FOLLOWER_WAIT_S,
                )
                mine = [slot]
            else:
                self._running = True
                mine = None

        if mine is not None:
            self._run(mine)
            return self._value(slot)

        try:
            while True:
                with self._cv:
                    if not self._queue:
                        self._running = False
                        self._cv.notify_all()
                        break
                    batch = self._queue[: self._max]
                    del self._queue[: len(batch)]
                self._run(batch)
                with self._cv:
                    self._cv.notify_all()
        except BaseException:
            # Never leave a queue with no runner: the next caller takes over.
            with self._cv:
                self._running = False
                self._cv.notify_all()
            raise
        return self._value(slot)

    def _run(self, batch):
        """One inference call for a whole batch. Never raises: a failure is
        recorded on each slot and re-raised in the caller's own thread, so each
        worker counts it against its own failure streak exactly as before."""
        frames = [s["frame"] for s in batch]
        out = None
        err = None
        with self._infer:
            try:
                out = self._model.predict(
                    frames, classes=[PERSON_CLASS],
                    conf=CONF, imgsz=IMGSZ, verbose=False, **self._kw,
                )
            except Exception as exc:  # noqa: BLE001 - reported per caller below
                err = exc
            self.calls += 1
            self.frames += len(frames)
        for i, slot in enumerate(batch):
            if err is not None:
                slot["err"] = err
            else:
                # predict() over a list answers in order, one Results per frame.
                slot["res"] = [out[i]] if out is not None and i < len(out) else []
            slot["done"] = True

    @staticmethod
    def _value(slot):
        if slot["err"] is not None:
            raise slot["err"]
        return slot["res"] or []

    def to_cpu(self):
        """Rebuild the one model on the CPU -- for every camera at once, which
        is the point: a GPU that has gone bad has gone bad for all of them.
        Returns whether this call is what moved it."""
        with self._infer:
            if self._on_cpu:
                return False
            try:
                self._model = _load_model()
                self._kw = {"device": "cpu"}
                self._on_cpu = True
                return True
            except Exception as err:  # noqa: BLE001
                log.error("CPU fallback failed: %s", err)
                return False


class TrackingDetector:
    """A model instance for ONE camera, because `model.track` keeps per-stream
    state and sharing it would blend identities between cameras. Allocated per
    worker, as every camera was before tracking became opt-in."""

    per_camera = True

    def __init__(self, model, kw=None):
        self._model = model
        self._kw = dict(kw or {})
        self._on_cpu = str(self._kw.get("device", "")).lower() == "cpu"

    def detect(self, frame):
        try:
            return self._model.track(
                frame, persist=True, classes=[PERSON_CLASS],
                conf=CONF, imgsz=IMGSZ, verbose=False, **self._kw,
            ) or []
        except Exception as err:  # noqa: BLE001 - tracker gone, not a bad frame
            raise TrackerUnavailable(err) from err

    def to_cpu(self):
        if self._on_cpu:
            return False
        try:
            self._model = _load_model()
            self._kw = {"device": "cpu"}
            self._on_cpu = True
            return True
        except Exception as err:  # noqa: BLE001
            log.error("CPU fallback failed: %s", err)
            return False


_shared_lock = threading.Lock()
_shared = None


def shared_detector():
    """The one detector every camera uses when tracking is off. Built on first
    use, so the module still imports with no weights and no ultralytics."""
    global _shared  # noqa: PLW0603 - one process-wide model is the point
    with _shared_lock:
        if _shared is None:
            kw = {"device": DEVICE} if DEVICE else {}
            _shared = SharedDetector(_load_model(), kw, track=TRACK)
            log.info(
                "one shared model for every camera (%s, batch<=%d, device=%s)",
                MODEL_PATH, MAX_BATCH, DEVICE or "auto",
            )
        return _shared


def reset_shared_detector():
    """Drop the shared model. For tests; nothing in the service calls it."""
    global _shared  # noqa: PLW0603
    with _shared_lock:
        _shared = None


def acquire_detector(track=None):
    """The detector for one worker: the shared one, or its own if tracking."""
    use_track = TRACK if track is None else track
    if use_track:
        kw = {"device": DEVICE} if DEVICE else {}
        return TrackingDetector(_load_model(), kw)
    return shared_detector()


def camera_worker(cam: dict, stop: threading.Event) -> None:
    """One thread per camera: decode -> detect people -> publish boxes.

    The thread is per camera; the MODEL is not, unless tracking is on. See the
    detector notes above for why that is safe and what refuses to run if it
    ever stops being safe.
    """
    name = cam["name"]
    detector = acquire_detector()
    min_gap = 1.0 / FPS if FPS > 0 else 0.0
    # A CUDA context can go bad for reasons that have nothing to do with us (a
    # second process grabbing the GPU, a driver hiccup) and every subsequent
    # inference then throws. Left alone the worker would sit there logging the
    # same error forever while the zone silently stopped being watched -- the
    # worst failure mode for a security feature, because nothing looks broken.
    # After a run of consecutive failures the model is rebuilt on the CPU: much
    # slower, but a watched zone beats an unwatched one. With the shared model
    # that move covers every camera at once, which is right -- the GPU did not
    # go bad for one of them.
    fail_streak = 0

    cap: cv2.VideoCapture | None = None
    backoff = 1.0
    last_post = 0.0
    logged_shape = False
    undecodable = 0

    log.info(
        "[%s] worker starting -- %s stream, source=%s, model=%s",
        name, cam.get("stream") or "main", cam["url"],
        "own (tracking)" if detector.per_camera else "shared",
    )
    if (cam.get("stream") or "main") == "main" and STREAM_PREF != "main":
        # The line that answers "why does this camera detect badly" later: it
        # is reading a full-size main stream because it offers no sub-stream.
        log.warning(
            "[%s] no sub-stream; reading the MAIN stream and letterboxing to %d px",
            name, IMGSZ,
        )

    while not stop.is_set():
        if cap is None:
            cap = open_capture(cam["url"])
            if cap is None:
                log.warning("[%s] cannot open source; retrying in %.0fs", name, backoff)
                stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
                continue
            log.info("[%s] source open", name)
            backoff = 1.0
            undecodable = 0

        # Pace the MODEL, not the decoder. EVERY frame is still taken off the
        # socket -- that is what keeps the decoder on the live edge and stops a
        # backlog forming, so the boxes stay on the picture the operator is
        # watching -- but grab() does not decode it. Only the frame we are
        # about to infer on is retrieved, so at 25 fps and ZONE_SIM_FPS=4 the
        # other 21 frames a second cost a grab instead of a full decode. The
        # pacing itself is unchanged: still exactly ZONE_SIM_FPS inferences a
        # second, on the newest frame available at each of them.
        if not cap.grab():
            log.warning("[%s] stream ended or stalled; reconnecting", name)
            cap.release()
            cap = None
            stop.wait(1.0)
            continue

        now = time.monotonic()
        if now - last_post < min_gap:
            continue

        ok, frame = cap.retrieve()
        if not ok or frame is None:
            # Grabbed but not decodable: a codec hiccup, not a dead socket. Try
            # the next frame rather than tearing the connection down, but do
            # not do that for ever -- a stream that never decodes is as blind
            # as one that never arrives.
            undecodable += 1
            if undecodable >= RETRIEVE_FAIL_LIMIT:
                log.warning(
                    "[%s] %d frames grabbed but none decoded; reconnecting",
                    name, undecodable,
                )
                cap.release()
                cap = None
                stop.wait(1.0)
            continue
        undecodable = 0
        last_post = now

        h, w = frame.shape[:2]
        if not logged_shape:
            log.info("[%s] frame %dx%d", name, w, h)
            logged_shape = True

        try:
            results = detector.detect(frame)
        except TrackerUnavailable as err:
            # The tracker is gone for good (its `lap` dependency is not
            # installable here), so this camera joins the shared model for the
            # rest of its life -- plain detection, exactly as if ZONE_SIM_TRACK
            # had been off. The zone engine never read trackId anyway.
            log.warning("[%s] tracker unavailable (%s); continuing without track ids", name, err)
            detector = shared_detector()
            continue
        except Exception as err:  # noqa: BLE001 - a bad frame must not kill the worker
            fail_streak += 1
            log.warning("[%s] inference failed (%d in a row): %s", name, fail_streak, err)
            if fail_streak >= INFER_FAIL_LIMIT and detector.to_cpu():
                log.error("[%s] falling back to CPU inference after %d failures", name, fail_streak)
                fail_streak = 0
            stop.wait(0.5)
            continue
        fail_streak = 0

        boxes: list[dict] = []
        for res in results or []:
            det = getattr(res, "boxes", None)
            if det is None:
                continue
            xyxy = det.xyxy.tolist() if det.xyxy is not None else []
            confs = det.conf.tolist() if det.conf is not None else []
            ids = det.id.tolist() if getattr(det, "id", None) is not None else []
            for i, box in enumerate(xyxy):
                x1, y1, x2, y2 = (float(v) for v in box[:4])
                entry = {
                    # The engine takes the bottom-centre of the box as the
                    # person's ground position, so a body box puts the point at
                    # the feet — where they actually stand. That is why a person
                    # detector and not a face detector belongs on this channel.
                    "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "conf": round(float(confs[i]), 3) if i < len(confs) else None,
                }
                if i < len(ids) and ids[i] is not None:
                    entry["trackId"] = int(ids[i])
                # Deliberately NO `name`: an unidentified body is exactly what the
                # engine treats as an intruder. Naming it here would silently
                # match the zone's authorised list and suppress the alert.
                boxes.append(entry)

        if boxes:
            post_overlay(cam, w, h, boxes)

    if cap is not None:
        cap.release()
    log.info("[%s] worker stopped", name)


def main() -> None:
    if not SERVICE_TOKEN:
        raise SystemExit("SERVICE_TOKEN is not set — the internal API would reject every post")

    log.info(
        "zone-sim starting — backend=%s monitors=%s model=%s fps=%.1f conf=%.2f imgsz=%d",
        BACKEND_URL, MONITORS, MODEL_PATH, FPS, CONF, IMGSZ,
    )
    # What this run will cost, in the line anyone reads first. Tracking is the
    # one that changes the shape of everything else: on, it is a model per
    # camera again.
    log.info(
        "zone-sim load plan — track=%s (%s), stream=%s preferred, batch<=%d",
        "on" if TRACK else "off",
        "a model per camera" if TRACK else "one model shared by every camera",
        STREAM_PREF, MAX_BATCH,
    )

    stop = threading.Event()
    # monitorId → (thread, its own stop event). Each worker gets its OWN event
    # so a single camera can be stopped without taking the service down: the
    # list is now the product's answer and it SHRINKS as well as grows, which
    # the previous add-only loop had no way to honour. Deleting the last zone
    # on a camera, or switching that camera's AI off, has to actually release
    # the stream -- otherwise the main-channel session leaks for the life of
    # the container and nothing in the product can reclaim it.
    workers: dict[str, tuple[threading.Thread, threading.Event]] = {}

    def release(mon: str, why: str) -> None:
        entry = workers.pop(mon, None)
        if entry is None:
            return
        thread, own_stop = entry
        own_stop.set()
        log.info("releasing camera %s — %s", mon, why)
        thread.join(timeout=5.0)
        if thread.is_alive():
            # The decode call can sit in ffmpeg for a while. The thread is a
            # daemon and its own stop is set, so it will exit; say so rather
            # than block the refresh loop behind it.
            log.warning("camera %s worker still winding down; it will exit on its own", mon)

    # Poll rather than reading once: a camera that gains a zone, or has its AI
    # switched on, should start being covered without restarting this service —
    # and one that loses either should stop.
    while not stop.is_set():
        cams = fetch_cameras()
        want = {c["monitorId"]: c for c in cams}

        for mon in [m for m in workers if m not in want]:
            release(mon, "no longer listed by the product")

        for mon, cam in want.items():
            entry = workers.get(mon)
            if entry is not None and entry[0].is_alive():
                continue
            if entry is not None:
                workers.pop(mon, None)      # died on its own; replace it
            own_stop = threading.Event()
            t = threading.Thread(
                target=camera_worker, args=(cam, own_stop), name=f"cam-{mon}", daemon=True,
            )
            workers[mon] = (t, own_stop)
            t.start()

        if not workers:
            log.info(
                "no cameras to analyse — the product lists none with an enabled zone, AI on "
                "and an AI plan (ZONE_SIM_MONITORS=%s)", MONITORS,
            )

        stop.wait(REGISTRY_REFRESH_S)

    # Shutting down: the workers hold their own events now, so the global stop
    # does not reach them by itself.
    for mon in list(workers):
        release(mon, "service shutting down")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("interrupted; exiting")
