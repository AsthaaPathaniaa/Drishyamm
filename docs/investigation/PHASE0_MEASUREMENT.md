# I-1 Phase 0: measuring tracks per camera per day

Before we build the search index, we need real numbers from real cameras:

1. **How many people pass each camera per day?** Split into *face tracks* (what Drishyam tracks today) and *person tracks* (YOLO body boxes, which also catch people seen from behind).
2. **How much extra GPU does person detection cost?**
3. From those: **how much storage the index will need** per camera per day.

This runs on the **testing server**. The code reaches it the normal way: PR → `main` → auto-deploy.

## What the meter does

`ai/face-service/vms_face/investigate/measure.py`, switched on with `INVESTIGATE_MEASURE_ENABLED=true`.

- Counts every finished track per camera, as **kept** (at least 1 s long and at least 3 matched frames: what we would index) or **junk** (flicker).
- Counting only. It saves no crops or embeddings and writes nothing to any database. Each frame costs one dictionary update per visible track.
- Off by default. When off, the pipeline behaves exactly as before.

Outputs:

| Where | What |
|---|---|
| Logs | One `investigate.measure` line per camera every 15 min: `face_kept`, `person_kept`, totals |
| Prometheus `/metrics` | `vms_investigate_tracks_closed_total{camera_id,kind,kept}`, `vms_investigate_track_duration_seconds{kind}` |
| `GET /streams/debug` (JWT) | `investigate_measure` block per camera, including a per-day projection |

## Runbook (testing server)

All commands run in the repo checkout on the testing server. Changing `.env` is configuration, not code, so it doesn't break the "no code edits on servers" rule.

### 1. Baseline GPU, with measurement and person detection off (30 min)

```bash
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv -l 10 > /tmp/gpu_baseline.csv
# leave it running ~30 min with the usual cameras live, then Ctrl+C
```

### 2. Turn on face-track counting only (24 h)

```bash
echo "INVESTIGATE_MEASURE_ENABLED=true" >> .env       # if the key is already in .env, edit it instead
docker compose up -d smart-cam-ai
docker compose logs -f smart-cam-ai | grep investigate.measure      # a line per camera every 15 min
```

The counts live in memory, so a restart or redeploy of `smart-cam-ai` resets the totals. Each log line also carries that 15-minute window's own counts (`face_kept`, `person_kept`), so save the log to a file and add up the windows:

```bash
nohup sh -c 'docker compose logs -f --since 1m smart-cam-ai 2>&1 | grep --line-buffered investigate.measure >> ~/i1-measure.log' >/dev/null 2>&1 &
```

Other PRs can merge and deploy while this runs. A deploy that recreates `smart-cam-ai` just starts a new run of windows, and the saved log keeps the old ones. Note the time of each deploy so the numbers can be split into "face only" and "with person detection".

### 3. Add person detection (YOLO), another 24 h

Person tracks need the YOLO model as ONNX: the AI image runs ONNX Runtime and has no PyTorch, so it can't load `.pt` files. The converted file is in the repo (Git LFS): `models/person/yolov8n.onnx`, made from `models/person/yolov8n.pt` with the same weights (SHA-256 `03194f89…5b62c`). Copy it to where the AI service looks:

```bash
git lfs pull --include="models/person/yolov8n.onnx"
cp models/person/yolov8n.onnx data/ai-models/yolov8n.onnx
```

To convert a different `.pt` later: `pip install ultralytics onnx onnxscript`, then `yolo export model=<file>.pt format=onnx imgsz=640 simplify=True`, then merge into a single file with `python -c "import onnx;onnx.save(onnx.load('<file>.onnx'),'<file>.onnx',save_as_external_data=False)"`.

Then:

```bash
echo "PIPELINE_PERSON_DETECTION_ENABLED=true" >> .env
docker compose up -d smart-cam-ai
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv -l 10 > /tmp/gpu_person.csv
```

Compare `/tmp/gpu_person.csv` with `/tmp/gpu_baseline.csv`. **Target: under 10 % extra GPU.** Also watch live view for lag. If live view lags, add `PIPELINE_PERSON_DETECT_EVERY_N_FRAMES=4` to `.env`, run `docker compose up -d smart-cam-ai` and measure again.

> ⚠️ YOLOv8 from Ultralytics is **AGPL-3.0**. It's fine for this internal measurement, but before the index ships to customers, we need either an Ultralytics commercial licence or a permissively licensed detector. Tracked under the licence check for I-1.

### 4. Read the numbers

```bash
tail -50 ~/i1-measure.log
docker compose logs --since 24h smart-cam-ai | grep investigate.measure | tail -50   # if the saved log wasn't running
docker compose exec smart-cam-ai python -c "import urllib.request;print('\n'.join(l for l in urllib.request.urlopen('http://localhost:8001/metrics').read().decode().splitlines() if 'vms_investigate' in l))"
```

### 5. Switch it off again

```bash
sed -i '/^INVESTIGATE_MEASURE_ENABLED=/d;/^PIPELINE_PERSON_DETECTION_ENABLED=/d' .env
docker compose up -d smart-cam-ai
```

## Quality spike: does "red top" find red tops?

Runs on the testing server while the meter collects numbers. It reads **recordings only** (no NVR).

**Step 1: dump about 500 person photos** (best photo per person pass, spread over the day and over cameras), using the AI image:

```bash
mkdir -p ~/i1-spike
docker compose run --rm --no-deps --entrypoint python -v "$HOME/i1-spike:/out" smart-cam-ai \
  -m vms_face.eval.i1_crop_dump --date $(date -d yesterday +%F) --max-crops 500 --out /out/crops
```

**Step 2: run the text search with the candidate models** (needs a small Python environment with PyTorch, one-time setup):

```bash
python3 -m venv ~/i1-venv
~/i1-venv/bin/pip install torch transformers pillow sentencepiece protobuf
~/i1-venv/bin/python ai/face-service/vms_face/eval/i1_text_search.py --crops ~/i1-spike/crops
```

This writes `~/i1-spike/report.html`. For 18 queries ("red top", "backpack", "helmet", "saree", …), it shows the top 20 photos from each model (SigLIP, LAION CLIP) and from today's colour heuristic. Open it in a browser and tick the correct ones. The table at the top shows precision per query. Use **Copy results as JSON** and paste the results into the I-1 PR.

> The crops show real people. Keep them on team machines, don't upload them anywhere, and delete `~/i1-spike` when the spike is done.

## Results (fill in)

| Camera | Type of place | Face tracks kept / day | Person tracks kept / day | Avg track length (s) |
|---|---|---|---|---|
| | | | | |

| Measure | Value |
|---|---|
| GPU util, baseline → with person detection | ___ % → ___ % |
| GPU memory, baseline → with person detection | ___ MB → ___ MB |
| Live view lag noticed? | |

**Storage estimate per camera per day** = person tracks/day × (≈ 15 KB crop + ≈ 1 KB vector + ≈ 2 KB row + track length × ≈ 16 B for 1 point/s positions).

These numbers go in the I-1 PR description and decide the GPU and storage budget for the index.
