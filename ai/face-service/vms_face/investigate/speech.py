"""Audio Search (investigation phase 4): what was said, as searchable text.

Whisper (exported to ONNX by tools/export_whisper.py) transcribes audio in
short chunks on the GPU. Each chunk with speech becomes a speech_segments row
(camera, start, end, text, language), searchable by words in any script.

Guards against the well-known Whisper failure of inventing text on silence:
  * chunks quieter than SILENCE_RMS are skipped without running the model;
  * chunks the model itself scores as "no speech" above NO_SPEECH_P are dropped.
Languages are limited (default English + Hindi) so language detection can't
wander to an unrelated language on accented speech.

Recording people's speech is sensitive: this only runs when someone asks for a
file or a time range, on an account that switched Audio Search on.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Sequence

import numpy as np

from vms_face.core.logging import get_logger

log = get_logger(__name__)

CHUNK_S = 15.0            # shorter than Whisper's 30 s window: a hit plays closer to the words
SILENCE_RMS = 0.006       # ~ -44 dBFS
NO_SPEECH_P = 0.6
MAX_TOKENS = 160


def log_mel(audio: np.ndarray, filters: np.ndarray, *, n_fft: int = 400, hop: int = 160, n_samples: int = 480_000) -> np.ndarray:
    """Whisper's log-Mel spectrogram (padded/trimmed to 30 s): (n_mels, 3000)."""
    a = np.zeros(n_samples, dtype=np.float32)
    a[: min(n_samples, len(audio))] = audio[:n_samples]
    pad = n_fft // 2
    a = np.pad(a, (pad, pad), mode="reflect")                 # torch.stft(center=True, pad_mode="reflect")
    window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n_fft) / n_fft)).astype(np.float32)   # periodic Hann
    n_frames = 1 + (len(a) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    spec = np.fft.rfft(a[idx] * window, axis=1)               # (frames, n_fft/2+1)
    power = (np.abs(spec) ** 2)[:-1].T                        # drop the last frame, (201, 3000)
    fb = filters if filters.shape[0] != power.shape[0] else filters.T   # HF stores (201, n_mels)
    mel = fb @ power
    log_spec = np.log10(np.maximum(mel, 1e-10))
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).astype(np.float32)


def rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if len(audio) else 0.0


class Transcriber:
    _shared: "Transcriber | None" = None
    _shared_lock = threading.Lock()

    def __init__(self, model_dir: str | Path, *, languages: Sequence[str] = ("en", "hi")) -> None:
        d = Path(model_dir)
        missing = [f for f in ("encoder.onnx", "decoder.onnx", "tokenizer.json", "mel_filters.npy", "meta.json") if not (d / f).exists()]
        if missing:
            raise FileNotFoundError(f"Whisper model files missing in {d}: {missing}. Create them with tools/export_whisper.py.")
        from tokenizers import Tokenizer

        from vms_face.investigate.embedder import _session

        self.meta = json.loads((d / "meta.json").read_text())
        self.filters = np.load(d / "mel_filters.npy")
        self.tok = Tokenizer.from_file(str(d / "tokenizer.json"))
        self.sp = self.meta["special"]
        self.langs = {k: v for k, v in self.meta["languages"].items() if not languages or k in languages}
        self.sr = int(self.meta["sampling_rate"])
        self._enc = _session(d / "encoder.onnx", None)
        self._dec = _session(d / "decoder.onnx", None)
        self._lock = threading.Lock()
        log.info("whisper loaded", model=self.meta.get("model"), languages=sorted(self.langs))

    @classmethod
    def shared(cls) -> "Transcriber":
        if cls._shared is None:
            with cls._shared_lock:
                if cls._shared is None:
                    from vms_face.config import settings

                    cls._shared = cls(settings.investigate_speech_model_dir,
                                      languages=[x.strip() for x in settings.investigate_speech_languages.split(",") if x.strip()])
        return cls._shared

    @property
    def model_tag(self) -> str:
        return f"{self.meta.get('model')}@{(self.meta.get('revision') or 'unknown')[:12]}"

    def _decoder(self, ids: list[int], enc: np.ndarray) -> np.ndarray:
        return self._dec.run(None, {"input_ids": np.asarray([ids], dtype=np.int64), "encoder_hidden_states": enc})[0][0, -1]

    def transcribe_chunk(self, audio: np.ndarray) -> dict | None:
        """Text of one ≤30 s chunk of 16 kHz mono audio, or None when there is no speech."""
        if rms(audio) < SILENCE_RMS:
            return None
        feats = log_mel(audio, self.filters, n_fft=self.meta["n_fft"], hop=self.meta["hop_length"],
                        n_samples=self.meta["n_samples"])[None]
        with self._lock:
            enc = self._enc.run(None, {"input_features": feats})[0]
            sot = self.sp["<|startoftranscript|>"]
            first = self._decoder([sot], enc)
            p = np.exp(first - first.max())
            p /= p.sum()
            if self.meta.get("nospeech") is not None and p[self.meta["nospeech"]] > NO_SPEECH_P:
                return None
            lang = max(self.langs.items(), key=lambda kv: first[kv[1]])[0] if self.langs else "en"
            ids = [sot, self.langs.get(lang, self.meta["languages"].get("en")), self.sp["<|transcribe|>"], self.sp["<|notimestamps|>"]]
            out: list[int] = []
            eot = self.sp["<|endoftext|>"]
            for _ in range(MAX_TOKENS):
                logits = self._decoder(ids + out, enc)
                nxt = int(logits.argmax())
                if nxt >= eot:                     # end of text, or any special token (all sit at/after <|endoftext|>)
                    break
                out.append(nxt)
                if len(out) >= 8 and len(set(out[-8:])) <= 2:   # stuck repeating
                    break
        text = self.tok.decode(out, skip_special_tokens=True).strip()
        return {"text": text, "lang": lang} if text else None

    def transcribe(self, audio: np.ndarray, *, chunk_s: float = CHUNK_S) -> list[dict]:
        """[{start_s, end_s, text, lang}] for 16 kHz mono float32 audio."""
        step = int(chunk_s * self.sr)
        out = []
        for i in range(0, len(audio), step):
            piece = audio[i: i + step]
            r = self.transcribe_chunk(piece)
            if r:
                out.append({"start_s": i / self.sr, "end_s": (i + len(piece)) / self.sr, **r})
        return out


