import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CameraMonitor from '@/components/dashboard/CameraMonitor';
import { makeSlot } from '@/hooks/useCameraSlots';
import { getCameraSession, publishCameraSession } from '@/lib/cameraSessions';
import { DEFAULT_SETTINGS } from '@/types/multicam';

interface MockPlayer {
  video: HTMLVideoElement | null;
  parsed: (() => void) | null;
  destroy: ReturnType<typeof vi.fn>;
}
interface MockRtc {
  callbacks: { onStream: (stream: MediaStream) => void; onError: (error: Error) => void };
  close: ReturnType<typeof vi.fn>;
}
const mocked = vi.hoisted(() => ({
  players: [] as MockPlayer[], getAudioEvents: vi.fn(), getCameraSnapshot: vi.fn(),
  analyzeFace: vi.fn(async () => {}), loadDetector: vi.fn(async () => {}), detectObjects: vi.fn(),
  computeSaliency: vi.fn(), detectFire: vi.fn(),
  openCameraWebRtc: vi.fn(), rtc: [] as MockRtc[],
  distress: { hasFace: false, expression: null as string | null, distressScore: 0, distressLevel: 'none' as 'none' | 'mild' | 'severe' },
}));
vi.mock('@/lib/cameraWebRtc', () => ({ openCameraWebRtc: mocked.openCameraWebRtc }));
vi.mock('hls.js', () => ({
  default: class {
    static Events = { MANIFEST_PARSED: 'parsed', ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'media' };
    static isSupported() { return true; }
    video: HTMLVideoElement | null = null;
    parsed: (() => void) | null = null;
    destroy = vi.fn();
    constructor() { mocked.players.push(this); }
    loadSource() {}
    attachMedia(video: HTMLVideoElement) { this.video = video; }
    on(event: string, callback: () => void) { if (event === 'parsed') this.parsed = callback; }
  },
}));
vi.mock('@/lib/detectionEngine', () => ({ loadDetector: mocked.loadDetector, detectObjects: mocked.detectObjects }));
vi.mock('@/lib/saliency', () => ({ computeSaliency: mocked.computeSaliency, computeSaliencyScore: () => 20 }));
vi.mock('@/lib/fireDetection', () => ({
  createFireState: () => ({}),
  detectFire: mocked.detectFire,
}));
vi.mock('@/hooks/useFaceDistress', () => {
  return { useFaceDistress: () => ({ ready: false, distress: mocked.distress, analyze: mocked.analyzeFace }) };
});
vi.mock('@/lib/multiCamServer', () => ({
  getAudioEvents: mocked.getAudioEvents, getCameraSnapshot: mocked.getCameraSnapshot,
  describeAudioStatus: () => ({ message: 'Listening', tone: 'ok' }),
}));
let drawImage: ReturnType<typeof vi.fn>;
let closeBitmap: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
  mocked.players.length = 0;
  mocked.rtc.length = 0;
  mocked.openCameraWebRtc.mockReset().mockImplementation((_url, callbacks: MockRtc['callbacks']) => {
    const session = { callbacks, close: vi.fn() };
    mocked.rtc.push(session);
    return session;
  });
  vi.stubGlobal('RTCPeerConnection', undefined);
  mocked.getAudioEvents.mockReset().mockResolvedValue({ events: [], status: null });
  mocked.getCameraSnapshot.mockReset().mockImplementation(async () => ({ blob: new Blob(['jpeg']), timestamp: Date.now() }));
  mocked.loadDetector.mockClear();
  mocked.detectObjects.mockReset().mockResolvedValue([]);
  mocked.analyzeFace.mockReset().mockResolvedValue(undefined);
  mocked.distress = { hasFace: false, expression: null, distressScore: 0, distressLevel: 'none' };
  mocked.computeSaliency.mockClear();
  mocked.detectFire.mockReset().mockReturnValue({ fireDetected: false, smokeEmergency: false, confidence: 0, smokeRatio: 0 });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,preview');
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
    getImageData: () => ({ width: 320, height: 180, data: new Uint8ClampedArray(320 * 180 * 4) }),
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  closeBitmap = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1920, height: 1080, close: closeBitmap })));
  for (const index of [1, 2, 3, 4]) {
    publishCameraSession(`slot-${index}`, { video: null, home: null, runtime: null, reconnect: null, preview: null, previewTimestamp: null });
  }
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const safetyEvent = { timestamp: '2026-10-02T00:00:01Z', transcript: 'help me', keyword: 'help', confidence: 0.99 };

