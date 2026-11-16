"""I-1 phase 0 quality spike, step 1: dump person crops from recordings.

Reads recorded segments (``/recordings/<camera path>/<YYYY-MM-DD>/*.mp4``),
samples a frame every ``--every-s`` seconds, runs the YOLO person detector,
follows each person with the investigation ``BoxTracker`` and keeps the
**best crop per person pass** (largest, most confident box), the same rule the
I-1 summariser will use. Each crop also gets today's clothing-colour guess
(``journey.body.extract_clothing``) and a night/IR flag.

Reads recordings only: no NVR, no RTSP, no database, no network.

Run inside the AI image (it has onnxruntime + OpenCV):

    docker compose run --rm --no-deps --entrypoint python \\
        -v "$HOME/i1-spike:/out" smart-cam-ai \\
        -m vms_face.eval.i1_crop_dump --date 2026-11-15 --max-crops 500 --out /out/crops

Output: ``<out>/<id>.jpg`` + ``<out>/crops.csv``. Step 2 is
``vms_face/eval/i1_text_search.py``. Crops show real people: keep them on
team machines and delete them when the spike is done.
"""
from __future__ import annotations

import argparse
import csv
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from vms_face.infra.person_detector import YOLOPersonDetector
from vms_face.investigate.box_tracker import BoxTracker
from vms_face.journey.body import extract_clothing

# A frame whose mean HSV saturation is below this is treated as IR / greyscale.
IR_SATURATION_MAX = 18.0
MIN_CROP_H = 96  # px; smaller people are useless for attributes


@dataclass
class Best:
    score: float
    crop: np.ndarray
    ts: float
    box: tuple[float, float, float, float]
    det: float
    ir: bool


def frame_is_ir(frame: np.ndarray) -> bool:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    return float(hsv[..., 1].mean()) < IR_SATURATION_MAX


def list_segments(root: Path, date: str, cameras: list[str] | None) -> dict[str, list[Path]]:
    out: dict[str, list[Path]] = {}
    for cam_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if cameras and cam_dir.name not in cameras:
            continue
        day = cam_dir / date
        if day.is_dir():
            segs = sorted(day.glob("*.mp4"))
            if segs:
                out[cam_dir.name] = segs
    return out


def spread(items: list[Path], n: int) -> list[Path]:
    """Pick n items spread evenly over the day (not just the morning)."""
    if len(items) <= n:
        return items
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


def scan_segment(path: Path, det: YOLOPersonDetector, every_s: float) -> list[Best]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        print(f"  skip (cannot open): {path}", file=sys.stderr)
        return []
    t = 0.0
    clock = [0.0]
    tracker = BoxTracker(max_gap_s=every_s * 1.5 + 0.1, clock=lambda: clock[0])
    best: dict[str, Best] = {}
    done: list[Best] = []
    while True:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        clock[0] = t
        h, w = frame.shape[:2]
        ir = frame_is_ir(frame)
        boxes = [b for b in det.detect(frame) if (b[3] - b[1]) >= MIN_CROP_H]
        live = tracker.step(boxes)
        for tr in live:
            x1, y1, x2, y2 = (int(max(0, v)) for v in tr.bbox)
            x2, y2 = min(x2, w), min(y2, h)
            if x2 - x1 < 8 or y2 - y1 < MIN_CROP_H:
                continue
            det_score = next((b[4] for b in boxes if tuple(b[:4]) == tuple(tr.bbox)), 0.5)
            # touching the frame edge = probably cut off
            edge = 0.6 if (x1 <= 2 or y1 <= 2 or x2 >= w - 2 or y2 >= h - 2) else 1.0
            score = (x2 - x1) * (y2 - y1) * det_score * edge
            cur = best.get(tr.track_id)
            if cur is None or score > cur.score:
                best[tr.track_id] = Best(score, frame[y1:y2, x1:x2].copy(), t, (x1, y1, x2, y2), det_score, ir)
        for tr in tracker.closed:
            if tr.hits >= 2 and tr.track_id in best:
                done.append(best.pop(tr.track_id))
        t += every_s
    cap.release()
    for tr in tracker.flush():
        if tr.hits >= 2 and tr.track_id in best:
            done.append(best.pop(tr.track_id))
    return done


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recordings", default="/recordings")
    ap.add_argument("--date", required=True, help="YYYY-MM-DD folder to read")
    ap.add_argument("--cameras", default="", help="comma-separated camera path names (default: all)")
    ap.add_argument("--model", default="/srv/data/models/yolov8n.onnx")
    ap.add_argument("--every-s", type=float, default=1.0)
    ap.add_argument("--segments-per-camera", type=int, default=12)
    ap.add_argument("--max-crops", type=int, default=500)
    ap.add_argument("--threshold", type=float, default=0.45)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--cpu", action="store_true", help="run the detector on CPU (no GPU in the container)")
    args = ap.parse_args()

    root = Path(args.recordings)
    cams = [c for c in args.cameras.split(",") if c] or None
    segs = list_segments(root, args.date, cams)
    if not segs:
        print(f"No recordings under {root}/<camera>/{args.date}/", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    det = YOLOPersonDetector(
        args.model,
        score_threshold=args.threshold,
        providers=["CPUExecutionProvider"] if args.cpu else None,
    )
    per_cam = max(1, args.max_crops // len(segs))
    rng = random.Random(args.seed)

    rows = []
    for cam, cam_segs in segs.items():
        picked = spread(cam_segs, args.segments_per_camera)
        print(f"{cam}: {len(cam_segs)} segments, scanning {len(picked)}")
        found: list[tuple[Path, Best]] = []
        for seg in picked:
            found += [(seg, b) for b in scan_segment(seg, det, args.every_s)]
        rng.shuffle(found)
        for seg, b in found[:per_cam]:
            cid = f"{len(rows):04d}"
            attrs = extract_clothing(b.crop, person_bbox=[0, 0, b.crop.shape[1], b.crop.shape[0]])
            cv2.imwrite(str(out / f"{cid}.jpg"), b.crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            rows.append({
                "id": cid, "camera": cam, "segment": seg.name, "t_s": round(b.ts, 1),
                "w": b.crop.shape[1], "h": b.crop.shape[0], "det": round(float(b.det), 3),
                "ir": int(b.ir),
                "upper_color": "" if b.ir else (attrs.upper_color or ""),
                "lower_color": "" if b.ir else (attrs.lower_color or ""),
            })
        print(f"  kept {min(len(found), per_cam)} of {len(found)} person passes")

    with open(out / "crops.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["id"])
        wr.writeheader()
        wr.writerows(rows)
    ir_n = sum(r["ir"] for r in rows)
    print(f"Wrote {len(rows)} crops ({ir_n} night/IR) to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
