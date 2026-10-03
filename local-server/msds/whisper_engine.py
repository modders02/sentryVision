"""Shared, lazily-loaded Whisper engine (one model for all cameras)."""
from __future__ import annotations

import sys
import threading
from typing import Optional

import re

from .binaries import pip_install_command
from .config import (WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE,
                     WHISPER_LANGUAGE, WHISPER_CPU_THREADS)
from .streaming_audio import pcm_rms

# Non-speech annotations. Ordinary words are never banned just because Whisper
# sometimes hallucinates them; acoustic confidence and VAD do that filtering.
HALLUCINATION_PATTERNS = [
    r"^\.*$",
    r"^\[.*\]$",
    r"^\(.*\)$",
    r"^♪+.*♪*$",
]
_HALLUCINATION_RE = [re.compile(p, re.IGNORECASE) for p in HALLUCINATION_PATTERNS]

# Short distress words must never be filtered out as "too short / noise".
KEEP_ALWAYS = {
    "help", "fire", "stop", "police", "tulong", "saklolo", "sunog", "aray",
    "pulis", "ambulansya", "masakit", "huwag", "wag",
}


def _normalise_repetition(text: str) -> str:
    """Normalize whitespace, retaining repetitions actually spoken by a user.

    Silencing a repeated "help" or deleting ordinary phrases makes transcripts
    less faithful. Acoustic evidence rejects decoder loops before this step.
    """
    return " ".join(text.split())


def is_hallucination(text: str) -> bool:
    stripped = text.strip()
    if stripped.lower().strip(" .!?,").replace("!", "") in KEEP_ALWAYS:
        return False
    if not any(char.isalnum() for char in stripped):
        return True
    return any(rx.match(stripped) for rx in _HALLUCINATION_RE)


def _is_repetition_loop(segment, audio_duration: float = 0.0) -> bool:
    """Reject compressed decoder loops at an implausible speaking rate.

    Repetition alone is legitimate speech, including repeated calls for help.
    Require both Whisper's compression warning and more than eight words per
    second, with at least twelve words, rather than shortening the transcript.
    """
    if getattr(segment, "compression_ratio", 0.0) <= 2.4:
        return False
    words = re.findall(r"\w+(?:['’]\w+)*", segment.text or "")
    if len(words) < 12:
        return False
    duration = max(0.0, getattr(segment, "end", 0.0) - getattr(segment, "start", 0.0))
    if audio_duration > 0:
        duration = min(duration, audio_duration) if duration > 0 else audio_duration
    return duration > 0 and len(words) / max(0.1, duration) > 8.0


class WhisperEngine:
    """`state` distinguishes:
      - "package_missing"  -> faster-whisper is not installed in THIS interpreter
      - "model_error"      -> package present but model download/load failed
      - "loading"          -> model is being fetched/loaded right now
      - "ready" / "idle"   -> usable
    """

    def __init__(self) -> None:
        self.model = None
        self.model_name = WHISPER_MODEL
        self.available = False
        self.state = "idle"
        self.error: Optional[str] = None
        self.lock = threading.Lock()
        try:
            from faster_whisper import WhisperModel  # noqa: F401
            self.available = True
        except Exception as exc:
            self.available = False
            self.state = "package_missing"
            self.error = (
                f"faster-whisper is not installed in this Python ({sys.executable}): {exc}. "
                f"Install it into the SAME interpreter with:  {pip_install_command()}"
            )

    def load(self):
        if self.model is not None:
            return self.model
        if not self.available:
            raise RuntimeError(self.error or "faster-whisper is not installed")
        with self.lock:
            if self.model is None:
                from faster_whisper import WhisperModel
                self.state = "loading"
                try:
                    self.model = WhisperModel(
                        WHISPER_MODEL, device=WHISPER_DEVICE,
                        compute_type=WHISPER_COMPUTE_TYPE, cpu_threads=WHISPER_CPU_THREADS,
                    )
                    self.error = None
                    self.state = "ready"
                except Exception as exc:
                    self.state = "model_error"
                    self.error = (
                        f"Whisper model '{WHISPER_MODEL}' could not be loaded/downloaded: {exc}. "
                        "The first run needs internet access to fetch the model; "
                        "set MSD_WHISPER_MODEL=tiny for a smaller download."
                    )
                    raise RuntimeError(self.error) from exc
        return self.model

    def transcribe(self, wav_path: str) -> str:
        return self._transcribe(wav_path)

    def transcribe_pcm(self, pcm: bytes) -> str:
        """Decode one finalized 16 kHz mono s16le phrase without a disk WAV."""
        # Never run an acoustic decoder on empty/digital-silent input, even if
        # a diagnostic or reconnect bypasses the live segmenter.
        if not pcm or pcm_rms(pcm) < 1e-5:
            return ""
        import numpy as np
        audio = np.frombuffer(pcm[:len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32) / 32768.0
        return self._transcribe(audio)

    def _transcribe(self, audio) -> str:
        if not self.available:
            raise RuntimeError(self.error or "faster-whisper is not installed")
        model = self.load()
        with self.lock:
            segments, info = model.transcribe(
                audio,
                language=WHISPER_LANGUAGE,  # auto-detect unless explicitly configured
                task="transcribe",          # never translate — keep "tulong" as "tulong"
                vad_filter=True,
                vad_parameters={
                    "min_silence_duration_ms": 200,
                    "threshold": 0.5,        # Silero's default speech threshold
                    "min_speech_duration_ms": 100,
                    "speech_pad_ms": 150,
                },
                condition_on_previous_text=False,  # stops repeat/echo hallucinations
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                # Retry compressed/low-confidence output with modest sampling
                # instead of returning a deterministic repetition loop.
                temperature=(0.0, 0.2, 0.4),
                compression_ratio_threshold=2.4,
                beam_size=5,
                word_timestamps=True,
                hallucination_silence_threshold=0.8,
                # No safety hotword prompt: it can invent an emergency in noise.
                initial_prompt=None,
            )
            if getattr(info, "duration_after_vad", None) == 0:
                return ""
            kept = []
            for seg in segments:
                text = (seg.text or "").strip()
                if not text:
                    continue
                if getattr(seg, "no_speech_prob", 0.0) > 0.85:
                    continue
                if getattr(seg, "avg_logprob", 0.0) < -1.0:
                    continue
                if is_hallucination(text):
                    continue
                if _is_repetition_loop(seg, getattr(info, "duration", 0.0)):
                    continue
                kept.append(text)
            return _normalise_repetition(" ".join(kept).strip())


WHISPER = WhisperEngine()
