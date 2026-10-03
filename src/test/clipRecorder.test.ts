import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function directory() {
  const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn() };
  const handle = {
    name: 'Emergency clips',
    queryPermission: vi.fn().mockResolvedValue('granted'),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    getFileHandle: vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(writable) }),
  };
  return { handle, writable };
}

/** Minimal storage adapter: verifies the handle survives a fresh recorder module, not just its label. */
function folderDatabase() {
  const values = new Map();
  const database = {
    objectStoreNames: { contains: () => true }, createObjectStore: vi.fn(), close: vi.fn(),
    transaction: () => {
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        objectStore: () => ({
          get: (key: string) => ({ result: values.get(key) }),
          put: (value: unknown, key: string) => { values.set(key, value); return {}; },
          delete: (key: string) => { values.delete(key); return {}; },
        }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  return {
    open: vi.fn(() => {
      const request = { result: database, onsuccess: undefined as (() => void) | undefined };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete window.msds;
  vi.stubGlobal('indexedDB', undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.msds; });

describe('automatic emergency clip saving', () => {
  it('shows the exact missing-folder error without opening any picker or download', async () => {
    const picker = vi.fn();
    vi.stubGlobal('showDirectoryPicker', picker);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const recorder = await import('@/lib/clipRecorder');
    await expect(recorder.saveClip(new Blob(['clip']), 'camera-fire.webm')).rejects.toThrow('No folder to save record');
    expect(recorder.getClipRecordingStatus()).toMatchObject({ state: 'error', message: 'No folder to save record' });
    expect(picker).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });

  it('saves automatically into the explicitly selected folder with no further permission prompts', async () => {
    const { handle, writable } = directory();
    const picker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal('showDirectoryPicker', picker);
    const recorder = await import('@/lib/clipRecorder');
    await recorder.pickClipFolder();
    picker.mockClear();
    const blob = new Blob(['clip']);
    await expect(recorder.saveClip(blob, 'camera-fire.webm')).resolves.toBe(handle.name);
    expect(handle.getFileHandle).toHaveBeenCalledWith('camera-fire.webm', { create: true });
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(handle.requestPermission).not.toHaveBeenCalled();
    expect(picker).not.toHaveBeenCalled();
    expect(recorder.getClipRecordingStatus()?.state).toBe('saved');
  });

  it('reports revoked permission instead of requesting it or downloading the clip', async () => {
    const { handle } = directory();
    const picker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal('showDirectoryPicker', picker);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const recorder = await import('@/lib/clipRecorder');
    await recorder.pickClipFolder();
    picker.mockClear();
    handle.queryPermission.mockResolvedValue('prompt');
    await expect(recorder.saveClip(new Blob(['clip']), 'camera-fire.webm')).rejects.toThrow('folder access expired');
    expect(handle.requestPermission).not.toHaveBeenCalled();
    expect(handle.getFileHandle).not.toHaveBeenCalled();
    expect(picker).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });

  it('restores the actual selected handle after reload without invoking the picker', async () => {
    vi.stubGlobal('indexedDB', folderDatabase());
    const { handle, writable } = directory();
    const picker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal('showDirectoryPicker', picker);
    let recorder = await import('@/lib/clipRecorder');
    await recorder.pickClipFolder();
    vi.resetModules();
    picker.mockClear();
    recorder = await import('@/lib/clipRecorder');
    await expect(recorder.saveClip(new Blob(['after reload']), 'camera-fire.webm')).resolves.toBe(handle.name);
    expect(writable.write).toHaveBeenCalledOnce();
    expect(picker).not.toHaveBeenCalled();
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('discards a stale label when no persisted folder handle exists', async () => {
    localStorage.setItem('msds-clip-folder-label', 'Old folder');
    const recorder = await import('@/lib/clipRecorder');
    await expect(recorder.saveClip(new Blob(['clip']), 'camera-fire.webm')).rejects.toThrow('No folder to save record');
    expect(recorder.getClipFolderLabel()).toBe('');
  });

  it('aborts a failed write and reports the failure without a download fallback', async () => {
    const { handle, writable } = directory();
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(handle));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const recorder = await import('@/lib/clipRecorder');
    await recorder.pickClipFolder();
    writable.write.mockRejectedValue(new Error('Disk full'));
    await expect(recorder.saveClip(new Blob(['clip']), 'camera-fire.webm')).rejects.toThrow('Disk full');
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(recorder.getClipRecordingStatus()?.message).toBe('Disk full');
    expect(clicked).not.toHaveBeenCalled();
  });

  it('uses the desktop persisted folder without invoking its native chooser', async () => {
    const bridge = {
      isElectron: true as const,
      getClipFolder: vi.fn().mockResolvedValue('C:\\Emergency clips'),
      chooseClipFolder: vi.fn(),
      saveClip: vi.fn().mockResolvedValue('C:\\Emergency clips'),
    };
    window.msds = bridge as unknown as NonNullable<Window['msds']>;
    const recorder = await import('@/lib/clipRecorder');
    const bytes = new ArrayBuffer(3);
    const blob = { arrayBuffer: async () => bytes } as Blob;
    await expect(recorder.saveClip(blob, 'camera-fire.webm')).resolves.toBe('C:\\Emergency clips');
    expect(bridge.saveClip).toHaveBeenCalledWith(bytes, 'camera-fire.webm');
    expect(bridge.chooseClipFolder).not.toHaveBeenCalled();
  });

  it('records ten seconds from an existing stream and leaves its source tracks running', async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    class Stream { getTracks = () => [{ stop: stopTrack }]; }
    const stopRecorder = vi.fn();
    class Recorder {
      static isTypeSupported = () => true;
      mimeType = 'video/webm';
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start = vi.fn();
      stop = () => { stopRecorder(); this.ondataavailable?.({ data: new Blob(['clip']) }); this.onstop?.(); };
    }
    vi.stubGlobal('MediaStream', Stream);
    vi.stubGlobal('MediaRecorder', Recorder);
    const video = document.createElement('video');
    video.srcObject = new Stream() as unknown as MediaStream;
    const recorder = await import('@/lib/clipRecorder');
    localStorage.setItem('msds-clip-seconds', '30');
    expect(recorder.getClipSeconds()).toBe(10);
    const result = recorder.recordClip(video);
    await vi.advanceTimersByTimeAsync(9999);
    expect(stopRecorder).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result)?.size).toBeGreaterThan(0);
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(stopTrack).not.toHaveBeenCalled();
  });
});
