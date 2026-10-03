"""Bounded, finalized PCM transcription without blocking camera capture.

Energy segmentation is only a cheap silence gate; the recognizer's VAD still
decides whether the audio contains speech. Each independent phrase is decoded
once after silence or a bounded context window, with no generated drafts.
"""
from __future__ import annotations

from array import array
from collections import deque
from dataclasses import dataclass
import math
import sys
import threading
import time
from typing import Optional

PCM_BYTES_PER_SECOND = 32000
FRAME_BYTES = 640  # 20 ms at 16 kHz, signed 16-bit mono


@dataclass(frozen=True)
class CaptionJob:
    pcm: bytes
    utterance_id: int
    is_final: bool
    captured_at: float


def pcm_rms(data: bytes) -> float:
    samples = array("h")
    samples.frombytes(data[:len(data) - len(data) % 2])
    if sys.byteorder != "little":
        samples.byteswap()
    return math.sqrt(sum(value * value for value in samples) / max(1, len(samples))) / 32768.0


class PcmCaptionSegmenter:
    def __init__(self, max_seconds: float = 6.0,
                 silence_seconds: float = 0.6, min_rms: float = 0.001) -> None:
        self.max_bytes = int(max_seconds * PCM_BYTES_PER_SECOND)
        self.silence_bytes = int(silence_seconds * PCM_BYTES_PER_SECOND)
        self.min_rms = min_rms
        self.pending = bytearray()
        self.phrase = bytearray()
        self.preroll = bytearray()
        self.utterance_id = 0
        self.trailing_silence = 0
        self.speech_bytes = 0

    def _final(self, captured_at: float) -> Optional[CaptionJob]:
        # Preserve brief words ("help", "tulong"), not just long sentences.
        job = None
        # Pre-roll must not make a 20 ms click look like a spoken word.
        if self.speech_bytes >= FRAME_BYTES * 5:  # at least 100 ms audible input
            job = CaptionJob(bytes(self.phrase), self.utterance_id, True, captured_at)
        self.phrase.clear()
        self.trailing_silence = 0
        self.speech_bytes = 0
        return job

    def feed(self, data: bytes, captured_at: Optional[float] = None) -> list[CaptionJob]:
        captured_at = time.monotonic() if captured_at is None else captured_at
        self.pending.extend(data)
        jobs = []
        while len(self.pending) >= FRAME_BYTES:
            frame = bytes(self.pending[:FRAME_BYTES])
            del self.pending[:FRAME_BYTES]
            audible = pcm_rms(frame) >= self.min_rms
            if not self.phrase:
                if not audible:
                    self.preroll.extend(frame)
                    del self.preroll[:-PCM_BYTES_PER_SECOND // 5]
                    continue
                self.utterance_id += 1
                self.phrase.extend(self.preroll)
                self.preroll.clear()
            self.phrase.extend(frame)
            if audible:
                self.speech_bytes += len(frame)
            self.trailing_silence = 0 if audible else self.trailing_silence + len(frame)
            if len(self.phrase) >= self.max_bytes or self.trailing_silence >= self.silence_bytes:
                final = self._final(captured_at)
                if final:
                    jobs.append(final)
        return jobs

    def flush(self) -> Optional[CaptionJob]:
        if not self.phrase:
            return None
        self.phrase.extend(self.pending)
        self.pending.clear()
        return self._final(time.monotonic())


class CaptionMailbox:
    """Queue only complete phrases; interim results are never decoded.

    A slow device can retain at most four complete phrases. Drops are returned
    to the caller for diagnostics instead of quietly growing seconds of delay.
    """
    def __init__(self, max_finals: int = 4) -> None:
        self.finals: deque[CaptionJob] = deque()
        self.max_finals = max_finals
        self.condition = threading.Condition()
        self.closed = False

    def put(self, job: CaptionJob) -> int:
        with self.condition:
            if self.closed or not job.is_final:
                return 0
            dropped = 0
            if len(self.finals) >= self.max_finals:
                self.finals.popleft()
                dropped = 1
            self.finals.append(job)
            self.condition.notify()
            return dropped

    def get(self, timeout: float = 0.2) -> Optional[CaptionJob]:
        with self.condition:
            if not self.finals and not self.closed:
                self.condition.wait(timeout)
            if self.finals:
                return self.finals.popleft()
            return None

    def close(self) -> None:
        with self.condition:
            self.closed = True
            self.finals.clear()
            self.condition.notify_all()
