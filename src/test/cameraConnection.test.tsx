import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MultiCameraConnect from '@/components/dashboard/MultiCameraConnect';
import { makeSlot } from '@/hooks/useCameraSlots';
import { clearCameraSession, publishCameraSession } from '@/lib/cameraSessions';
import type { BackendStatus } from '@/lib/multiCamServer';

const mocks = vi.hoisted(() => ({
  ready: false, webrtcUrl: '', getMultiStatus: vi.fn(), startCamera: vi.fn(), syncCameras: vi.fn(), testCamera: vi.fn(),
}));

vi.mock('@/lib/multiCamServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/multiCamServer')>();
  return { ...actual, getMultiStatus: mocks.getMultiStatus, startCamera: mocks.startCamera, syncCameras: mocks.syncCameras, testCamera: mocks.testCamera };
});
vi.mock('@/components/dashboard/PrefetchModelsButton', () => ({ default: () => null }));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.ready = false;
  mocks.webrtcUrl = '';
  mocks.testCamera.mockReset().mockResolvedValue({ success: true });
  mocks.syncCameras.mockReset().mockResolvedValue({ success: true });
  mocks.startCamera.mockReset().mockImplementation(async () => {
    mocks.ready = true;
    return { success: true, stream: 'http://127.0.0.1:8888/cam1/index.m3u8' };
  });
  mocks.getMultiStatus.mockReset().mockImplementation(async (): Promise<BackendStatus> => ({
    mediamtx: true, hls_port: 8888, lan_ip: '127.0.0.1', whisper: true, error: null,
    cameras: [{
      id: 'slot-1', path: 'cam1', name: 'Camera 1', enabled: true,
      ffmpeg: mocks.ready, hls_ready: mocks.ready,
      stream: 'http://127.0.0.1:8888/cam1/index.m3u8',
      stream_local: 'http://127.0.0.1:8888/cam1/index.m3u8', restarts: 0, error: null,
      webrtc_local: mocks.webrtcUrl,
    }],
  }));
  localStorage.setItem('msd-camera-slots-v1', JSON.stringify({
    count: 1,
    slots: [{ ...makeSlot(1), ip: '192.168.1.10' }],
  }));
  publishCameraSession('slot-1', { preview: 'data:image/jpeg;base64,snapshot', previewTimestamp: Date.now() });
});

afterEach(() => {
  cleanup();
  clearCameraSession('slot-1');
  localStorage.removeItem('msd-camera-slots-v1');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('camera connection status', () => {
  it('keeps refreshing readiness during parent renders without displaying images or video', async () => {
    const createElement = vi.spyOn(document, 'createElement');
    const view = render(<MultiCameraConnect />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(2);

    // Dashboard metrics rerender the parent faster than the 2.5-second camera poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    view.rerender(<MultiCameraConnect />);
    await act(async () => {});
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(2);
    mocks.ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(3);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    view.rerender(<MultiCameraConnect />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    view.rerender(<MultiCameraConnect />);
    mocks.ready = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(5);
    expect(view.container.querySelector('video')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(createElement.mock.calls.some(([tag]) => tag === 'video')).toBe(false);
  });

  it('confirms a successful connection with a simple message and no preview', async () => {
    const view = render(<MultiCameraConnect />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(mocks.testCamera).toHaveBeenCalledOnce();
    expect(mocks.startCamera).toHaveBeenCalledWith('http://127.0.0.1:5000', 'slot-1');
    expect(screen.getByRole('status')).toHaveTextContent('Camera 1 connected successfully.');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByText(/MediaMTX|FFmpeg|HLS/)).not.toBeInTheDocument();
    expect(view.container.querySelector('img, video')).toBeNull();
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0].connected).toBe(true);
  });

  it('does not claim success when the camera service cannot start the camera', async () => {
    mocks.startCamera.mockResolvedValue({ success: false, error: 'Camera credentials were rejected.' });
    render(<MultiCameraConnect />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(screen.getByText('Camera credentials were rejected.')).toBeInTheDocument();
    expect(screen.queryByText(/connected successfully/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0].connected).toBe(false);
  });

  it('waits for confirmed readiness before showing success even when start returns a stream URL', async () => {
    mocks.startCamera.mockResolvedValue({ success: true, stream: 'http://127.0.0.1:8888/cam1/index.m3u8' });
    render(<MultiCameraConnect />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for camera connection confirmation.');
    expect(screen.queryByText(/connected successfully/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0].connected).toBe(false);

    mocks.ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByRole('status')).toHaveTextContent('Camera 1 connected successfully.');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('adds WebRTC metadata to an already confirmed connection when it becomes available', async () => {
    mocks.ready = true;
    render(<MultiCameraConnect />);
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('Camera 1 connected successfully.');

    mocks.webrtcUrl = 'http://127.0.0.1:8889/cam1/whep';
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    const savedSlot = JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0];
    expect(savedSlot.connected).toBe(true);
    expect(savedSlot.webrtcUrl).toBe(mocks.webrtcUrl);
  });
});