describe('camera snapshots and page-scoped playback', () => {
  it.each([1, 2])('uses stills for camera %s on Dashboard while visual and audio triggers continue', async index => {
    mocked.detectObjects.mockResolvedValue([{ label: 'person', confidence: 0.9, bbox: [0, 0, 20, 20] }]);
    const slot = { ...makeSlot(index), ip: `192.168.1.${index}`, connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    const session = getCameraSession(`slot-${index}`);
    const firstSeenAt = session.previewTimestamp;
    expect(session.video).toBeNull();
    expect(session.home).toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(mocked.players).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(expect.objectContaining({ width: 1920 }), 0, 0, 640, 360);
    expect(mocked.detectObjects).toHaveBeenCalledWith(expect.objectContaining({ width: 320, height: 180 }), expect.any(Number));
    expect(session.preview).toBe('data:image/jpeg;base64,preview');
    expect(session.runtime?.objects[0].label).toBe('person');
    expect(session.runtime?.fps).toBe(0);
    expect(session.runtime?.frameWidth).toBe(320);
    expect(session.runtime?.frameHeight).toBe(180);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'object', cameraId: `slot-${index}` }));
    expect(closeBitmap).toHaveBeenCalledOnce();
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [safetyEvent], status: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      cameraId: `slot-${index}`, type: 'audio-distress', snapshot: 'data:image/jpeg;base64,preview',
    }));
    expect(getCameraSession(`slot-${index}`).runtime?.audioListening).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(getCameraSession(`slot-${index}`).previewTimestamp).toBe(firstSeenAt);
    expect(mocked.players).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('starts and removes playback on page changes without restarting audio or replaying its events', async () => {
    const slot = { ...makeSlot(2), ip: '192.168.1.2', connected: true };
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [safetyEvent], status: null });
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled onEvent={onEvent} />);
    await act(async () => {});
    const liveSession = getCameraSession('slot-2');
    expect(liveSession.video).toBeInstanceOf(HTMLVideoElement);
    expect(mocked.players).toHaveLength(1);
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);
    act(() => mocked.players[0].parsed?.());
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(1);
    expect(mocked.getAudioEvents).toHaveBeenLastCalledWith(expect.any(String), 'slot-2', safetyEvent.timestamp);
    expect(onEvent).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.players[0].destroy).toHaveBeenCalledOnce();
    expect(liveSession.video?.isConnected).toBe(false);
    expect(liveSession.home?.isConnected).toBe(false);
    expect(getCameraSession('slot-2').video).toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(3);
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('reuses one live player when callbacks and AI change while listening continues', async () => {
    const slot = { ...makeSlot(2), ip: '192.168.1.2', connected: true };
    const firstHandler = vi.fn();
    const latestHandler = vi.fn();
    const { rerender, unmount } = render(<CameraMonitor slot={slot} monitoring playbackEnabled onEvent={firstHandler} />);
    await act(async () => {});
    const session = getCameraSession('slot-2');
    const visibleCard = document.createElement('div');
    document.body.appendChild(visibleCard);
    visibleCard.appendChild(session.video!);
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled onEvent={latestHandler} />);
    await act(async () => {});
    expect(getCameraSession('slot-2').video).toBe(session.video);
    expect(mocked.players).toHaveLength(1);
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [safetyEvent], status: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(latestHandler).toHaveBeenCalledWith(expect.objectContaining({ cameraId: 'slot-2', type: 'audio-distress' }));
    expect(firstHandler).not.toHaveBeenCalled();
    unmount();
    expect(session.video?.isConnected).toBe(false);
    expect(session.home?.isConnected).toBe(false);
    expect(mocked.players[0].destroy).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-2').video).toBeNull();
    visibleCard.remove();
  });

  it('leaves disconnected slots idle without video, network requests, or recurring updates', async () => {
    const onMetrics = vi.fn();
    render(<CameraMonitor slot={makeSlot(3)} monitoring playbackEnabled onMetrics={onMetrics} />);
    await act(async () => {});
    const initialUpdates = onMetrics.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocked.players).toHaveLength(0);
    expect(document.querySelector('video')).toBeNull();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    expect(mocked.loadDetector).not.toHaveBeenCalled();
    expect(onMetrics).toHaveBeenCalledTimes(initialUpdates);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains its last still after snapshot failure, disconnect, and unmount', async () => {
    const slot = { ...makeSlot(4), ip: '192.168.1.4', connected: true };
    const { rerender, unmount } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    const still = getCameraSession('slot-4').preview;
    const timestamp = getCameraSession('slot-4').previewTimestamp;
    mocked.getCameraSnapshot.mockRejectedValue(new Error('Camera snapshot unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(getCameraSession('slot-4').runtime?.status).toBe('error');
    expect(getCameraSession('slot-4').preview).toBe(still);
    expect(getCameraSession('slot-4').previewTimestamp).toBe(timestamp);
    expect(getCameraSession('slot-4').runtime?.audioListening).toBe(true);
    rerender(<CameraMonitor slot={{ ...slot, connected: false }} monitoring={false} playbackEnabled={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(getCameraSession('slot-4').preview).toBe(still);
    unmount();
    expect(getCameraSession('slot-4').runtime).toBeNull();
    expect(getCameraSession('slot-4').preview).toBe(still);
  });

  it('aborts an in-flight snapshot when entering Cameras', async () => {
    mocked.getCameraSnapshot.mockImplementation(() => new Promise(() => {}));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    const signal = mocked.getCameraSnapshot.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    expect(signal.aborted).toBe(true);
    expect(mocked.players).toHaveLength(1);
  });

  it('captures local webcam stills without playback and attaches its stream only on Cameras', async () => {
    const track = { stop: vi.fn() };
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    const grabFrame = vi.fn(async () => ({ width: 1920, height: 1080, close: closeBitmap }));
    vi.stubGlobal('ImageCapture', class { grabFrame = grabFrame; });
    const slot = makeSlot(1);
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} localStream={stream} />);
    await act(async () => {});
    expect(grabFrame).toHaveBeenCalledOnce();
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,preview');
    expect(document.querySelector('video')).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled localStream={stream} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').video?.srcObject).toBe(stream);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(mocked.players).toHaveLength(0);
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} localStream={stream} />);
    await act(async () => {});
    expect(document.querySelector('video')).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
  });

  it('keeps webcam previews free of video when the browser cannot capture still frames', async () => {
    vi.stubGlobal('ImageCapture', undefined);
    const stream = { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream;
    render(<CameraMonitor slot={makeSlot(1)} monitoring={false} playbackEnabled={false} localStream={stream} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').runtime?.error).toContain('Still previews are unavailable');
    expect(document.querySelector('video')).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revokes a pending fallback image URL immediately when the monitor unmounts', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const revoke = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL = vi.fn(() => 'blob:pending-snapshot');
      static revokeObjectURL = revoke;
    });
    // Leave decoding pending to exercise cancellation before the image loads.
    vi.stubGlobal('Image', class { onload = null; onerror = null; src = ''; });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const { unmount } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    unmount();
    await act(async () => {});
    expect(revoke).toHaveBeenCalledWith('blob:pending-snapshot');
    expect(getCameraSession('slot-1').runtime).toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  it('uses the current AI switch when a JPEG finishes loading', async () => {
    let finishSnapshot: (result: { blob: Blob; timestamp: number }) => void;
    mocked.getCameraSnapshot.mockImplementationOnce(() => new Promise(resolve => { finishSnapshot = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => { finishSnapshot({ blob: new Blob(['jpeg']), timestamp: Date.now() }); });
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,preview');
    expect(mocked.detectObjects).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(getCameraSession('slot-1').runtime?.audioListening).toBe(true);
  });

  it('drops pending visual inference when AI is disabled and keeps audio listening', async () => {
    let finishDetection: (objects: { label: string; confidence: number; bbox: number[] }[]) => void;
    mocked.detectObjects.mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.detectObjects).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => { finishDetection([{ label: 'person', confidence: 0.99, bbox: [0, 0, 20, 20] }]); });
    expect(onEvent).not.toHaveBeenCalled();
    expect(mocked.analyzeFace).not.toHaveBeenCalled();
    expect(getCameraSession('slot-1').runtime?.objects).toEqual([]);
    expect(getCameraSession('slot-1').runtime?.lastDetectionAt).toBeNull();
    expect(getCameraSession('slot-1').runtime?.audioListening).toBe(true);
  });

  it('keeps background analysis refreshing while the displayed last-seen image stays static', async () => {
    let finishDetection: (objects: unknown[]) => void;
    mocked.detectObjects.mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} />);
    await act(async () => {});
    const firstSeenAt = getCameraSession('slot-1').previewTimestamp;
    expect(closeBitmap).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(mocked.detectObjects).toHaveBeenCalledOnce();
    expect(closeBitmap).toHaveBeenCalledTimes(2);
    expect(getCameraSession('slot-1').previewTimestamp).toBe(firstSeenAt);
    await act(async () => { finishDetection([]); });
  });

  it('ignores facial distress from work started before AI was disabled and re-enabled', async () => {
    let finishFace: () => void;
    mocked.analyzeFace.mockImplementationOnce(() => new Promise(resolve => { finishFace = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.analyzeFace).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    mocked.distress = { hasFace: true, expression: 'fearful', distressScore: 99, distressLevel: 'severe' };
    rerender(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => { finishFace(); });
    expect(onEvent).not.toHaveBeenCalled();
    expect(getCameraSession('slot-1').runtime?.faceDistress.detected).toBe(false);
  });

  it('still publishes severe facial distress from current analysis', async () => {
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression: 'fearful', distressScore: 99, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress', label: 'fearful' }));
    expect(getCameraSession('slot-1').runtime?.faceDistress.detected).toBe(true);
  });

  it('preserves actual analysis dimensions for small source images', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 160, height: 90, close: closeBitmap })));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').runtime?.frameWidth).toBe(160);
    expect(getCameraSession('slot-1').runtime?.frameHeight).toBe(90);
  });

  it('applies saliency and history preferences while retaining every object for fire filtering', async () => {
    const objects = [
      { label: 'tv', confidence: 0.99, bbox: [0, 0, 20, 20] },
      { label: 'refrigerator', confidence: 0.8, bbox: [20, 20, 20, 20] },
      { label: 'person', confidence: 0.7, bbox: [40, 20, 20, 20] },
    ];
    mocked.detectObjects.mockResolvedValue(objects);
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent}
      baseSettings={{ ...DEFAULT_SETTINGS, saliencyThreshold: 72, priorityObjects: ['refrigerator'] }} />);
    await act(async () => {});
    expect(mocked.computeSaliency).toHaveBeenCalledWith(expect.anything(), null, 'sobel', 72);
    expect(mocked.detectFire).toHaveBeenCalledWith(expect.anything(), expect.anything(), objects);
    expect(getCameraSession('slot-1').runtime?.objects).toEqual(objects);
    const historyLabels = onEvent.mock.calls.map(([event]) => event).filter(event => event.type === 'object').map(event => event.label);
    expect(historyLabels).toEqual(['refrigerator', 'person']);
  });

  it('keeps the displayed image and storage unchanged as background frames arrive, then saves the last real still on disconnect', async () => {
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');
    encode.mockReturnValueOnce('data:image/jpeg;base64,first').mockReturnValue('data:image/jpeg;base64,last');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} />);
    await act(async () => {});
    const firstSeenAt = getCameraSession('slot-1').previewTimestamp;
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,first');
    expect(write).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(4);
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,first');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(firstSeenAt);
    expect(write).toHaveBeenCalledOnce();

    rerender(<CameraMonitor slot={{ ...slot, connected: false }} monitoring playbackEnabled={false} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,last');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(Date.now());
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('preserves a saved image when the camera reconnects and gets newer background frames', async () => {
    publishCameraSession('slot-1', { preview: 'data:image/jpeg;base64,cached', previewTimestamp: Date.now() - 60_000 });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,cached');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(Date.now() - 66_000);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['leave', 'disconnect', 'unmount'])('captures the final ready video frame before teardown on %s', async boundary => {
    const slot = { ...makeSlot(2), ip: '192.168.1.2', connected: true };
    const { rerender, unmount } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    const video = getCameraSession('slot-2').video!;
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValueOnce('data:image/jpeg;base64,final').mockReturnValue('data:image/jpeg;base64,background');
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      if (this === video) {
        expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
        Object.defineProperty(video, 'readyState', { value: 0, configurable: true });
      }
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getCameraSession('slot-2').preview).toBeNull();
    if (boundary === 'leave') rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    else if (boundary === 'disconnect') rerender(<CameraMonitor slot={{ ...slot, connected: false }} monitoring={false} playbackEnabled />);
    else unmount();
    await act(async () => {});
    expect(getCameraSession('slot-2').preview).toBe('data:image/jpeg;base64,final');
    expect(getCameraSession('slot-2').previewTimestamp).toBe(Date.now());
    expect(getCameraSession('slot-2').video).toBeNull();
    const saved = JSON.parse(localStorage.getItem('msds-camera-last-seen-v1')!);
    expect(saved['slot-2']).toEqual({ preview: 'data:image/jpeg;base64,final', previewTimestamp: Date.now() });
  });

  it('opens realtime playback only on Cameras and attaches its audio and video without HLS', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    expect(mocked.openCameraWebRtc).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    expect(mocked.openCameraWebRtc).toHaveBeenCalledWith(expect.stringMatching(/\/cam1\/whep$/), expect.any(Object));
    expect(mocked.players).toHaveLength(0);
    const audioTrack = { kind: 'audio', id: 'audio-1' };
    const videoTrack = { kind: 'video', id: 'video-1' };
    const stream = {
      getTracks: () => [audioTrack, videoTrack],
      getAudioTracks: () => [audioTrack], getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const video = getCameraSession('slot-1').video!;
    act(() => mocked.rtc[0].callbacks.onStream(stream));
    expect(video.srcObject).toBe(stream);
    expect((video.srcObject as MediaStream).getAudioTracks()).toEqual([audioTrack]);
    expect((video.srcObject as MediaStream).getVideoTracks()).toEqual([videoTrack]);
    expect(getCameraSession('slot-1').runtime?.status).toBe('connecting');
    expect(getCameraSession('slot-1').runtime?.transport).toBe('webrtc');
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true }, videoWidth: { value: 640 }, videoHeight: { value: 480 },
    });
    act(() => video.dispatchEvent(new Event('loadeddata')));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(getCameraSession('slot-1').runtime?.status).toBe('online');
    expect(getCameraSession('slot-1').runtime?.playbackWarning).toBeNull();
    expect(mocked.players).toHaveLength(0);
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
  });

  it('falls back to HLS with a visible delay warning if realtime playback fails', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    act(() => mocked.rtc[0].callbacks.onError(new Error('Realtime unavailable')));
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(mocked.players).toHaveLength(1);
    expect(getCameraSession('slot-1').runtime?.transport).toBe('hls');
    expect(getCameraSession('slot-1').runtime?.playbackWarning).toMatch(/Delay may exceed one second/);
    act(() => mocked.players[0].parsed?.());
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-1').runtime?.status).toBe('connecting');
    const video = getCameraSession('slot-1').video!;
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true }, videoWidth: { value: 640 }, videoHeight: { value: 480 },
    });
    act(() => video.dispatchEvent(new Event('loadeddata')));
    expect(getCameraSession('slot-1').runtime?.status).toBe('online');
    expect(getCameraSession('slot-1').runtime?.playbackWarning).toMatch(/compatibility stream/);
  });

  it('closes realtime playback on leaving Cameras while preserving the last frame and backend audio cursor', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [safetyEvent], status: null });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled onEvent={onEvent} />);
    await act(async () => {});
    const video = getCameraSession('slot-1').video!;
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    act(() => mocked.rtc[0].callbacks.onStream(stream));
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true }, videoWidth: { value: 640 }, videoHeight: { value: 480 },
    });
    act(() => video.dispatchEvent(new Event('loadeddata')));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(2);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValueOnce('data:image/jpeg;base64,final').mockReturnValue('data:image/jpeg;base64,background');
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-1').video).toBeNull();
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,final');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(Date.now());
    expect(getCameraSession('slot-1').runtime?.audioListening).toBe(true);
    const playCount = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    act(() => {
      mocked.rtc[0].callbacks.onStream(stream);
      mocked.rtc[0].callbacks.onError(new Error('Late callback'));
    });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCount);
    expect(mocked.players).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(3);
    expect(mocked.getAudioEvents).toHaveBeenLastCalledWith(expect.any(String), 'slot-1', safetyEvent.timestamp);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
  });
});
