"""Demand-driven monitoring tests, with a controlled pipe and no real FFmpeg/cameras."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import frame_cache as cache
from msds.camera import Camera
from msds.config import RTSP_PORT

JPEG = b"\xff\xd8first-image\xff\xd9"
NEXT_JPEG = b"\xff\xd8next-image\xff\xd9"


class ControlledPipe:
    def __init__(self, initial=b""):
        self.condition = threading.Condition()
        self.chunks = [initial] if initial else []
        self.closed = False

    def push(self, data):
        with self.condition:
            self.chunks.append(data)
            self.condition.notify_all()

    def read(self, size):
        with self.condition:
            while not self.chunks and not self.closed:
                self.condition.wait(1)
            return self.chunks.pop(0) if self.chunks else b""

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()


class FakeProcess:
    def __init__(self, image=JPEG):
        self.stdout = ControlledPipe(image)
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0
        self.stdout.close()

    def kill(self):
        self.terminate()

    def wait(self, timeout):
        return self.returncode


class JpegParserTests(unittest.TestCase):
    def test_boundaries_can_cross_reads_and_multiple_frames_are_parsed(self):
        parser = cache._JpegParser()
        self.assertEqual(parser.feed(b"garbage\xff"), [])
        self.assertEqual(parser.feed(JPEG[1:-1]), [])
        self.assertEqual(parser.feed(JPEG[-1:] + NEXT_JPEG), [JPEG, NEXT_JPEG])
        self.assertEqual(parser.buffer, b"")

    def test_corrupt_or_oversized_input_cannot_grow_the_retained_buffer(self):
        parser = cache._JpegParser()
        with patch.object(cache, "MAX_JPEG_BYTES", 20):
            self.assertEqual(parser.feed(b"\xff\xd8" + b"x" * 100), [])
            self.assertLessEqual(len(parser.buffer), 20)
            self.assertEqual(parser.feed(b"noise" + JPEG), [JPEG])
            self.assertEqual(parser.feed(b"\xff\xd8" + b"x" * 100 + b"\xff\xd9"), [])
            self.assertLessEqual(len(parser.buffer), 20)


class MonitoringFrameTests(unittest.TestCase):
    def setUp(self):
        cache.close_all()
        self.addCleanup(cache.close_all)
        self.camera = Camera(
            id="slot-1", path="cam1", name="Camera 1",
            rtsp="rtsp://user:secret@192.168.1.10/live", started_at=100,
        )
        self.running = patch.object(Camera, "running", return_value=True).start()
        self.binary = patch.object(cache, "resolve_exe", return_value="test-ffmpeg").start()
        self.processes = []

        def launch(*args, **kwargs):
            process = FakeProcess()
            self.processes.append(process)
            return process

        self.popen = patch.object(cache.subprocess, "Popen", side_effect=launch).start()
        self.addCleanup(patch.stopall)

    def test_shared_reader_returns_jpeg_and_timestamp_using_only_the_local_restream(self):
        image, timestamp = cache.get_monitoring_frame(self.camera)
        self.assertEqual(image, JPEG)
        self.assertGreater(timestamp, 0)
        self.assertEqual(cache.get_monitoring_frame(self.camera), (image, timestamp))
        self.assertEqual(self.popen.call_count, 1)
        command = self.popen.call_args.args[0]
        self.assertIn(f"rtsp://127.0.0.1:{RTSP_PORT}/cam1", command)
        self.assertNotIn(self.camera.rtsp, command)
        self.assertNotIn("secret", " ".join(command))
        self.assertIn("fps=2,scale=w='min(640,iw)':h=-2", command)
        self.assertEqual(self.popen.call_args.kwargs["bufsize"], 0)
        self.assertEqual(self.popen.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_parallel_requests_share_one_decoder(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(cache.get_monitoring_frame, self.camera) for _ in range(8)]
            frames = [future.result(timeout=3) for future in futures]
        self.assertEqual(self.popen.call_count, 1)
        self.assertTrue(all(image == JPEG for image, _ in frames))

    def test_reader_replaces_the_latest_frame_instead_of_queuing_history(self):
        cache.get_monitoring_frame(self.camera)
        self.processes[0].stdout.push(NEXT_JPEG)
        worker = cache._WORKERS[self.camera.id]
        with worker.condition:
            deadline = time.monotonic() + 2
            while worker.image != NEXT_JPEG and time.monotonic() < deadline:
                worker.condition.wait(0.1)
        self.assertEqual(cache.get_monitoring_frame(self.camera)[0], NEXT_JPEG)
        self.assertEqual(self.popen.call_count, 1)
        self.assertFalse(hasattr(worker, "frames"))

    def test_a_stale_frame_is_never_returned_and_wait_is_bounded(self):
        cache.get_monitoring_frame(self.camera)
        worker = cache._WORKERS[self.camera.id]
        worker.captured_at = time.monotonic() - cache.MAX_FRAME_AGE_SECONDS - 0.1
        with patch.object(cache, "FIRST_FRAME_WAIT_SECONDS", 0.02):
            with self.assertRaises(cache.FrameUnavailable) as caught:
                cache.get_monitoring_frame(self.camera)
        self.assertEqual(caught.exception.status_code, 504)
        self.assertNotIn("secret", caught.exception.detail)

    def test_first_frame_wait_and_unavailable_binary_have_real_errors(self):
        self.popen.side_effect = lambda *args, **kwargs: FakeProcess(image=b"")
        with patch.object(cache, "FIRST_FRAME_WAIT_SECONDS", 0.02):
            with self.assertRaises(cache.FrameUnavailable) as caught:
                cache.get_monitoring_frame(self.camera)
        self.assertEqual(caught.exception.status_code, 504)
        cache.close_all()
        self.binary.return_value = None
        with self.assertRaises(cache.FrameUnavailable) as caught:
            cache.get_monitoring_frame(self.camera)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("FFmpeg is unavailable", caught.exception.detail)

    def test_reconfiguration_or_restart_releases_the_old_decoder(self):
        cache.get_monitoring_frame(self.camera)
        previous = self.processes[-1]
        self.camera.started_at += 1
        cache.get_monitoring_frame(self.camera)
        self.assertTrue(previous.terminated)
        self.assertEqual(self.popen.call_count, 2)
        previous = self.processes[-1]
        self.camera.path = "replacement"
        cache.get_monitoring_frame(self.camera)
        self.assertTrue(previous.terminated)
        self.assertIn(f"rtsp://127.0.0.1:{RTSP_PORT}/replacement", self.popen.call_args.args[0])

    def test_idle_or_disabled_cameras_release_processes(self):
        cache.get_monitoring_frame(self.camera)
        worker = cache._WORKERS[self.camera.id]
        worker.last_requested = time.monotonic() - cache.IDLE_SECONDS - 0.1
        cache._reap_workers()
        self.assertEqual(cache._WORKERS, {})
        self.assertTrue(self.processes[-1].terminated)
        cache.get_monitoring_frame(self.camera)
        self.camera.enabled = False
        with self.assertRaises(cache.FrameUnavailable):
            cache.get_monitoring_frame(self.camera)
        self.assertTrue(self.processes[-1].terminated)
        self.assertEqual(cache._WORKERS, {})

    def test_stopped_camera_never_returns_cached_images(self):
        cache.get_monitoring_frame(self.camera)
        self.camera.stop_flag.set()
        with self.assertRaises(cache.FrameUnavailable):
            cache.get_monitoring_frame(self.camera)
        self.assertTrue(self.processes[-1].terminated)
        self.assertEqual(cache._WORKERS, {})

    def test_process_failures_are_generic_and_repeated_requests_share_the_cooldown(self):
        self.popen.side_effect = OSError("rtsp://user:secret@camera")
        for _ in range(2):
            with self.assertRaises(cache.FrameUnavailable) as caught:
                cache.get_monitoring_frame(self.camera)
            self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(self.popen.call_count, 1)

    def test_maximum_worker_count_is_bounded(self):
        cache.get_monitoring_frame(self.camera)
        first = self.processes[0]
        second = Camera(id="slot-2", path="cam2", name="Camera 2", rtsp="rtsp://other", started_at=100)
        with patch.object(cache, "MAX_CAMERAS", 1):
            cache.get_monitoring_frame(second)
        self.assertEqual(len(cache._WORKERS), 1)
        self.assertIn(second.id, cache._WORKERS)
        self.assertTrue(first.terminated)

    def test_service_shutdown_releases_all_decoders(self):
        cache.get_monitoring_frame(self.camera)
        cache.close_all()
        self.assertEqual(cache._WORKERS, {})
        self.assertTrue(self.processes[-1].terminated)


if __name__ == "__main__":
    unittest.main()
