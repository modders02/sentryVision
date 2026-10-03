"""Regression coverage with synthetic PCM and fake inference (no downloads)."""
from array import array
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import camera as camera_module
from msds.camera import Camera
from msds.streaming_audio import CaptionJob, CaptionMailbox, PcmCaptionSegmenter
from msds.whisper_engine import WhisperEngine, _normalise_repetition, is_hallucination


def pcm(seconds, amplitude=0):
    samples = array("h", [amplitude] * int(16000 * seconds))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes()


class StreamingCaptionTests(unittest.TestCase):
    def test_silence_never_schedules_inference(self):
        segmenter = PcmCaptionSegmenter()
        self.assertEqual(segmenter.feed(pcm(10)), [])
        self.assertIsNone(segmenter.flush())

    def test_phrase_is_decoded_once_after_silence_with_complete_context(self):
        segmenter = PcmCaptionSegmenter()
        self.assertEqual(segmenter.feed(pcm(0.48, 800)), [])
        self.assertEqual(segmenter.feed(pcm(0.02, 800), captured_at=1), [])
        self.assertEqual(segmenter.feed(pcm(0.5, 800), captured_at=2), [])
        final = segmenter.feed(pcm(0.6), captured_at=3)[-1]
        self.assertTrue(final.is_final)
        self.assertEqual(final.utterance_id, 1)
        self.assertEqual(len(final.pcm), 51200)
        self.assertEqual(final.captured_at, 3)
        next_phrase = segmenter.feed(pcm(0.2, 1000) + pcm(0.6))[0]
        self.assertEqual(next_phrase.utterance_id, 2)
        self.assertEqual(next_phrase.pcm, pcm(0.2, 1000) + pcm(0.6))

    def test_short_distress_words_are_finalized_and_continuous_input_is_bounded(self):
        segmenter = PcmCaptionSegmenter()
        jobs = segmenter.feed(pcm(0.2, 800) + pcm(0.6))
        self.assertTrue(jobs[-1].is_final)
        jobs = segmenter.feed(pcm(24, 800))
        finals = [job for job in jobs if job.is_final]
        self.assertEqual(len(finals), 4)
        self.assertTrue(all(len(job.pcm) <= 192000 and job.is_final for job in jobs))
        self.assertEqual(len({job.utterance_id for job in finals}), 4)

    def test_pcm_blocks_can_end_between_samples(self):
        data = pcm(0.5, 800)
        segmenter = PcmCaptionSegmenter()
        jobs = []
        for start in range(0, len(data), 777):
            jobs.extend(segmenter.feed(data[start:start + 777]))
        self.assertEqual(jobs, [])
        self.assertEqual(segmenter.feed(pcm(0.6))[0].pcm, data + pcm(0.6))

    def test_preroll_does_not_make_a_brief_click_look_like_speech(self):
        segmenter = PcmCaptionSegmenter()
        self.assertEqual(segmenter.feed(pcm(1) + pcm(0.02, 1000) + pcm(0.6)), [])
        self.assertIsNone(segmenter.flush())

    def test_flush_finalizes_a_word_once_without_reusing_audio(self):
        segmenter = PcmCaptionSegmenter()
        self.assertEqual(segmenter.feed(pcm(0.12, 800)), [])
        final = segmenter.flush()
        self.assertTrue(final.is_final)
        self.assertEqual(final.pcm, pcm(0.12, 800))
        self.assertIsNone(segmenter.flush())

    def test_mailbox_rejects_drafts_and_reports_bounded_queue_overload(self):
        mailbox = CaptionMailbox(max_finals=2)
        mailbox.put(CaptionJob(b"old draft", 1, False, 0))
        mailbox.put(CaptionJob(b"new draft", 1, False, 0))
        self.assertIsNone(mailbox.get(timeout=0))
        final = CaptionJob(b"final", 1, True, 0)
        mailbox.put(final)
        self.assertEqual(mailbox.get(), final)
        self.assertIsNone(mailbox.get(timeout=0))
        for i in range(3):
            drops = mailbox.put(CaptionJob(b"final", i + 2, True, 0))
        self.assertEqual(drops, 1)
        self.assertEqual(mailbox.get().utterance_id, 3)
        self.assertEqual(mailbox.get().utterance_id, 4)

    def test_drafts_are_not_decoded_and_only_original_final_speech_is_published(self):
        camera = Camera("camera-test", "camera-test", "test", "rtsp://test")
        generation = object()
        camera._caption_generation = generation
        engine = SimpleNamespace(available=True, transcribe_pcm=Mock(return_value="five people"))
        with patch.object(camera_module, "WHISPER", engine):
            camera._decode_caption(CaptionJob(pcm(0.5, 800), 1, False, time.monotonic()), generation)
            engine.transcribe_pcm.assert_not_called()
            self.assertEqual(camera.partial_transcript, "")
            self.assertEqual(camera.events, [])
            camera._decode_caption(CaptionJob(pcm(1, 800), 1, True, time.monotonic()), generation)
        self.assertEqual(camera.partial_transcript, "")
        self.assertEqual(camera.last_transcript, "five people")
        self.assertEqual(camera.events[0]["keyword"], "")

    def test_stopped_generation_and_obsolete_draft_cannot_decode_or_publish(self):
        camera = Camera("camera-test", "camera-test", "test", "rtsp://test")
        generation = object()
        camera._caption_generation = generation
        engine = SimpleNamespace(available=True, transcribe_pcm=Mock(return_value="help"))
        with patch.object(camera_module, "WHISPER", engine):
            camera._decode_caption(CaptionJob(pcm(0.5, 800), 1, False, 0), generation)
            self.assertEqual(camera.partial_transcript, "")
            camera._caption_generation = object()
            camera._decode_caption(CaptionJob(pcm(0.5, 800), 1, True, 0), generation)
            self.assertEqual(camera.events, [])
            engine.transcribe_pcm.assert_not_called()

    def test_generation_changed_during_decode_cannot_publish(self):
        camera = Camera("camera-test", "camera-test", "test", "rtsp://test")
        generation = object()
        camera._caption_generation = generation

        def disconnect(_):
            camera._caption_generation = object()
            return "help"

        engine = SimpleNamespace(available=True, transcribe_pcm=Mock(side_effect=disconnect))
        with patch.object(camera_module, "WHISPER", engine):
            camera._decode_caption(CaptionJob(pcm(0.5, 800), 1, True, 0), generation)
        self.assertEqual(camera.last_transcript, "")
        self.assertEqual(camera.events, [])

    def test_empty_final_retracts_draft_without_publishing_an_event(self):
        camera = Camera("camera-test", "camera-test", "test", "rtsp://test")
        generation = object()
        camera._caption_generation = generation
        camera.partial_transcript = "fire"
        camera.partial_utterance_id = 1
        with patch("builtins.print"):
            camera._publish_transcript("previous speech")
        previous_timestamp = camera.last_transcription_at
        engine = SimpleNamespace(available=True, transcribe_pcm=Mock(return_value=""))
        with patch.object(camera_module, "WHISPER", engine):
            camera._decode_caption(CaptionJob(pcm(0.5, 800), 1, True, 0), generation)
        self.assertEqual(camera.last_transcript, "")
        self.assertEqual(camera.partial_transcript, "")
        self.assertGreater(camera.last_transcription_at, previous_timestamp)
        self.assertEqual(len(camera.events), 1)
        self.assertEqual(camera.events[0]["transcript"], "previous speech")

    def test_stopping_clears_live_text_but_retains_event_history(self):
        camera = Camera("camera-test", "camera-test", "test", "rtsp://test")
        with patch("builtins.print"):
            camera._publish_transcript("Tulong!")
        camera.stop()
        self.assertEqual(camera.last_transcript, "")
        self.assertEqual(camera.partial_transcript, "")
        self.assertEqual(camera.events[0]["transcript"], "Tulong!")


