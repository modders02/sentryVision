import { useCallback, useEffect, useRef, useState } from 'react';
import { AUDIO_POLL_INTERVAL_MS, describeAudioStatus, getAudioEvents, type CctvAudioStatus } from '@/lib/multiCamServer';
import { latestFinalTranscript, transcriptRemainingMs } from '@/lib/transcription';

export interface CctvSpeechDiagnostics {
  polling: boolean;
  backendReachable: boolean;
  audioConnected: boolean;
  threadRunning: boolean;
  hasAudioTrack: boolean | null;
  audioSource: string | null;
  chunksReceived: number;
  whisperState: string | null;
  lastTranscriptionAt: string | null;
  lastTranscript: string;
  transcriptionLatencyMs: number | null;
  droppedCaptionJobs: number;
  ffmpegError: string | null;
  error: string | null;
  message: string;
  tone: 'ok' | 'wait' | 'error';
}

const IDLE: CctvSpeechDiagnostics = {
  polling: false, backendReachable: false, audioConnected: false, threadRunning: false,
  hasAudioTrack: null, audioSource: null, chunksReceived: 0, whisperState: null, lastTranscriptionAt: null,
  lastTranscript: '', transcriptionLatencyMs: null, droppedCaptionJobs: 0, ffmpegError: null, error: null,
  message: 'Connect the camera to start listening.', tone: 'wait',
};

/** Original-language finalized camera speech; each utterance replaces the previous one. */
export function useCctvSpeech(server: string, cameraId: string, enabled: boolean) {
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [listening, setListening] = useState(false);
  const [diagnostics, setDiagnostics] = useState<CctvSpeechDiagnostics>(IDLE);
  const clearTimerRef = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = undefined;
    setTranscript('');
    setInterimTranscript('');
  }, []);

  useEffect(() => {
    clear();
    if (!enabled) {
      setListening(false);
      setDiagnostics(IDLE);
      return;
    }
    let cancelled = false;
    let since: string | undefined;
    let shownRevision = '';
    let timer: number | undefined;
    let request: AbortController | null = null;
    setListening(true);
    setDiagnostics({ ...IDLE, polling: true, message: 'Starting to listen…' });

    const applyStatus = (status: CctvAudioStatus) => {
      const described = describeAudioStatus(status, true);
      setDiagnostics({
        polling: true, backendReachable: true,
        audioConnected: status.connected, threadRunning: status.thread_running,
        hasAudioTrack: status.has_audio_track ?? null, audioSource: status.audio_source ?? null,
        chunksReceived: status.chunks_received ?? 0, whisperState: status.whisper_state ?? null,
        lastTranscriptionAt: status.last_transcription_at, lastTranscript: status.last_transcript ?? '',
        transcriptionLatencyMs: status.transcription_latency_ms ?? null,
        droppedCaptionJobs: status.dropped_caption_jobs ?? 0,
        ffmpegError: status.ffmpeg_error ?? null, error: status.error,
        ...described,
      });
    };

    const tick = async () => {
      if (cancelled) return;
      request = new AbortController();
      let delay = AUDIO_POLL_INTERVAL_MS;
      try {
        const res = await getAudioEvents(server, cameraId, since, request.signal);
        if (cancelled) return;
        applyStatus(res.status);
        const newest = res.events?.at(-1);
        if (newest) since = newest.timestamp;
        const final = latestFinalTranscript(res.events ?? [], res.status);
        const revision = final ? `${final.timestamp}:${final.text}` : '';
        if (final && revision !== shownRevision) {
          shownRevision = revision;
          clear();
          const remaining = transcriptRemainingMs(final.timestamp);
          if (final.text && remaining > 0) {
            setTranscript(final.text);
            clearTimerRef.current = window.setTimeout(clear, remaining);
          }
        }
      } catch (error) {
        if (!cancelled) {
          delay = 1500;
          const message = error instanceof Error ? error.message : String(error);
          setDiagnostics(prev => ({
            ...prev, polling: true, backendReachable: false, audioConnected: false, error: message,
            message: `${describeAudioStatus(null, false).message} (${message})`, tone: 'error',
          }));
        }
      } finally {
        request = null;
        if (!cancelled) timer = window.setTimeout(tick, delay);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      request?.abort();
      if (timer) window.clearTimeout(timer);
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
      setListening(false);
    };
  }, [server, cameraId, enabled, clear]);

  return { transcript, interimTranscript, listening, clear, diagnostics };
}
