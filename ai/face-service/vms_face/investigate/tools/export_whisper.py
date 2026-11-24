"""Export Whisper (encoder + decoder) to ONNX for Audio Search (phase 4).

Like export_siglip.py: the AI image has no PyTorch, so export once on a
machine that has it and copy the folder to the AI's model directory
(host data/ai-models/whisper/ = /srv/data/models/whisper in the container):

    ~/siglip-venv/bin/python ai/face-service/vms_face/investigate/tools/export_whisper.py \\
        --model openai/whisper-small --out data/ai-models/whisper

Writes encoder.onnx, decoder.onnx (no KV cache: simple and exact), tokenizer.json,
mel_filters.npy and meta.json (special token ids, audio settings, model id +
revision), then checks both ONNX graphs against PyTorch.

Licence: openai/whisper-* weights are MIT.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="openai/whisper-small", help="hub id or local folder")
    ap.add_argument("--model-id", default=None, help="hub id to record when --model is a local folder")
    ap.add_argument("--revision", default=None)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    import numpy as np
    import onnxruntime as ort
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    args.out.mkdir(parents=True, exist_ok=True)
    model = WhisperForConditionalGeneration.from_pretrained(args.model, revision=args.revision, torch_dtype=torch.float32).eval()
    proc = WhisperProcessor.from_pretrained(args.model, revision=args.revision)
    fe, tok = proc.feature_extractor, proc.tokenizer

    class Encoder(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_features):
            return self.m.model.encoder(input_features=input_features).last_hidden_state

    class Decoder(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids, encoder_hidden_states):
            h = self.m.model.decoder(input_ids=input_ids, encoder_hidden_states=encoder_hidden_states).last_hidden_state
            return self.m.proj_out(h)

    n_mels = int(fe.feature_size)
    feats = torch.zeros(1, n_mels, 3000)
    common = dict(opset_version=args.opset, do_constant_folding=True, dynamo=False)
    torch.onnx.export(Encoder(model), (feats,), str(args.out / "encoder.onnx"), input_names=["input_features"],
                      output_names=["encoder_hidden_states"], dynamic_axes={"input_features": {0: "n"}, "encoder_hidden_states": {0: "n"}}, **common)
    with torch.no_grad():
        enc = Encoder(model)(feats)
    ids = torch.tensor([[tok.convert_tokens_to_ids("<|startoftranscript|>")] * 4])
    torch.onnx.export(Decoder(model), (ids, enc), str(args.out / "decoder.onnx"), input_names=["input_ids", "encoder_hidden_states"],
                      output_names=["logits"], dynamic_axes={"input_ids": {0: "n", 1: "t"}, "encoder_hidden_states": {0: "n"}, "logits": {0: "n", 1: "t"}}, **common)
    tok.backend_tokenizer.save(str(args.out / "tokenizer.json"))
    np.save(args.out / "mel_filters.npy", np.asarray(fe.mel_filters, dtype=np.float32))

    special = {t: tok.convert_tokens_to_ids(t) for t in
               ("<|startoftranscript|>", "<|endoftext|>", "<|transcribe|>", "<|translate|>", "<|notimestamps|>")}
    nospeech = next((tok.convert_tokens_to_ids(t) for t in ("<|nospeech|>", "<|nocaptions|>")
                     if tok.convert_tokens_to_ids(t) not in (None, tok.unk_token_id)), None)
    langs = {t[2:-2]: i for t, i in tok.get_vocab().items() if len(t) <= 9 and t.startswith("<|") and t.endswith("|>")
             and t[2:-2].isalpha() and t[2:-2].islower() and len(t[2:-2]) in (2, 3) and t[2:-2] not in ("en_", )}

    # Parity: random features through PyTorch and ONNX.
    rng = np.random.default_rng(0)
    x = torch.from_numpy(rng.standard_normal((1, n_mels, 3000)).astype(np.float32) * 0.5)
    with torch.no_grad():
        t_enc = Encoder(model)(x).numpy()
        t_log = Decoder(model)(ids, torch.from_numpy(t_enc)).numpy()
    o_enc = ort.InferenceSession(str(args.out / "encoder.onnx")).run(None, {"input_features": x.numpy()})[0]
    o_log = ort.InferenceSession(str(args.out / "decoder.onnx")).run(None, {"input_ids": ids.numpy(), "encoder_hidden_states": t_enc})[0]
    # Relative: encoder states are tens of units in size, so float32 rounding alone exceeds a fixed 1e-3.
    parity = {"encoder_max_abs": float(np.abs(t_enc - o_enc).max()),
              "encoder_rel": float(np.abs(t_enc - o_enc).max() / max(1e-6, float(np.abs(t_enc).max()))),
              "decoder_argmax_equal": bool((t_log.argmax(-1) == o_log.argmax(-1)).all())}

    meta = {
        "model": args.model_id or args.model,
        "revision": getattr(model.config, "_commit_hash", None) or args.revision,
        "licence": "MIT",
        "sampling_rate": int(fe.sampling_rate), "n_fft": int(fe.n_fft), "hop_length": int(fe.hop_length),
        "chunk_length": int(fe.chunk_length), "n_mels": n_mels, "n_samples": int(fe.n_samples),
        "special": special, "nospeech": nospeech, "languages": langs,
        "max_target_positions": int(model.config.max_target_positions), "parity": parity,
    }
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps({k: meta[k] for k in ("model", "revision", "n_mels", "nospeech", "parity")}, indent=2), "languages:", len(langs))
    if parity["encoder_rel"] > 1e-4 or not parity["decoder_argmax_equal"]:
        print("ONNX output does not match PyTorch", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
