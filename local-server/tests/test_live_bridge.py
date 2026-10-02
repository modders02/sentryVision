"""Validate the live publisher and MediaMTX with isolated synthetic streams.

The integration test skips when downloaded binaries are absent. It uses only
loopback and temporary files; it never connects to a physical CCTV camera.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import camera as camera_module
from msds.binaries import no_window_flags, resolve_exe
from msds.camera import Camera
from msds.config import MEDIAMTX_CONFIG, VIDEO_FPS, VIDEO_MAX_WIDTH, WEBRTC_PORT


def _free_port(used):
    while True:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        if port not in used:
            used.add(port)
            return port


def _stop_process(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@contextmanager
def live_fixture(timestamped=False):
    """Yield real synthetic RTSP -> bridge -> MediaMTX endpoint details."""
    ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE")
    mediamtx = resolve_exe("mediamtx", "MEDIAMTX_EXE")
    if not ffmpeg or not mediamtx:
        raise RuntimeError("The FFmpeg and MediaMTX binaries must be downloaded")
    used = set()
    rtsp_port, hls_port, webrtc_port, ice_port = [_free_port(used) for _ in range(4)]
    env = os.environ.copy()
    env.update({
        "MTX_RTSPADDRESS": f"127.0.0.1:{rtsp_port}",
        "MTX_RTSPTRANSPORTS": "tcp",
        "MTX_HLSADDRESS": f"127.0.0.1:{hls_port}",
        "MTX_WEBRTCADDRESS": f"127.0.0.1:{webrtc_port}",
        "MTX_WEBRTCLOCALUDPADDRESS": f"127.0.0.1:{ice_port}",
        "MTX_WEBRTCLOCALTCPADDRESS": f"127.0.0.1:{ice_port}",
        "MTX_API": "false", "MTX_RTMP": "false", "MTX_SRT": "false",
        # Otherwise MediaMTX generates auto.crt/auto.key for its unused MoQ
        # listener. Keep test artifacts entirely within the temporary folder.
        "MTX_MOQ": "false", "MTX_LOGLEVEL": "warn",
    })
    media = source = None
    camera = None
    producer = None
    stop_producer = threading.Event()
    with tempfile.TemporaryDirectory(prefix="msds_live_bridge_") as folder:
        with open(Path(folder) / "media.log", "wb") as media_log, open(Path(folder) / "source.log", "wb") as source_log:
            try:
                media = subprocess.Popen(
                    [mediamtx, MEDIAMTX_CONFIG], cwd=folder, env=env,
                    stdout=media_log, stderr=media_log, creationflags=no_window_flags(),
                )
                deadline = time.monotonic() + 5
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", rtsp_port), timeout=0.2):
                            break
                    except OSError:
                        if media.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError("MediaMTX did not accept the selected configuration")
                        time.sleep(0.1)
                source_input = (["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "640x360",
                                 "-r", "20", "-i", "pipe:0"] if timestamped else
                                ["-re", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=20"])
                source_codec = (["-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0"]
                                if timestamped else ["-preset", "veryfast", "-bf", "2"])
                source = subprocess.Popen(
                    [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", *source_input,
                     "-re", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
                     "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
                     *source_codec, "-pix_fmt", "yuv420p",
                     "-g", "20", "-threads:v", "2", "-c:a", "aac", "-ac", "1",
                     "-f", "rtsp", "-rtsp_transport", "tcp",
                     f"rtsp://127.0.0.1:{rtsp_port}/synthetic-source"],
                    stdin=subprocess.PIPE if timestamped else subprocess.DEVNULL,
                    cwd=folder, stdout=source_log, stderr=source_log,
                    creationflags=no_window_flags(),
                )
                if timestamped:
                    def produce_frames():
                        deadline = time.monotonic()
                        while not stop_producer.is_set():
                            captured_at = int(time.time() * 1000)
                            frame = bytearray(b"\x20\x40\x60" * (640 * 360))
                            for bit in range(48):
                                color = b"\xff\xff\xff" if captured_at & (1 << (47 - bit)) else b"\x00\x00\x00"
                                block = color * 10
                                for y in range(10, 30):
                                    offset = (y * 640 + bit * 10) * 3
                                    frame[offset:offset + 30] = block
                            try:
                                source.stdin.write(frame)
                                source.stdin.flush()
                            except (OSError, ValueError):
                                break
                            deadline += 0.05
                            stop_producer.wait(max(0, deadline - time.monotonic()))

                    producer = threading.Thread(target=produce_frames, daemon=True)
                    producer.start()
                time.sleep(1)
                camera = Camera(
                    id="latency-test", path="latency-test", name="Synthetic latency test",
                    rtsp=f"rtsp://127.0.0.1:{rtsp_port}/synthetic-source",
                )
                with patch.object(camera_module, "RTSP_PORT", rtsp_port):
                    camera.start_video()
                hls = f"http://127.0.0.1:{hls_port}/latency-test/index.m3u8"
                deadline = time.monotonic() + 15
                while True:
                    try:
                        with urllib.request.urlopen(hls, timeout=2) as response:
                            playlist = response.read().decode()
                        if "#EXTM3U" in playlist:
                            break
                    except urllib.error.HTTPError as error:
                        error.close()
                    except (OSError, urllib.error.URLError):
                        pass
                    if not camera.running() or source.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("The live publisher did not make a playable stream")
                    time.sleep(0.2)
                yield {
                    "camera": camera,
                    "rtsp": f"rtsp://127.0.0.1:{rtsp_port}/latency-test",
                    "hls": hls,
                    "whep": f"http://127.0.0.1:{webrtc_port}/latency-test/whep",
                    "webrtc_page": f"http://127.0.0.1:{webrtc_port}/latency-test",
                    "ice_port": ice_port,
                    "playlist": playlist,
                    "timestamped": timestamped,
                }
            finally:
                stop_producer.set()
                if camera:
                    video_process = camera.video_proc
                    camera.stop()
                    if video_process and video_process.stderr:
                        video_process.stderr.close()
                _stop_process(source)
                if producer:
                    producer.join(timeout=2)
                if source and source.stdin:
                    source.stdin.close()
                _stop_process(media)


class LiveCameraStatusTests(unittest.TestCase):
    def test_status_publishes_local_and_lan_whep_without_replacing_hls(self):
        camera = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://camera/live")
        with patch.object(camera, "hls_ready", return_value=True):
            status = camera.status("192.168.1.20")
        self.assertEqual(status["webrtc"], f"http://192.168.1.20:{WEBRTC_PORT}/cam1/whep")
        self.assertEqual(status["webrtc_local"], f"http://127.0.0.1:{WEBRTC_PORT}/cam1/whep")
        self.assertTrue(status["stream"].endswith("/cam1/index.m3u8"))


@unittest.skipUnless(
    resolve_exe("ffmpeg", "FFMPEG_EXE") and resolve_exe("ffprobe", "FFPROBE_EXE")
    and resolve_exe("mediamtx", "MEDIAMTX_EXE"),
    "Download local-server binaries to run live integration",
)
class LiveBridgeIntegrationTests(unittest.TestCase):
    def test_normalizes_codec_and_audio_and_serves_whep_and_low_latency_hls(self):
        with live_fixture() as live:
            probe = subprocess.run(
                [resolve_exe("ffprobe", "FFPROBE_EXE"), "-v", "error", "-rtsp_transport", "tcp",
                 "-timeout", "5000000", "-show_entries",
                 "stream=codec_name,profile,width,height,has_b_frames,r_frame_rate,sample_rate",
                 "-of", "json", live["rtsp"]], capture_output=True, timeout=8,
                creationflags=no_window_flags(),
            )
            self.assertEqual(probe.returncode, 0)
            streams = json.loads(probe.stdout)["streams"]
            video = next(stream for stream in streams if stream["codec_name"] == "h264")
            audio = next(stream for stream in streams if stream["codec_name"] == "opus")
            self.assertIn("Baseline", video["profile"])
            self.assertEqual(video["has_b_frames"], 0)
            self.assertLessEqual(video["width"], VIDEO_MAX_WIDTH)
            self.assertEqual(video["r_frame_rate"], f"{VIDEO_FPS}/1")
            self.assertEqual(audio["sample_rate"], "48000")
            request = urllib.request.Request(live["whep"], method="OPTIONS")
            with urllib.request.urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, 204)
            with socket.create_connection(("127.0.0.1", live["ice_port"]), timeout=2):
                pass
            media_path = next(line for line in live["playlist"].splitlines() if line and not line.startswith("#"))
            media_url = live["hls"].rsplit("/", 1)[0] + "/" + media_path
            with urllib.request.urlopen(media_url, timeout=3) as response:
                media_playlist = response.read().decode()
            self.assertIn("#EXT-X-PART:", media_playlist)
            part_target = re.search(r"#EXT-X-PART-INF:PART-TARGET=([\d.]+)", media_playlist)
            self.assertIsNotNone(part_target)
            self.assertLessEqual(float(part_target.group(1)), 0.2)


if __name__ == "__main__":
    unittest.main()
