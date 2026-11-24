# Phase 1 (Find): switching on Smart Search and Evidence export

Phase 1 is three pieces, all **off by default**:

| Piece | What it does | Switch |
|---|---|---|
| I-1 search index | One record per person pass: best photo, voted clothing colours, night flag, 1 position per second, image fingerprint (SigLIP 2) | `INVESTIGATE_INDEX_ENABLED=true` (+ `PIPELINE_PERSON_DETECTION_ENABLED=true`) in `.env` |
| I-2 Smart Search | "man, red top, backpack, gate 3, 1–4 pm" (English or Hindi), or a photo → ranked thumbnails → click to play | Account feature **Smart Search** (admin console › Account control › Investigation) |
| I-5 Evidence export | Sealed ZIP: original footage + H.264 copy + report with draft Section 63 certificate + SHA-256 manifest signed per organisation; reason required; export log; verify tool | Account feature **Evidence export** (admin console › Account control › Video) |

Code reaches the server through the normal PR → `main` → auto-deploy. The model files and `.env` lines below are configuration, done once per server.

## 1. Model files (once per server)

The AI image has no PyTorch, so SigLIP 2 runs as ONNX. Export it on any machine with Python (the testing server is fine):

```bash
python3 -m venv ~/siglip-venv
~/siglip-venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
~/siglip-venv/bin/pip install transformers sentencepiece protobuf onnx onnxruntime tokenizers pillow
~/siglip-venv/bin/python ai/face-service/vms_face/investigate/tools/export_siglip.py \
    --revision 75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2 --out data/ai-models/siglip2
```

It downloads `google/siglip2-base-patch16-224` (Apache-2.0, 1.5 GB), writes `vision.onnx`, `text.onnx`, `tokenizer.json`, `meta.json` (about 1.5 GB) and refuses to finish unless ONNX matches PyTorch. If Hugging Face downloads stall, set `HF_HUB_DISABLE_XET=1`, or download the repo files with `curl -C -` into a folder and pass `--model <folder> --model-id google/siglip2-base-patch16-224`.

Person boxes come from YOLO (also used by footfall):

```bash
git lfs pull --include="models/person/yolov8n.onnx"
cp models/person/yolov8n.onnx data/ai-models/yolov8n.onnx
```

> ⚠️ YOLOv8 (Ultralytics) is AGPL-3.0: fine for the testing server, not for customers without a commercial licence or a permissive detector. See LICENCES.md.

## 2. Turn the index on

```bash
cat >> .env <<'EOF'
PIPELINE_PERSON_DETECTION_ENABLED=true
INVESTIGATE_INDEX_ENABLED=true
EOF
docker compose up -d smart-cam-ai
```

