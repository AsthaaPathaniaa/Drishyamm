"""Export SigLIP 2 (image + text towers) to ONNX for the investigation index.

The AI image runs ONNX Runtime and has no PyTorch, so the model is exported
once on a machine that has it, and the files are copied to the AI service's
model folder (``data/ai-models/siglip2/`` on the host = ``/srv/data/models/siglip2``
in the container):

    python3 -m venv ~/siglip-venv
    ~/siglip-venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
    ~/siglip-venv/bin/pip install transformers sentencepiece protobuf onnx onnxruntime tokenizers pillow
    ~/siglip-venv/bin/python ai/face-service/vms_face/investigate/tools/export_siglip.py --out data/ai-models/siglip2

Writes ``vision.onnx``, ``text.onnx``, ``tokenizer.json`` and ``meta.json``
(model id + exact revision, embedding size, preprocessing, the sigmoid
scale/bias that turns a similarity into a match score). The script then runs
both ONNX files and refuses to finish unless they match PyTorch.

Licence: google/siglip2-* weights are Apache-2.0 (docs/investigation/LICENCES.md).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_MODEL = "google/siglip2-base-patch16-224"
TEXT_LEN = 64          # SigLIP is trained with text padded to 64 tokens, no attention mask


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=DEFAULT_MODEL, help="hub id or a local folder with the downloaded files")
    ap.add_argument("--model-id", default=None, help="hub id to record in meta.json when --model is a local folder")
    ap.add_argument("--revision", default=None, help="pin a hub revision (default: latest)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    import numpy as np
    import onnxruntime as ort
    import torch
    from PIL import Image
    from transformers import AutoModel, AutoProcessor

    args.out.mkdir(parents=True, exist_ok=True)
    model = AutoModel.from_pretrained(args.model, revision=args.revision, torch_dtype=torch.float32).eval()
    processor = AutoProcessor.from_pretrained(args.model, revision=args.revision)
    ip = processor.image_processor
    size = ip.size.get("height") or ip.size.get("shortest_edge")

    class Vision(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            out = self.m.get_image_features(pixel_values=pixel_values)
            return getattr(out, "pooler_output", out)

    class Text(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids):
            out = self.m.get_text_features(input_ids=input_ids)
            return getattr(out, "pooler_output", out)

    pixels = torch.zeros(1, 3, size, size)
    ids = torch.ones(1, TEXT_LEN, dtype=torch.long)
    common = dict(opset_version=args.opset, do_constant_folding=True, dynamo=False)
    torch.onnx.export(Vision(model), (pixels,), str(args.out / "vision.onnx"), input_names=["pixel_values"],
                      output_names=["image_embeds"], dynamic_axes={"pixel_values": {0: "n"}, "image_embeds": {0: "n"}}, **common)
    torch.onnx.export(Text(model), (ids,), str(args.out / "text.onnx"), input_names=["input_ids"],
                      output_names=["text_embeds"], dynamic_axes={"input_ids": {0: "n"}, "text_embeds": {0: "n"}}, **common)
    processor.tokenizer.backend_tokenizer.save(str(args.out / "tokenizer.json"))

    tok = processor.tokenizer
    meta = {
        "model": args.model_id or args.model,
        "revision": getattr(model.config, "_commit_hash", None) or args.revision,
        "licence": "Apache-2.0",
        "dim": int(model.config.text_config.projection_size if hasattr(model.config.text_config, "projection_size")
                   else model.config.text_config.hidden_size),
        "image_size": int(size),
        "image_mean": list(map(float, ip.image_mean)),
        "image_std": list(map(float, ip.image_std)),
        "resample": "bicubic" if int(getattr(ip, "resample", 3)) == 3 else "bilinear",
        "text_len": TEXT_LEN,
        "pad_id": int(tok.pad_token_id),
        "eos_id": int(tok.eos_token_id) if tok.eos_token_id is not None else None,
        "lowercase": True,
        "logit_scale": float(model.logit_scale.exp().item()),
        "logit_bias": float(model.logit_bias.item()),
    }

    # Parity: a real image + a few queries through PyTorch and through ONNX.
    rng = np.random.default_rng(0)
    img = Image.fromarray(rng.integers(0, 255, (300, 200, 3), dtype=np.uint8))
    texts = ["a person in a red top with a backpack", "लाल शर्ट वाला आदमी", "a white car"]
    with torch.no_grad():
        inp = processor(text=texts, images=[img], padding="max_length", max_length=TEXT_LEN, return_tensors="pt")
        t_img = Vision(model)(inp["pixel_values"]).numpy()
        t_txt = Text(model)(inp["input_ids"]).numpy()
    o_img = ort.InferenceSession(str(args.out / "vision.onnx")).run(None, {"pixel_values": inp["pixel_values"].numpy()})[0]
    o_txt = ort.InferenceSession(str(args.out / "text.onnx")).run(None, {"input_ids": inp["input_ids"].numpy()})[0]

    def cos(a, b):
        a = a / np.linalg.norm(a, axis=-1, keepdims=True)
        b = b / np.linalg.norm(b, axis=-1, keepdims=True)
        return float((a * b).sum(-1).min())

    parity = {"image": cos(t_img, o_img), "text": cos(t_txt, o_txt)}
    meta["dim"] = int(o_img.shape[-1])
    meta["parity_min_cosine"] = parity
    meta["sample_input_ids"] = inp["input_ids"][:1].tolist()[0]     # lets the runtime tokenizer be checked
    meta["sample_text"] = texts[0]
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print(json.dumps({k: meta[k] for k in ("model", "revision", "dim", "image_size", "parity_min_cosine")}, indent=2))
    if min(parity.values()) < 0.999:
        print("ONNX output does not match PyTorch", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
