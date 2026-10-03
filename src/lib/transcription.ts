import type { AudioEvent, CctvAudioStatus } from '@/lib/multiCamServer';

export const TRANSCRIPT_CLEAR_MS = 5000;

/** A poll may include a whole backlog; only the newest utterance belongs on screen. */
export function latestFinalTranscript(events: AudioEvent[], status: CctvAudioStatus | null) {
  const newest = events.at(-1);
  const timestamp = status?.last_transcription_at;
  const statusAt = timestamp ? Date.parse(timestamp) : NaN;
  const eventAt = newest ? Date.parse(newest.timestamp) : NaN;
  const statusIsLatest = !newest || (Number.isFinite(statusAt) && Number.isFinite(eventAt)
    ? statusAt >= eventAt : timestamp >= newest.timestamp);
  if (timestamp && statusIsLatest) {
    // An empty final is authoritative too: rejected audio clears the prior words.
    return { timestamp, text: status.last_transcript.trim() };
  }
  return newest ? { timestamp: newest.timestamp, text: newest.transcript.trim() } : null;
}

/** Old history must not reappear when a camera reconnects or a page opens. */
export function transcriptRemainingMs(timestamp: string) {
  const heardAt = Date.parse(timestamp);
  if (!Number.isFinite(heardAt)) return TRANSCRIPT_CLEAR_MS;
  return Math.max(0, TRANSCRIPT_CLEAR_MS - Math.max(0, Date.now() - heardAt));
}
