import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCameraSnapshot } from '@/lib/multiCamServer';

const snapshotResponse = (timestamp: string | null = '1700000000000') => ({
  ok: true,
  status: 200,
  headers: new Headers(timestamp ? { 'X-Snapshot-Timestamp': timestamp } : {}),
  blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('camera snapshot client', () => {
  it('requests an uncached JPEG and preserves its capture timestamp', async () => {
    const fetch = vi.fn().mockResolvedValue(snapshotResponse());
    vi.stubGlobal('fetch', fetch);
    const result = await getCameraSnapshot(' http://localhost:5000/// ', 'camera/1');
    expect(result.blob.type).toBe('image/jpeg');
    expect(result.timestamp).toBe(1700000000000);
    expect(fetch).toHaveBeenCalledWith('http://localhost:5000/cameras/camera%2F1/snapshot', {
      signal: expect.any(AbortSignal),
      mode: 'cors',
      cache: 'no-store',
    });
  });

  it('uses the local capture time if the bridge has no usable timestamp header', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const timestamp of [null, 'not-a-number', '0', '-1']) {
      fetch.mockResolvedValueOnce(snapshotResponse(timestamp));
      expect((await getCameraSnapshot('http://localhost:5000', 'slot-1')).timestamp).toBe(1234);
    }
  });

  it('preserves HTTP failures and rejects responses that are not JPEG images', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 504 });
    vi.stubGlobal('fetch', fetch);
    await expect(getCameraSnapshot('http://localhost:5000', 'slot-1')).rejects.toThrow('HTTP 504');
    fetch.mockResolvedValue({ ...snapshotResponse(), blob: async () => new Blob(['error'], { type: 'application/json' }) });
    await expect(getCameraSnapshot('http://localhost:5000', 'slot-1')).rejects.toThrow('JPEG snapshot');
    fetch.mockResolvedValue({ ...snapshotResponse(), blob: async () => new Blob([], { type: 'image/jpeg' }) });
    await expect(getCameraSnapshot('http://localhost:5000', 'slot-1')).rejects.toThrow('JPEG snapshot');
  });

  it('explains when an older running bridge needs a restart without masking an unknown camera', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) });
    vi.stubGlobal('fetch', fetch);
    await expect(getCameraSnapshot('http://localhost:5000', 'slot-1')).rejects.toThrow('Restart the local camera service');
    fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: 'Unknown camera' }) });
    await expect(getCameraSnapshot('http://localhost:5000', 'slot-1')).rejects.toThrow('HTTP 404');
  });

  it('forwards cancellation and removes the abort listener after the request', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const fetch = vi.fn().mockImplementation((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const request = getCameraSnapshot('http://localhost:5000', 'slot-1', controller.signal);
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('honors a signal that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, { signal }: RequestInit) => {
      expect(signal.aborted).toBe(true);
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }));
    await expect(getCameraSnapshot('http://localhost:5000', 'slot-1', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts a stalled capture after eight seconds and clears its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const request = getCameraSnapshot('http://localhost:5000', 'slot-1');
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(8000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
