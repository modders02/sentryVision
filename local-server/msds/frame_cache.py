"""Demand-driven 2 FPS stills from MediaMTX, with one decoder and latest frame per camera.

Monitoring clients reuse a live JPEG decoder instead of launching FFmpeg for
each sample. No device credentials are passed to that decoder. Idle, replaced,
or stopped cameras release their processes; readers never queue old images.
"""
from __future__ import annotations

import subprocess
import threading
import time
from typing import Optional

from .binaries import no_window_flags, resolve_exe
from .config import MAX_CAMERAS, RTSP_PORT

FRAME_FPS = 2
MAX_FRAME_AGE_SECONDS = 1.5
IDLE_SECONDS = 6.0
FIRST_FRAME_WAIT_SECONDS = 2.5
FAILURE_RETRY_SECONDS = 2.0
MAX_JPEG_BYTES = 1024 * 1024
READ_BYTES = 64 * 1024


class FrameUnavailable(Exception):
    """A public, credential-free monitoring error suitable for an HTTP response."""

    def __init__(self, detail: str, status_code: int = 503):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _generation(cam) -> tuple:
    return (id(cam), cam.path, cam.rtsp, cam.started_at)


def _online(cam) -> bool:
    return bool(cam.enabled and cam.running() and not cam.stop_flag.is_set())


class _JpegParser:
    """Parse JPEG boundaries across pipe reads while strictly bounding retained data."""

    def __init__(self):
        self.buffer = bytearray()

    def feed(self, chunk: bytes) -> list[bytes]:
        self.buffer.extend(chunk)
        frames = []
        while self.buffer:
            start = self.buffer.find(b"\xff\xd8")
            if start < 0:
                # Keep only a possible partial SOI marker.
                self.buffer[:] = self.buffer[-1:] if self.buffer[-1] == 0xff else b""
                break
            if start:
                del self.buffer[:start]
            end = self.buffer.find(b"\xff\xd9", 2)
            if end < 0:
                if len(self.buffer) > MAX_JPEG_BYTES:
                    self.buffer[:] = self.buffer[-1:] if self.buffer[-1] == 0xff else b""
                break
            size = end + 2
            if size <= MAX_JPEG_BYTES:
                frames.append(bytes(self.buffer[:size]))
            del self.buffer[:size]
        return frames


class _FrameWorker:
    def __init__(self, cam):
        self.cam = cam
        self.generation = _generation(cam)
        self.condition = threading.Condition()
        self.stop = threading.Event()
        self.process: Optional[subprocess.Popen] = None
        self.started = False
        self.image: Optional[bytes] = None
        self.timestamp = 0
        self.captured_at = 0.0
        self.last_requested = time.monotonic()
        self.failure: Optional[FrameUnavailable] = None
        self.failed_at = 0.0

    def valid(self) -> bool:
        return not self.stop.is_set() and self.generation == _generation(self.cam) and _online(self.cam)

    def start(self):
        with self.condition:
            if self.started or self.stop.is_set():
                return
            self.started = True
        threading.Thread(target=self._read, name=f"monitoring-{self.cam.id}", daemon=True).start()

    def _fail(self, detail: str):
        with self.condition:
            if not self.stop.is_set():
                self.failure = FrameUnavailable(detail)
                self.failed_at = time.monotonic()
            self.condition.notify_all()

    def _read(self):
        process = None
        try:
            ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE")
            if not ffmpeg:
                self._fail("FFmpeg is unavailable on the camera service")
                return
            process = subprocess.Popen(
                [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                 "-fflags", "nobuffer", "-flags", "low_delay",
                 "-analyzeduration", "100000", "-probesize", "32768",
                 "-rtsp_transport", "tcp", "-timeout", "5000000", "-threads", "1",
                 "-i", f"rtsp://127.0.0.1:{RTSP_PORT}/{self.cam.path}",
                 "-map", "0:v:0", "-an", "-sn", "-dn",
                 "-vf", f"fps={FRAME_FPS},scale=w='min(640,iw)':h=-2",
                 "-filter_threads", "1", "-threads", "1",
                 "-c:v", "mjpeg", "-q:v", "5", "-flush_packets", "1",
                 "-f", "image2pipe", "pipe:1"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                creationflags=no_window_flags(),
            )
            with self.condition:
                self.process = process
            parser = _JpegParser()
            while self.valid() and process.stdout:
                # Unbuffered pipe reads return available bytes immediately, without
                # waiting for a whole 64 KiB block (which could contain several frames).
                chunk = process.stdout.read(READ_BYTES)
                if not chunk:
                    break
                for image in parser.feed(chunk):
                    with self.condition:
                        if not self.valid():
                            break
                        self.image = image
                        self.captured_at = time.monotonic()
                        self.timestamp = int(time.time() * 1000)
                        self.condition.notify_all()
            self._fail("A fresh monitoring frame is not available")
        except (OSError, subprocess.SubprocessError, ValueError):
            # Never forward FFmpeg messages or exception text containing source URLs.
            self._fail("Could not decode a monitoring frame")
        finally:
            if process:
                _terminate(process)

    def frame(self) -> tuple[bytes, int]:
        deadline = time.monotonic() + FIRST_FRAME_WAIT_SECONDS
        with self.condition:
            self.last_requested = time.monotonic()
            while True:
                if not self.valid():
                    raise FrameUnavailable("Camera is reconnecting, offline, or disabled")
                if self.failure:
                    raise self.failure
                if self.image and time.monotonic() - self.captured_at <= MAX_FRAME_AGE_SECONDS:
                    return self.image, self.timestamp
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise FrameUnavailable("Timed out waiting for a fresh monitoring frame", 504)
                self.condition.wait(remaining)

    def close(self):
        self.stop.set()
        with self.condition:
            self.image = None
            self.condition.notify_all()
            process = self.process
        if process:
            _terminate(process)


def _terminate(process):
    try:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=0.2)
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        if process.stdout:
            try:
                process.stdout.close()
            except (OSError, ValueError):
                pass


