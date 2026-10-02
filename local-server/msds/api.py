"""FastAPI surface. Identical routes/payloads to the previous single-file server."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .binaries import (install_hint, lan_ip, no_window_flags, pip_install_command,
                       resolve_exe)
from .config import HLS_PORT, RTSP_PORT, WHISPER_MODEL
from .manager import (CAMERAS, mediamtx_running, snapshot, start_mediamtx,
                      stop_all_cameras, sync_cameras)
from .whisper_engine import WHISPER

app = FastAPI(title="MSDSystem multi-camera bridge")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    expose_headers=["X-Snapshot-Timestamp"],
)

SNAPSHOT_TTL = 3.0
SNAPSHOT_TIMEOUT = 6.0


@dataclass
class _CameraSnapshot:
    generation: tuple
    lock: threading.Lock = field(default_factory=threading.Lock)
    captured_at: float = 0.0
    timestamp: int = 0
    image: Optional[bytes] = None
    error: Optional[tuple[int, str]] = None


_SNAPSHOTS: dict[str, _CameraSnapshot] = {}
_SNAPSHOT_LOCK = threading.Lock()


def _snapshot_generation(cam) -> tuple:
    # Invalidate an old picture when a slot is reconfigured or restarted.
    return (id(cam), cam.path, cam.rtsp, cam.started_at)


def _snapshot_state(cam) -> _CameraSnapshot:
    generation = _snapshot_generation(cam)
    registered = {camera.id for camera in snapshot()}
    with _SNAPSHOT_LOCK:
        for camera_id in list(_SNAPSHOTS):
            if camera_id not in registered:
                del _SNAPSHOTS[camera_id]
        state = _SNAPSHOTS.get(cam.id)
        if state is None or state.generation != generation:
            state = _CameraSnapshot(generation)
            _SNAPSHOTS[cam.id] = state
        return state


def find_camera(camera_id: str):
    """Resolve a camera by its registered id, its MediaMTX path, or the
    slot-N / camN alias — so a frontend/bridge naming mismatch can never
    silently break audio or control routes."""
    cam = CAMERAS.get(camera_id)

    if cam:
        return cam
    ident = (camera_id or "").strip().lower()
    if not ident:
        return None
    aliases = {ident}
    digits = "".join(ch for ch in ident if ch.isdigit())
    if digits:
        aliases.update({f"slot-{digits}", f"cam{digits}", f"camera-{digits}", digits})
    for cam in list(CAMERAS.values()):
        if cam.id.lower() in aliases or (cam.path or "").lower() in aliases:
            return cam
    return None


@app.get("/cameras/{camera_id}/snapshot")
def camera_snapshot(camera_id: str):
    """Return one small still from the shared local stream, never a video feed.

    This synchronous route runs in FastAPI's thread pool. Requests for the same
    camera share a capture and a short cache, rather than decoding concurrently
    or opening additional RTSP sessions against the CCTV device.
    """
    cam = find_camera(camera_id)
    if cam is None:
        raise HTTPException(status_code=404, detail="Unknown camera")
    state = _snapshot_state(cam)
    with state.lock:
        if not cam.enabled or not cam.running() or not mediamtx_running():
            raise HTTPException(status_code=503, detail="Camera is offline or disabled")
        if state.generation != _snapshot_generation(cam):
            raise HTTPException(status_code=503, detail="Camera is reconnecting")

        if not state.captured_at or time.monotonic() - state.captured_at >= SNAPSHOT_TTL:
            state.image = None
            state.error = None
            ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE")
            if not ffmpeg:
                state.error = (503, "FFmpeg is unavailable on the camera service")
            else:
                try:
                    out = subprocess.run(
                        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                         "-rtsp_transport", "tcp", "-timeout", "5000000",
                         "-threads", "1", "-i",
                         f"rtsp://127.0.0.1:{RTSP_PORT}/{cam.path}",
                         "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
                         "-vf", "scale=w='min(640,iw)':h=-2", "-filter_threads", "1",
                         "-threads", "1", "-c:v", "mjpeg", "-q:v", "5",
                         "-f", "image2pipe", "pipe:1"],
                        capture_output=True, timeout=SNAPSHOT_TIMEOUT,
                        creationflags=no_window_flags(),
                    )
                    if (out.returncode == 0 and out.stdout
                            and out.stdout.startswith(b"\xff\xd8")
                            and out.stdout.endswith(b"\xff\xd9")):
                        state.image = out.stdout
                        state.timestamp = int(time.time() * 1000)
                    else:
                        state.error = (503, "A camera snapshot is not available yet")
                except subprocess.TimeoutExpired:
                    state.error = (504, "Timed out capturing a camera snapshot")
                except (OSError, subprocess.SubprocessError):
                    state.error = (503, "Could not capture a camera snapshot")
            # Failures also share the cooldown; concurrent clients cannot queue
            # repeated FFmpeg attempts against an unreachable stream.
            state.captured_at = time.monotonic()

        if state.generation != _snapshot_generation(cam) or not cam.enabled or not cam.running():
            state.image = None
            raise HTTPException(status_code=503, detail="Camera is reconnecting or offline")
        if state.error:
            code, detail = state.error
            raise HTTPException(status_code=code, detail=detail)
        return Response(
            content=state.image, media_type="image/jpeg",
            headers={"Cache-Control": "no-store", "X-Snapshot-Timestamp": str(state.timestamp)},
        )


@app.get("/status")
def status():
    host = lan_ip()
    cams = [c.status(host) for c in snapshot()]
    ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE")
    ffprobe = resolve_exe("ffprobe", "FFPROBE_EXE")
    problems = []
    if not ffmpeg:
        problems.append(install_hint("ffmpeg", "FFMPEG_EXE"))
    if not ffprobe:
        problems.append(install_hint("ffprobe", "FFPROBE_EXE"))
    return {
        "mediamtx": mediamtx_running(),
        "hls_port": HLS_PORT,
        "lan_ip": host,
        "whisper": WHISPER.available,
        "whisper_state": WHISPER.state,
        "whisper_model": WHISPER_MODEL,
        "whisper_error": WHISPER.error,
        "python_exe": sys.executable,
        "install_command": pip_install_command(),
        "cameras": cams,
        "ffmpeg_path": ffmpeg,
        "ffprobe_path": ffprobe,
        "error": " ".join(problems) or None,
    }


@app.post("/cameras/sync")
async def sync(request: Request):
    body = await request.json()
    count = sync_cameras(body.get("cameras", []))
    return {"success": True, "count": count}


@app.post("/cameras/{camera_id}/start")
def start_one(camera_id: str):
    cam = find_camera(camera_id)
    if not cam:
        return {"success": False, "error": "unknown camera"}
    start_mediamtx()
    try:
        cam.start()
        deadline = time.time() + 8
        while time.time() < deadline and cam.running() and not cam.hls_ready(force=True):
            time.sleep(0.4)
        if not cam.running():
            return {"success": False, "error": cam.last_video_error()}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
    return {"success": True, "stream": cam.status(lan_ip())["stream"]}


@app.post("/cameras/{camera_id}/stop")
def stop_one(camera_id: str):
    cam = find_camera(camera_id)
    if cam:
        cam.stop()
    return {"success": True}


@app.post("/start-all")
def start_all():
    start_mediamtx()
    cams = [c for c in snapshot() if c.enabled]
    for cam in cams:
        try:
            cam.start()
        except Exception as exc:
            cam.error = str(exc)
    return {"success": True, "started": len(cams)}


@app.post("/stop-all")
def stop_all():
    stop_all_cameras()
    return {"success": True}


@app.get("/cameras/{camera_id}/audio-events")
def audio_events(camera_id: str, since: Optional[str] = None):
    cam = find_camera(camera_id)
    if not cam:
        return {
            "events": [],
            "status": {
                "connected": False, "thread_running": False, "capturing": False,
                "chunks_received": 0, "bytes_received": 0,
                "last_chunk_at": None, "last_transcription_at": None,
                "last_transcript": "", "has_audio_track": None,
                "whisper_available": WHISPER.available,
                "whisper_state": WHISPER.state,
                "whisper_error": WHISPER.error,
                "error": (f"This camera is not registered on the local bridge "
                          f"(id '{camera_id}'). Known ids: "
                          f"{', '.join(CAMERAS) or 'none'}."),
                "ffmpeg_error": None,
                "available_camera_ids": list(CAMERAS),
            },
        }
    # Self-heal: if the camera is enabled but its audio worker died, restart it.
    if cam.enabled and not cam.stop_flag.is_set():
        cam.start_audio()
    with cam.lock:
        events = list(cam.events)
    if since:
        events = [e for e in events if e["timestamp"] > since]
    return {"events": events, "status": cam.audio_status()}


@app.post("/cameras/{camera_id}/audio-test")
@app.get("/cameras/{camera_id}/audio-test")
def audio_test(camera_id: str):
    """Independent RTSP-audio diagnostic: probe + 5 s capture + transcription."""
    cam = find_camera(camera_id)
    if not cam:
        return {"success": False, "error": f"unknown camera id '{camera_id}'",
                "available_camera_ids": list(CAMERAS)}
    return cam.audio_test()



@app.post("/cameras/{camera_id}/talk")
async def talk_to_camera(camera_id: str, audio: UploadFile = File(...)):
    """Push-to-talk: laptop microphone -> CCTV speaker (G.711 mu-law back-channel)."""
    cam = find_camera(camera_id)
    if not cam:
        return {"success": False, "error": "camera not connected"}
    ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE")
    if not ffmpeg:
        return {"success": False, "error": install_hint("ffmpeg", "FFMPEG_EXE")}

    data = await audio.read()
    if not data:
        return {"success": False, "error": "empty audio"}

    tmp = os.path.join(tempfile.gettempdir(), f"msds_talk_{camera_id}.webm")
    with open(tmp, "wb") as fh:
        fh.write(data)
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-re", "-i", tmp,
             "-vn", "-acodec", "pcm_mulaw", "-ar", "8000", "-ac", "1",
             "-f", "rtsp", "-rtsp_transport", "tcp", cam.rtsp],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return {"success": False,
                    "error": out.stderr.strip()[:300] or "camera rejected the audio back-channel"}
        return {"success": True}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "timed out sending audio to the camera"}
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


@app.post("/test-connection")
async def test_connection(request: Request):
    body = await request.json()
    rtsp = body.get("rtsp", "")
    if not rtsp:
        return {"success": False, "error": "missing rtsp url"}
    ffprobe = resolve_exe("ffprobe", "FFPROBE_EXE")
    if not ffprobe:
        return {"success": False, "error": install_hint("ffprobe", "FFPROBE_EXE")}
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-rtsp_transport", "tcp", "-timeout", "5000000",
             "-show_entries", "stream=codec_name,width,height", "-of", "json", rtsp],
            capture_output=True, text=True, timeout=7,
        )
        if out.returncode != 0:
            return {"success": False, "error": out.stderr.strip()[:300] or "connection failed"}
        return {"success": True, "info": out.stdout[:500]}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "timed out reaching camera"}