class WhisperAccuracyTests(unittest.TestCase):
    def fake_engine(self, segments):
        engine = WhisperEngine.__new__(WhisperEngine)
        engine.available = True
        engine.model = Mock()
        engine.model.transcribe.return_value = (iter(segments), SimpleNamespace(
            language="tl", language_probability=0.3, duration=3, duration_after_vad=2,
        ))
        engine.lock = threading.Lock()
        return engine

    def test_original_language_final_uses_beam_search_vad_and_loop_retries(self):
        engine = self.fake_engine([SimpleNamespace(text="Tulong!", no_speech_prob=0.1, avg_logprob=-0.3)])
        self.assertEqual(engine.transcribe("sample"), "Tulong!")
        options = engine.model.transcribe.call_args.kwargs
        self.assertEqual(options["beam_size"], 5)
        self.assertEqual(options["task"], "transcribe")
        self.assertIsNone(options["language"])
        self.assertFalse(options["condition_on_previous_text"])
        self.assertEqual(options["temperature"], (0, 0.2, 0.4))
        self.assertEqual(options["compression_ratio_threshold"], 2.4)
        self.assertTrue(options["word_timestamps"])
        self.assertEqual(options["hallucination_silence_threshold"], 0.8)
        self.assertEqual(options["vad_parameters"]["threshold"], 0.5)
        self.assertIsNone(options["initial_prompt"])

    def test_low_confidence_emergency_hallucinations_are_not_exempt(self):
        engine = self.fake_engine([
            SimpleNamespace(text="help", no_speech_prob=0.95, avg_logprob=-0.5),
            SimpleNamespace(text="sunog", no_speech_prob=0.1, avg_logprob=-2),
            SimpleNamespace(text="fire", no_speech_prob=0.1, avg_logprob=-1.2),
            SimpleNamespace(text="Salamat", no_speech_prob=0.1, avg_logprob=-0.4),
        ])
        self.assertEqual(engine.transcribe("sample"), "Salamat")

    def test_real_words_and_emphatic_repetition_are_preserved(self):
        for text in ["Thank you.", "Thanks for watching", "Bye!", "I", "Tulong!"]:
            self.assertFalse(is_hallucination(text), text)
        self.assertEqual(_normalise_repetition("Help, help, help!"), "Help, help, help!")
        self.assertTrue(is_hallucination("[silence]"))

    def test_impossible_decoder_repetition_is_rejected_without_shortening_real_speech(self):
        engine = self.fake_engine([
            SimpleNamespace(text="I'm sorry, " * 60, no_speech_prob=0.1,
                            avg_logprob=-0.3, compression_ratio=8, start=0, end=3),
            SimpleNamespace(text="Help, help, help!", no_speech_prob=0.1,
                            avg_logprob=-0.3, compression_ratio=3, start=0, end=1),
            SimpleNamespace(text="help " * 12, no_speech_prob=0.1,
                            avg_logprob=-0.3, compression_ratio=3, start=0, end=3),
        ])
        self.assertEqual(engine.transcribe("sample"), "Help, help, help! " + " ".join(["help"] * 12))

    def test_repetition_timestamps_cannot_exceed_the_actual_audio(self):
        engine = self.fake_engine([
            SimpleNamespace(text="I'm sorry, " * 60, no_speech_prob=0.1,
                            avg_logprob=-0.3, compression_ratio=8, start=0, end=100),
        ])
        self.assertEqual(engine.transcribe("sample"), "")

    def test_vad_rejected_audio_never_returns_words(self):
        engine = self.fake_engine([])
        engine.model.transcribe.return_value = (
            iter([SimpleNamespace(text="help", no_speech_prob=0.1, avg_logprob=-0.3)]),
            SimpleNamespace(duration_after_vad=0),
        )
        self.assertEqual(engine.transcribe("sample"), "")

    def test_empty_and_digital_silence_skip_the_decoder(self):
        engine = self.fake_engine([])
        for data in [b"", b"\x00", pcm(1)]:
            self.assertEqual(engine.transcribe_pcm(data), "")
        engine.model.transcribe.assert_not_called()

    def test_decoder_always_releases_model_lock_on_failure(self):
        engine = self.fake_engine([])
        engine.model.transcribe.side_effect = RuntimeError("decode failed")
        with self.assertRaises(RuntimeError):
            engine.transcribe("sample")
        self.assertFalse(engine.lock.locked())


if __name__ == "__main__":
    unittest.main()
