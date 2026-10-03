import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCctvSpeech } from '@/hooks/useCctvSpeech';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { getAudioEvents, type CctvAudioStatus } from '@/lib/multiCamServer';

vi.mock('@/lib/multiCamServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/multiCamServer')>(), getAudioEvents: vi.fn(),
}));

const status = (fields: Partial<CctvAudioStatus> = {}): CctvAudioStatus => ({
  thread_running: true, connected: true, chunks_received: 1, bytes_received: 16000,
  last_chunk_at: '2026-01-01T00:00:00Z', last_transcription_at: null, last_transcript: '',
  error: null, ffmpeg_error: null, ...fields,
});

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  lang = '';
  onresult: ((event: unknown) => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { FakeRecognition.instances.push(this); }
  result(words: { text: string; final: boolean }[]) {
    this.onresult?.({ resultIndex: 0, results: words.map(word => ({ isFinal: word.final, 0: { transcript: word.text } })) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
  vi.mocked(getAudioEvents).mockReset();
  FakeRecognition.instances = [];
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('CCTV original transcription', () => {
  it('ignores interim guesses and shows only the finalized original words', async () => {
    vi.mocked(getAudioEvents)
      .mockResolvedValueOnce({ events: [], status: status({ partial_transcript: 'fire', partial_transcription_at: '1' }) })
      .mockResolvedValueOnce({
        events: [{ camera_id: 'cam1', transcript: 'five people', timestamp: '2026-10-02T00:00:00.200Z', keyword: '', confidence: 0 }],
        status: status({ last_transcript: 'five people', last_transcription_at: '2026-10-02T00:00:00.200Z', partial_transcript: '' }),
      });
    const { result } = renderHook(() => useCctvSpeech('http://localhost', 'cam1', true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.transcript).toBe('');
    expect(result.current.interimTranscript).toBe('');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(result.current.transcript).toBe('five people');
    expect(result.current.interimTranscript).toBe('');
  });

  it('cancels pending requests and resets the cursor when switching cameras', async () => {
    vi.mocked(getAudioEvents).mockResolvedValueOnce({
      events: [{ camera_id: 'cam1', transcript: 'hello', timestamp: '1', keyword: '', confidence: 0 }], status: status(),
    }).mockImplementation(() => new Promise(() => {}));
    const { rerender, unmount } = renderHook(({ id }) => useCctvSpeech('http://localhost', id, true), { initialProps: { id: 'cam1' } });
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(200); });
    const oldSignal = vi.mocked(getAudioEvents).mock.calls[1][3];
    rerender({ id: 'cam2' });
    expect(oldSignal?.aborted).toBe(true);
    expect(getAudioEvents).toHaveBeenLastCalledWith('http://localhost', 'cam2', undefined, expect.any(AbortSignal));
    const newSignal = vi.mocked(getAudioEvents).mock.calls.at(-1)?.[3];
    unmount();
    expect(newSignal?.aborted).toBe(true);
  });

  it('does not overlap slow audio requests', async () => {
    vi.mocked(getAudioEvents).mockImplementation(() => new Promise(() => {}));
    renderHook(() => useCctvSpeech('http://localhost', 'cam1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getAudioEvents).toHaveBeenCalledTimes(1);
  });

  it('clears prior words when audio is rejected, even if the response includes older events', async () => {
    const event = { camera_id: 'cam1', transcript: 'previous speech', timestamp: '2026-10-02T00:00:00Z', keyword: '', confidence: 0 };
    vi.mocked(getAudioEvents)
      .mockResolvedValueOnce({ events: [event], status: status() })
      .mockResolvedValueOnce({ events: [event], status: status({ last_transcription_at: '2026-10-02T00:00:00.200Z', last_transcript: '' }) });
    const { result } = renderHook(() => useCctvSpeech('http://localhost', 'cam1', true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.transcript).toBe('previous speech');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(result.current.transcript).toBe('');
  });

  it('shows the newest utterance only, expires it, and accepts the same words spoken again', async () => {
    let latest = { camera_id: 'cam1', transcript: 'hello', timestamp: '2026-10-02T00:00:00Z', keyword: '', confidence: 0 };
    vi.mocked(getAudioEvents).mockImplementation(async () => ({
      events: [
        { ...latest, transcript: 'older words', timestamp: '2026-10-01T23:59:55Z' }, latest,
      ],
      status: status({ last_transcript: latest.transcript, last_transcription_at: latest.timestamp }),
    }));
    const { result } = renderHook(() => useCctvSpeech('http://localhost', 'cam1', true));
    await act(async () => {});
    expect(result.current.transcript).toBe('hello');
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(result.current.transcript).toBe('');
    latest = { ...latest, timestamp: new Date(Date.now()).toISOString() };
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(result.current.transcript).toBe('hello');
  });

  it('does not display expired backend history when first connecting', async () => {
    vi.mocked(getAudioEvents).mockResolvedValue({
      events: [], status: status({ last_transcript: 'old speech', last_transcription_at: '2026-10-01T23:59:00Z' }),
    });
    const { result } = renderHook(() => useCctvSpeech('http://localhost', 'cam1', true));
    await act(async () => {});
    expect(result.current.transcript).toBe('');
  });
});

describe('microphone original transcription', () => {
  it('starts once and displays finalized speech only', () => {
    const { result } = renderHook(() => useSpeechRecognition('fil-PH'));
    act(() => { result.current.start(); result.current.start(); });
    expect(FakeRecognition.instances).toHaveLength(1);
    const client = FakeRecognition.instances[0];
    expect(client.lang).toBe('fil-PH');
    expect(client.interimResults).toBe(false);
    act(() => client.result([{ text: 'tulon', final: false }]));
    expect(result.current.interimTranscript).toBe('');
    expect(result.current.transcript).toBe('');
    act(() => client.result([{ text: 'tulong', final: true }]));
    expect(result.current.transcript).toBe('tulong');
    expect(result.current.interimTranscript).toBe('');
    act(() => client.result([{ text: 'tulong', final: true }]));
    expect(result.current.transcript).toBe('tulong');
  });

  it('clears old words without replaying browser history, then starts fresh', async () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    const client = FakeRecognition.instances[0];
    act(() => client.result([{ text: 'hello', final: true }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current.transcript).toBe('');
    act(() => client.result([{ text: 'hello', final: true }]));
    expect(result.current.transcript).toBe('');
    act(() => client.result([{ text: 'hello', final: true }, { text: 'new speech', final: true }]));
    expect(result.current.transcript).toBe('new speech');
  });

  it('reports a new utterance when the same original words are spoken again before expiry', async () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    const client = FakeRecognition.instances[0];
    act(() => client.result([{ text: 'help me', final: true }]));
    const firstRevision = result.current.transcriptRevision;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    act(() => client.result([{ text: 'help me', final: true }, { text: 'help me', final: true }]));
    expect(result.current.transcript).toBe('help me');
    expect(result.current.transcriptRevision).toBe(firstRevision + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.transcript).toBe('help me');
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(result.current.transcript).toBe('');
  });

  it('does not restart after microphone permission is denied', async () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    const client = FakeRecognition.instances[0];
    const previousEnd = client.onend;
    act(() => { client.onerror?.({ error: 'not-allowed' }); previousEnd?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current.isListening).toBe(false);
    expect(result.current.error).toBe('not-allowed');
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts recognition and cancels queued restart when unmounted', async () => {
    const { result, unmount } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    const client = FakeRecognition.instances[0];
    act(() => client.onend?.());
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.abort).toHaveBeenCalledTimes(1);
  });
});
