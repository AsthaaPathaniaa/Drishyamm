# Model and dataset licence check (investigation toolkit)

Rule 10 of the plan: check the commercial licence of every model weight and dataset before shipping. This is the engineering check from 2026-11-14. It is **not legal advice**: have a lawyer confirm each "needs licence" row before the toolkit is sold.

**Statuses:**
- ✅ OK to ship.
- ⚠️ Needs a commercial licence or a replacement before customer rollout. Fine for internal tests.
- ❓ Still to confirm.

## Models the investigation toolkit plans to use

| Model | Used for | Licence | Status | Notes |
|---|---|---|---|---|
| `models/person/yolov8n.pt` / `.onnx` | Person boxes (I-1 faceless tracks, phase 0 meter) | **AGPL-3.0** (Ultralytics; licence string is inside the file) | ⚠️ | Stock Ultralytics COCO model (2022-12-30, v8.0.0.dev0), not fine-tuned. Ultralytics' position is that models trained or exported with their software are AGPL too, unless covered by an Ultralytics Enterprise licence. |
| `models/trained/person-yolov8m-legacy/best.pt` | Candidate person model (fine-tuned, single class) | AGPL-3.0 (trained with Ultralytics 8.4.x) | ⚠️ | Same issue as above. Its single-class output works with the current detector parser after ONNX export. Heavier (YOLOv8m). |
| `models/trained/crowd-people-yolo26m/...best.pt` | Candidate people model | AGPL-3.0 (Ultralytics 8.4.x, YOLO26) | ⚠️ | YOLO26 outputs NMS-free boxes, so it needs a parser change before use. |
| `google/siglip-base-patch16-224` | I-1 image fingerprint + I-2 text search (candidate) | **Apache-2.0** | ✅ | Preferred candidate. SigLIP 2 checkpoints are also Apache-2.0. |
| `laion/CLIP-ViT-B-32-laion2B-s34B-b79K` | I-1 / I-2 (candidate for comparison) | MIT (weights), LAION-2B training data | ❓ | The weights' licence is permissive. The training-data provenance (LAION) is a reputational and legal question for a forensic product: prefer SigLIP unless it clearly wins. |
| OpenAI CLIP | — | MIT, but its model card says deployed use (and surveillance specifically) is out of scope | ❌ Don't use | |
| `osnet_x1_0_msmt17.onnx` | Body ReID (existing journey; I-2 grouping, I-3 seeds) | Code MIT (torchreid). Weights trained on **MSMT17**, a research-only dataset | ⚠️ | Already shipping in Drishyam. Retrain on our own labelled data, or confirm dataset terms. |
| Pedestrian attribute datasets (PA-100K, PETA, RAP) | I-1 attribute heads | Research / non-commercial | ⚠️ | The plan already says: train attribute heads on our own labelled crops. |

## Drishyam models outside the toolkit, flagged during this check

| Model | Licence | Status | Notes |
|---|---|---|---|
| InsightFace `buffalo_l` / `buffalo_sc` (SCRFD `det_10g`, `w600k_r50`, `w600k_mbf`, `genderage`, landmarks) | InsightFace pretrained models are released for **non-commercial research only** | ⚠️ **High priority** | This is the core face pipeline Drishyam sells today, so it isn't only an investigation-toolkit question. Commercial licensing is available from InsightFace, or the models can be replaced. |

## Permissive alternatives for person / vehicle detection

If an Ultralytics Enterprise licence isn't bought, these detectors carry Apache-2.0 code and weights. Check each checkpoint's own card before use.

| Option | Licence | Note |
|---|---|---|
| YOLOX (Megvii) | Apache-2.0 | YOLO-style, easy ONNX export, slightly older |
| RT-DETR (original repo) | Apache-2.0 | Transformer detector, real-time on GPU |
| D-FINE | Apache-2.0 | Strong accuracy and speed |
| RF-DETR (Roboflow, base sizes) | Apache-2.0 | Check which sizes are Apache vs. other terms |
| RTMDet (MMDetection) | Apache-2.0 | Mature toolchain |

COCO-trained checkpoints: COCO annotations are CC BY 4.0, and the images come from Flickr under various terms. COCO-trained weights are widely used commercially, but legal should confirm.

## Decisions needed

1. **Person detector for I-1:** buy an Ultralytics Enterprise licence (this also covers the 10+ other YOLO models under `models/trained/`), **or** move to a permissive detector. Phase 0 measures with `yolov8n` either way.
2. **Image fingerprint model:** SigLIP (Apache-2.0) unless the phase 0 spike shows another model is clearly better.
3. **InsightFace and OSNet:** a company-level decision, outside the toolkit, but it blocks "forensic-grade and sellable".