Check (needs a logged-in token, or open Smart Search in the app):

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:5000/api/investigate/status
# {"enabled":true,"person_detection":true,"tracks":123,...,"model":"google/siglip2-base-patch16-224@75de2d55ec2d"}
```

`GET /streams/debug` (AI) shows per camera `investigate_index: {emitted, junk, writer: {written, dropped, failed, queued}}`. Prometheus: `vms_investigate_index_tracks_total{outcome}`. `dropped` > 0 means the writer can't keep up: tell the team.

Index data is kept `INVESTIGATE_RETENTION_DAYS` (default 30) unless an export or case holds it.

## 3. Switch the features on for an account

Admin console › Account control › the account › **Smart Search** (Investigation) and **Evidence export** (Video). Both show a **NEW** badge and are off for every account, even "all features" ones, until switched on here.

Evidence packs are stored under `/recordings/_evidence/<org>/` (override with `EVIDENCE_DIR`). Set `CAMERA_CRED_KEY` on the backend so the organisation's signing key is stored encrypted.

## 4. What to measure before calling it done (README §7)

- GPU with the index on vs off (`nvidia-smi`), live view lag: target < 10 % extra GPU, no lag.
- Tracks per camera per day and storage per camera per day (`/streams/debug`, MinIO bucket `vms-investigate` size).
- Search quality: ~20 real queries on lab footage ("red top", "backpack", "white shirt, gate", one Hindi). Note how many of the top 20 are right.
- Evidence: export 1 min of footage, download, run the README's `sha256sum` + `openssl` checks, change one byte and verify it fails in the app (Evidence › Verify a pack).

## Switching off

```bash
sed -i '/^INVESTIGATE_INDEX_ENABLED=/d' .env && docker compose up -d smart-cam-ai
```

The account features can be switched off in the admin console at any time; the export log stays.

---

# Phases 2 and 3: what else switches on

All of these ride on the same index (step 2 above). Each has its own account switch in the admin console (Account control), off by default and marked **NEW**.

| Tool | Account switch | Server settings |
|---|---|---|
| I-3 Click to track (journeys, confirm/reject, stitched video) | Smart Search | — (stitched video uses footage recorded on this server) |
| I-4 Cases (pins, members, legal hold, kept footage) | Cases | `CASES_DIR` (default `/recordings/_cases`) |
| I-6 Smart Skim (density bar, play only activity) | Smart Search | — |
| I-7 Import video (phone, USB, other recorders) | Smart Search | `IMPORTS_DIR` (default `/recordings/_imports`), `IMPORT_MAX_BYTES` (default 8 GB) |
| I-8 Ask Drishyam, I-9 Summaries | Ask Drishyam & Summaries | `ASK_PROVIDER` (`auto` / `builtin`), optional Claude mode below |
| I-10 Vehicles (search, journeys) | Smart Search | `INVESTIGATE_VEHICLES_ENABLED` (default `true`) |

- **Legal hold** keeps a case's people in the index past retention, and copies their footage off the recorder (one pull at a time per user, 30 min max per item, SHA-256 while written).
- **Imported videos** are hashed while uploading and indexed on the GPU (about 4× faster than real time measured locally). Their people are dated from the recording time in the file (or what the uploader enters) and are kept until the import is deleted, not by age.
- **Vehicles** come from the same YOLO pass as people (car, motorcycle, bus, truck, bicycle; auto-rickshaws and tempos show up as one of those). Number plates need a plate-reading model that is not in the repo yet; vehicles are followed by appearance.

## Ask Drishyam: built-in or Claude

By default Ask Drishyam answers **on this server** with a rule-based planner (English and Hindi question shapes: when / how many / where / alerts / summary / find). It works air-gapped.

Claude mode lets Claude plan the tool calls and word the answer. It is used only when **both** are true:

1. the `@anthropic-ai/sdk` package is installed in the backend (`cd backend && npm install @anthropic-ai/sdk`, then commit `package.json` and `package-lock.json` through a PR), and
2. `ANTHROPIC_API_KEY` is set for the backend.

What it sends to Anthropic: the question and the tools' text results (camera names, times, counts, colours, match percentages). Never video or photos. `ASK_PROVIDER=builtin` keeps a server on built-in mode even with a key. Model: `ASK_CLAUDE_MODEL` (default `claude-opus-5-5`). If Claude can't be reached, the built-in planner answers instead.

Every answer's `[n]` citations are checked against what the tools returned; a citation no tool produced is removed.

## Phase 4: Later

- **Seen with (associations):** on a person's journey, "Seen with" lists who stayed within about 1.5 body heights of them for at least 3 s, here and at each confirmed stop. "Follow them" opens that person's journey. It is a lead, not proof they know each other.
- **Synopsis:** in Recordings, the clapperboard button makes one video of only the busy moments of the range on screen, sped up 2–16× (about 3 minutes long), with the real time burned in. It also works on an imported video (the Synopsis link on its page). It uses this server's recordings or the imported file, never the NVR. If this server has no recordings for that time, it says so. Encoding uses NVENC on GPU hosts. Finished reels are kept until the AI service restarts.
- **Audio search** (its own switch `investigate_audio`, off by default: speech is personal data, so switch it on only where recording audio is lawful and people are told). Speech becomes text only when someone asks: "Transcribe an imported video" on the Audio search page, or the speech button in Recordings (a range of at most 6 hours from this server's recordings). Search works by words in English or Hindi. Silent and noise-only stretches are skipped, so Whisper does not invent text. Camera transcripts age out with the index; import transcripts go when the import is deleted.
  Model: `openai/whisper-small` (MIT). Create the files once with `~/siglip-venv/bin/python ai/face-service/vms_face/investigate/tools/export_whisper.py --out data/ai-models/whisper` (about 1.1 GB). Without them, transcribing fails with a "model files missing" message.

## GPU

On an NVIDIA host the deploy adds `docker-compose.nvidia.yml` (`scripts/gpu-addon.sh`). With it: camera decode (`RTSP_HWACCEL=cuda`), detection and recognition (TensorRT), SigLIP (CUDA), imports (NVDEC + YOLO), and the MP4 re-encodes of Recordings › Export and evidence packs (NVENC) all run on the GPU.

The AI API has a freeze watchdog (`LOOP_FREEZE_EXIT_SEC`, default 120): if its event loop stops for that long it logs every thread's stack and exits, and the container restarts. A `Timeout (0:02:00)!` block in the logs means it fired: send that block to the team.
