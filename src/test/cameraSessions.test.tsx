import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCameraSession, getCameraSession, publishCameraSession, saveCameraStill, useCameraSession,
} from '@/lib/cameraSessions';

beforeEach(() => {
  localStorage.clear();
  for (const id of ['slot-1', 'slot-2', 'slot-3', 'slot-4']) publishCameraSession(id, { preview: null, previewTimestamp: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('shared camera sessions', () => {
  it('keeps snapshots stable and only notifies subscribers to the changed camera', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCameraSession('session-subscription');
    });
    const initial = result.current;
    act(() => {
      publishCameraSession('another-camera', { preview: 'another-image' });
      publishCameraSession('session-subscription', { video: null });
    });
    expect(renders).toBe(1);
    expect(result.current).toBe(initial);

    act(() => publishCameraSession('session-subscription', { preview: 'camera-image' }));
    expect(result.current.preview).toBe('camera-image');
    expect(result.current).toBe(getCameraSession('session-subscription'));
    const updated = result.current;
    act(() => publishCameraSession('session-subscription', { preview: 'camera-image' }));
    expect(result.current).toBe(updated);
    expect(renders).toBe(2);
  });

  it('protects a replacement stream from stale cleanup and retains the last preview', () => {
    const first = document.createElement('video');
    const replacement = document.createElement('video');
    publishCameraSession('session-replacement', {
      video: first,
      preview: 'last-preview',
      previewTimestamp: 1000,
    });
    publishCameraSession('session-replacement', { video: replacement });
    const current = getCameraSession('session-replacement');
    clearCameraSession('session-replacement', first);
    expect(getCameraSession('session-replacement')).toBe(current);

    clearCameraSession('session-replacement', replacement);
    expect(getCameraSession('session-replacement')).toMatchObject({
      video: null,
      home: null,
      runtime: null,
      reconnect: null,
      preview: 'last-preview',
      previewTimestamp: 1000,
    });
  });

  it('writes only new last-seen images and keeps runtime changes out of storage', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    saveCameraStill('slot-1', 'data:image/jpeg;base64,first', 1000);
    expect(write).toHaveBeenCalledOnce();
    saveCameraStill('slot-1', 'data:image/jpeg;base64,background', 2000, true);
    saveCameraStill('slot-1', 'data:image/jpeg;base64,stale', 500);
    publishCameraSession('slot-1', { reconnect: () => {} });
    clearCameraSession('slot-1');
    expect(write).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-1').previewTimestamp).toBe(1000);
    saveCameraStill('slot-1', 'data:image/jpeg;base64,final', 3000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('restores only the saved image and capture time after a module reload', async () => {
    const video = document.createElement('video');
    publishCameraSession('slot-3', { video, preview: 'data:image/jpeg;base64,saved', previewTimestamp: 12345, reconnect: () => {} });
    vi.resetModules();
    const reloaded = await import('@/lib/cameraSessions');
    expect(reloaded.getCameraSession('slot-3')).toMatchObject({
      preview: 'data:image/jpeg;base64,saved', previewTimestamp: 12345,
      video: null, home: null, runtime: null, reconnect: null,
    });
  });

  it('ignores malformed, oversized, and non-slot records when restoring saved images', async () => {
    localStorage.setItem('msds-camera-last-seen-v1', JSON.stringify({
      'slot-1': { preview: 'data:image/jpeg;base64,valid', previewTimestamp: 1000 },
      'slot-2': { preview: 'https://example.com/tracker.jpg', previewTimestamp: 2000 },
      'slot-3': { preview: `data:image/jpeg;base64,${'A'.repeat(200_000)}`, previewTimestamp: 2000 },
      'slot-4': { preview: 'data:image/jpeg;base64,valid', previewTimestamp: 1e20 },
      'slot-5': { preview: 'data:image/jpeg;base64,valid', previewTimestamp: 2000 },
    }));
    vi.resetModules();
    const reloaded = await import('@/lib/cameraSessions');
    expect(reloaded.getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,valid');
    for (const id of ['slot-2', 'slot-3', 'slot-4', 'slot-5']) expect(reloaded.getCameraSession(id).preview).toBeNull();
  });

  it('keeps monitoring usable if storage rejects a write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    expect(() => saveCameraStill('slot-4', 'data:image/jpeg;base64,saved', 12345)).not.toThrow();
    expect(getCameraSession('slot-4').preview).toBe('data:image/jpeg;base64,saved');
  });
});
