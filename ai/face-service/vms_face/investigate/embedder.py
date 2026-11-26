"""SigLIP 2 image/text embedder on ONNX Runtime (no PyTorch in the AI image).

One model gives both halves of Smart Search:
  * ``embed_images(crops)``  → the fingerprint stored per track in ``vms_tracks``
  * ``embed_texts(queries)`` → the query vector ("man in red top with backpack",
    also Hindi: SigLIP 2's text side is multilingual)
Both are L2-normalised, so cosine similarity = dot product, and
``match_score(cos)`` turns it into SigLIP's own calibrated sigmoid
probability (shown in the UI as "91 % match").

Files come from ``tools/export_siglip.py`` (vision.onnx, text.onnx,
tokenizer.json, meta.json) in ``settings.investigate_embed_model_dir``.
``meta.json`` carries the model id + revision, which every derived track
records (forensic rule 16) via :attr:`model_tag`.
"""
from __future__ import annotations

import json
import math
import threading
from pathlib import Path
from typing import Sequence

import cv2
import numpy as np

from vms_face.core.logging import get_logger

log = get_logger(__name__)

_INTERP = {"bicubic": cv2.INTER_CUBIC, "bilinear": cv2.INTER_LINEAR}


def _l2(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return (x / np.maximum(n, 1e-12)).astype(np.float32)


class TextTokenizer:
    """SigLIP text input: lowercase, tokenise, truncate/pad to a fixed length
    (SigLIP is trained on padded text with no attention mask)."""

    def __init__(self, tokenizer_json: Path, *, text_len: int, pad_id: int, lowercase: bool = True) -> None:
        from tokenizers import Tokenizer

        self._tok = Tokenizer.from_file(str(tokenizer_json))
        self._tok.no_padding()
        self._tok.no_truncation()
        self.text_len = int(text_len)
        self.pad_id = int(pad_id)
        self.lowercase = lowercase

    def __call__(self, texts: Sequence[str]) -> np.ndarray:
        out = np.full((len(texts), self.text_len), self.pad_id, dtype=np.int64)
        for i, t in enumerate(texts):
            ids = self._tok.encode(t.lower() if self.lowercase else t).ids[: self.text_len]
            out[i, : len(ids)] = ids
        return out


class SiglipEmbedder:
    _shared: "SiglipEmbedder | None" = None
    _shared_lock = threading.Lock()

    def __init__(self, model_dir: str | Path, *, providers: list[str] | None = None) -> None:
        d = Path(model_dir)
        missing = [f for f in ("vision.onnx", "text.onnx", "tokenizer.json", "meta.json") if not (d / f).exists()]
        if missing:
            raise FileNotFoundError(
                f"SigLIP model files missing in {d}: {missing}. "
                "Create them with vms_face/investigate/tools/export_siglip.py."
            )
        self.meta = json.loads((d / "meta.json").read_text())
        self.dim = int(self.meta["dim"])
        self.image_size = int(self.meta["image_size"])
        self._mean = np.asarray(self.meta["image_mean"], dtype=np.float32).reshape(3, 1, 1)
        self._std = np.asarray(self.meta["image_std"], dtype=np.float32).reshape(3, 1, 1)
        self._interp = _INTERP.get(self.meta.get("resample", "bicubic"), cv2.INTER_CUBIC)
        self._scale = float(self.meta["logit_scale"])
        self._bias = float(self.meta["logit_bias"])
        self.tokenizer = TextTokenizer(d / "tokenizer.json", text_len=self.meta["text_len"],
                                       pad_id=self.meta["pad_id"], lowercase=self.meta.get("lowercase", True))

        self._vision = _session(d / "vision.onnx", providers)
        self._text = _session(d / "text.onnx", providers)
        self._vision_lock = threading.Lock()
        self._text_lock = threading.Lock()
        log.info("siglip embedder loaded", model=self.meta.get("model"), revision=self.meta.get("revision"), dim=self.dim)

    @classmethod
    def shared(cls) -> "SiglipEmbedder":
        if cls._shared is None:
            with cls._shared_lock:
                if cls._shared is None:
                    from vms_face.config import settings

                    cls._shared = cls(settings.investigate_embed_model_dir)
        return cls._shared

    @property
    def model_tag(self) -> str:
        rev = (self.meta.get("revision") or "unknown")[:12]
        return f"{self.meta.get('model')}@{rev}"

    def preprocess(self, crops_bgr: Sequence[np.ndarray]) -> np.ndarray:
        s = self.image_size
        batch = np.empty((len(crops_bgr), 3, s, s), dtype=np.float32)
        for i, crop in enumerate(crops_bgr):
            rgb = cv2.cvtColor(cv2.resize(crop, (s, s), interpolation=self._interp), cv2.COLOR_BGR2RGB)
            x = rgb.astype(np.float32).transpose(2, 0, 1) / 255.0
            batch[i] = (x - self._mean) / self._std
        return batch

    def embed_images(self, crops_bgr: Sequence[np.ndarray]) -> np.ndarray:
        """(N, dim) L2-normalised image fingerprints for BGR crops."""
        if not crops_bgr:
            return np.zeros((0, self.dim), dtype=np.float32)
        x = self.preprocess(crops_bgr)
        with self._vision_lock:
            out = self._vision.run(None, {"pixel_values": x})[0]
        return _l2(out)

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        """(N, dim) L2-normalised text vectors."""
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        ids = self.tokenizer(texts)
        with self._text_lock:
            out = self._text.run(None, {"input_ids": ids})[0]
        return _l2(out)

    def match_score(self, cosine: float) -> float:
        """SigLIP's calibrated probability that the text describes the image."""
        return match_score(cosine, self._scale, self._bias)

    def classify(self, image_vecs: np.ndarray, labels: Sequence[str], template: str) -> list[tuple[str, float]]:
        """Zero-shot label per image: the label whose prompt fits best, and
        its softmax share among the labels (a confidence, 0..1)."""
        key = (template, tuple(labels))
        tv = self._prompt_cache.get(key) if hasattr(self, "_prompt_cache") else None
        if tv is None:
            if not hasattr(self, "_prompt_cache"):
                self._prompt_cache = {}
            tv = self._prompt_cache[key] = self.embed_texts([template.format(c=l) for l in labels])
        logits = (np.asarray(image_vecs) @ tv.T) * self._scale
        p = np.exp(logits - logits.max(axis=1, keepdims=True))
        p /= p.sum(axis=1, keepdims=True)
        return [(labels[int(i)], float(row[int(i)])) for row, i in zip(p, p.argmax(axis=1))]


def _session(path: Path, requested: list[str] | None):
    """The service's provider policy (CUDA when usable, else CPU), minus
    TensorRT: batches vary in size and TensorRT would rebuild an engine per
    shape."""
    import onnxruntime as ort

    from vms_face.infra.ort_session import providers_for, session_options

    from vms_face.infra.cuda_gate import cuda_init_gate

    names, opts = providers_for(path, requested=requested, kind="generic")
    keep = [i for i, n in enumerate(names) if n != "TensorrtExecutionProvider"]
    # Box-wide CUDA context gate, like every other session (infra/cuda_gate.py):
    # creating a context while NVDEC decoders start hangs or crashes the WSL2
    # GPU driver. Without it the API process froze on 2026-11-24.
    with cuda_init_gate(f"ort session {path.name}"):
        sess = ort.InferenceSession(str(path), sess_options=session_options(),
                                    providers=[names[i] for i in keep], provider_options=[opts[i] for i in keep])
    log.info("onnx session", model=path.name, provider=sess.get_providers()[0], kind="siglip")
    return sess


def match_score(cosine: float, scale: float, bias: float) -> float:
    z = cosine * scale + bias
    return 1.0 / (1.0 + math.exp(-z)) if z > -50 else 0.0