def read_audio(path: str, seek_s: float = 0.0, take_s: float | None = None, sr: int = 16_000) -> np.ndarray:
    """Mono float32 PCM at `sr` from any file ffmpeg can read (empty if it has no audio)."""
    import subprocess

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{seek_s:.3f}"]
    if take_s:
        cmd += ["-t", f"{take_s:.3f}"]
    cmd += ["-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "pipe:1"]
    r = subprocess.run(cmd, capture_output=True, timeout=1800)
    return np.frombuffer(r.stdout, dtype=np.float32).copy() if r.returncode == 0 else np.zeros(0, np.float32)


# ── jobs: transcribe an imported file or a recorded range ──────────────

import asyncio  # noqa: E402
import datetime as dt  # noqa: E402
import time  # noqa: E402
import uuid  # noqa: E402
from dataclasses import dataclass, field  # noqa: E402


@dataclass
class SpeechJob:
    job_id: str
    tenant_id: uuid.UUID
    camera_id: uuid.UUID
    camera_code: str
    since: dt.datetime
    until: dt.datetime
    status: str = "queued"           # queued | transcribing | ready | failed
    progress: float = 0.0
    segments: int = 0
    error: str | None = None
    took_s: float | None = None
    created: float = field(default_factory=time.time)

    def view(self) -> dict:
        return {"job_id": self.job_id, "status": self.status, "progress": round(self.progress, 3), "segments": self.segments,
                "error": self.error, "took_s": self.took_s, "camera_code": self.camera_code,
                "since": self.since.isoformat(), "until": self.until.isoformat()}


_jobs: dict[str, SpeechJob] = {}
_job_lock = threading.Lock()


def get_job(job_id: str) -> SpeechJob | None:
    return _jobs.get(job_id)


def start_job(job: SpeechJob, pieces: list[tuple[str, float, float, dt.datetime]], source: str,
              loop: asyncio.AbstractEventLoop) -> SpeechJob:
    """pieces: (path, seek_s, take_s, real start). One job at a time, background thread."""
    _jobs[job.job_id] = job

    async def save(rows: list[dict]) -> None:
        from sqlalchemy import delete

        from vms_face.domain.models import SpeechSegment
        from vms_face.infra.postgres import session_scope

        async with session_scope() as s:
            # Transcribing the same stretch again replaces what was there.
            await s.execute(delete(SpeechSegment).where(
                SpeechSegment.tenant_id == job.tenant_id, SpeechSegment.camera_id == job.camera_id,
                SpeechSegment.start_ts >= job.since, SpeechSegment.start_ts < job.until))
            for r in rows:
                s.add(SpeechSegment(tenant_id=job.tenant_id, camera_id=job.camera_id, source=source, **r))

    def run() -> None:
        with _job_lock:
            t0 = time.time()
            job.status = "transcribing"
            try:
                tr = Transcriber.shared()
                rows: list[dict] = []
                total = sum(p[2] for p in pieces) or 1.0
                done = 0.0
                for path, seek, take, real_start in pieces:
                    audio = read_audio(path, seek, take, tr.sr)
                    for seg in tr.transcribe(audio):
                        rows.append({
                            "start_ts": real_start + dt.timedelta(seconds=seg["start_s"]),
                            "end_ts": real_start + dt.timedelta(seconds=seg["end_s"]),
                            "text": seg["text"][:4000], "lang": seg["lang"], "model_info": {"asr": tr.model_tag},
                        })
                    done += take
                    job.progress = min(0.99, done / total)
                asyncio.run_coroutine_threadsafe(save(rows), loop).result()
                job.segments, job.status, job.progress = len(rows), "ready", 1.0
            except Exception as e:
                job.status, job.error = "failed", str(e)[:400]
                log.warning("speech job failed", job=job.job_id, err=str(e))
            finally:
                job.took_s = round(time.time() - t0, 1)

    threading.Thread(target=run, name=f"speech-{job.job_id[:8]}", daemon=True).start()
    return job