_WORKERS: dict[str, _FrameWorker] = {}
_LOCK = threading.Lock()
_REAPER: Optional[threading.Thread] = None
_REAPER_STOP = threading.Event()


def _reap_workers():
    expired = []
    now = time.monotonic()
    with _LOCK:
        for camera_id, worker in list(_WORKERS.items()):
            if not worker.valid() or now - worker.last_requested >= IDLE_SECONDS:
                expired.append(_WORKERS.pop(camera_id))
    for worker in expired:
        worker.close()


def _reaper_loop(stopping: threading.Event):
    while not stopping.wait(0.5):
        _reap_workers()


def get_monitoring_frame(cam) -> tuple[bytes, int]:
    """Return a fresh (JPEG, Unix timestamp ms), sharing one decoder per camera.

    Waits at most 2.5 seconds for startup/a fresh image. A dead decoder retries
    after a short cooldown; repeated callers never create parallel decoders.
    """
    global _REAPER, _REAPER_STOP
    _reap_workers()
    if not _online(cam):
        raise FrameUnavailable("Camera is offline or disabled")
    old = None
    evicted = None
    with _LOCK:
        worker = _WORKERS.get(cam.id)
        if worker and (worker.generation != _generation(cam) or (
                worker.failure and time.monotonic() - worker.failed_at >= FAILURE_RETRY_SECONDS)):
            old = _WORKERS.pop(cam.id)
            worker = None
        if worker is None:
            if len(_WORKERS) >= MAX_CAMERAS:
                oldest = min(_WORKERS, key=lambda key: _WORKERS[key].last_requested)
                evicted = _WORKERS.pop(oldest)
            worker = _FrameWorker(cam)
            _WORKERS[cam.id] = worker
        worker.last_requested = time.monotonic()
        if _REAPER is None or not _REAPER.is_alive() or _REAPER_STOP.is_set():
            _REAPER_STOP = threading.Event()
            _REAPER = threading.Thread(target=_reaper_loop, args=(_REAPER_STOP,), daemon=True)
            _REAPER.start()
    if old:
        old.close()
    if evicted:
        evicted.close()
    worker.start()
    return worker.frame()


def close_all():
    """Release all demand decoders on service shutdown or test cleanup."""
    with _LOCK:
        _REAPER_STOP.set()
        workers = list(_WORKERS.values())
        _WORKERS.clear()
    for worker in workers:
        worker.close()
