"""Snapshot route regression tests; no camera or FFmpeg process is started.

Run from local-server with: python -m unittest discover -s tests -v
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from fastapi.testclient import TestClient
from msds import api
from msds.camera import Camera
from msds.config import RTSP_PORT


JPEG = b"\xff\xd8camera-snapshot\xff\xd9"


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.camera = Camera(
            id="slot-1", path="cam1", name="Camera 1",
            rtsp="rtsp://user:secret@192.168.1.10/live", started_at=100,
        )
        self.registry = patch.dict(api.CAMERAS, {self.camera.id: self.camera}, clear=True)
        self.registry.start()
        self.addCleanup(self.registry.stop)
        api._SNAPSHOTS.clear()
        self.addCleanup(api._SNAPSHOTS.clear)
        self.running = patch.object(Camera, "running", return_value=True).start()
        self.mediamtx = patch.object(api, "mediamtx_running", return_value=True).start()
        self.binary = patch.object(api, "resolve_exe", return_value="ffmpeg-test").start()
        self.run = patch.object(api.subprocess, "run", return_value=subprocess.CompletedProcess(
            args=[], returncode=0, stdout=JPEG, stderr=b"",
        )).start()
        self.addCleanup(patch.stopall)

    def assert_status(self, code, camera_id="slot-1"):
        with self.assertRaises(HTTPException) as caught:
            api.camera_snapshot(camera_id)
        self.assertEqual(caught.exception.status_code, code)
        return caught.exception

    def test_jpeg_response_headers_and_shared_local_source(self):
        with TestClient(api.app) as client:
            response = client.get("/cameras/slot-1/snapshot", headers={"Origin": "http://localhost:8080"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, JPEG)
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertGreater(int(response.headers["x-snapshot-timestamp"]), 0)
        self.assertIn("X-Snapshot-Timestamp", response.headers["access-control-expose-headers"])
        args, kwargs = self.run.call_args
        command = args[0]
        self.assertIn(f"rtsp://127.0.0.1:{RTSP_PORT}/cam1", command)
        self.assertNotIn(self.camera.rtsp, command)
        self.assertNotIn("secret", " ".join(command))
        self.assertEqual(command[command.index("-frames:v") + 1], "1")
        self.assertIn("scale=w='min(640,iw)':h=-2", command)
        self.assertEqual(kwargs["timeout"], api.SNAPSHOT_TIMEOUT)

    def test_unknown_disabled_and_offline_cameras_have_real_errors(self):
        self.assert_status(404, "missing")
        self.camera.enabled = False
        self.assert_status(503)
        self.camera.enabled = True
        self.running.return_value = False
        self.assert_status(503)
        self.running.return_value = True
        self.mediamtx.return_value = False
        self.assert_status(503)
        self.run.assert_not_called()

    def test_aliases_and_repeat_requests_share_capture(self):
        first = api.camera_snapshot("slot-1")
        second = api.camera_snapshot("cam1")
        third = api.camera_snapshot("camera-1")
        self.assertEqual(first.body, second.body)
        self.assertEqual(second.headers["x-snapshot-timestamp"], third.headers["x-snapshot-timestamp"])
        self.assertEqual(self.run.call_count, 1)

    def test_refreshes_after_three_seconds(self):
        with patch.object(api.time, "monotonic", return_value=100) as monotonic:
            api.camera_snapshot("slot-1")
            monotonic.return_value = 102.99
            api.camera_snapshot("slot-1")
            self.assertEqual(self.run.call_count, 1)
            monotonic.return_value = 103
            api.camera_snapshot("slot-1")
        self.assertEqual(self.run.call_count, 2)

    def test_parallel_requests_for_one_camera_share_one_capture(self):
        entered = threading.Event()
        release = threading.Event()

        def capture(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return subprocess.CompletedProcess([], 0, JPEG, b"")

        self.run.side_effect = capture
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(api.camera_snapshot, "slot-1") for _ in range(6)]
            self.assertTrue(entered.wait(3))
            release.set()
            responses = [future.result(timeout=3) for future in futures]
        self.assertEqual(self.run.call_count, 1)
        self.assertTrue(all(response.body == JPEG for response in responses))

    def test_different_cameras_can_capture_without_waiting_for_each_other(self):
        second = Camera(id="slot-2", path="cam2", name="Camera 2", rtsp="rtsp://another/live")
        api.CAMERAS[second.id] = second
        entered = threading.Barrier(2)

        def capture(*_args, **_kwargs):
            entered.wait(timeout=3)
            return subprocess.CompletedProcess([], 0, JPEG, b"")

        self.run.side_effect = capture
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(api.camera_snapshot, cid) for cid in ("slot-1", "slot-2")]
            responses = [future.result(timeout=5) for future in futures]
        self.assertEqual(self.run.call_count, 2)
        self.assertTrue(all(response.body == JPEG for response in responses))

    def test_timeout_is_504_and_repeated_failure_is_coalesced(self):
        self.run.side_effect = subprocess.TimeoutExpired(self.camera.rtsp, api.SNAPSHOT_TIMEOUT)
        error = self.assert_status(504)
        self.assertNotIn("secret", error.detail)
        self.assert_status(504)
        self.assertEqual(self.run.call_count, 1)

    def test_capture_and_binary_errors_are_503_without_credentials(self):
        for outcome in (OSError("secret"), subprocess.CompletedProcess([], 1, b"", b"secret")):
            with self.subTest(outcome=type(outcome).__name__):
                api._SNAPSHOTS.clear()
                self.run.side_effect = outcome if isinstance(outcome, Exception) else None
                self.run.return_value = outcome
                self.assertNotIn("secret", self.assert_status(503).detail)
        api._SNAPSHOTS.clear()
        self.binary.return_value = None
        self.run.reset_mock()
        self.assert_status(503)
        self.run.assert_not_called()

    def test_empty_invalid_or_truncated_image_is_not_returned(self):
        for image in (b"", b"not-a-jpeg", b"\xff\xd8truncated", b"truncated\xff\xd9"):
            with self.subTest(image=image):
                api._SNAPSHOTS.clear()
                self.run.return_value = subprocess.CompletedProcess([], 0, image, b"")
                self.assert_status(503)

    def test_reconfiguration_or_restart_invalidates_old_image(self):
        api.camera_snapshot("slot-1")
        self.camera.started_at += 1
        api.camera_snapshot("slot-1")
        self.camera.path = "new-path"
        api.camera_snapshot("slot-1")
        self.assertEqual(self.run.call_count, 3)
        self.assertIn(f"rtsp://127.0.0.1:{RTSP_PORT}/new-path", self.run.call_args.args[0])

    def test_reconfiguration_during_capture_discards_image(self):
        def capture(*_args, **_kwargs):
            self.camera.started_at += 1
            return subprocess.CompletedProcess([], 0, JPEG, b"")

        self.run.side_effect = capture
        self.assert_status(503)


if __name__ == "__main__":
    unittest.main()
