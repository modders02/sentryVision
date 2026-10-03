import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createClipStorage } = require('../../electron/clipStorage.cjs');
const selectedFolder = path.resolve('emergency-clips');
const settingsPath = path.resolve('recording-folder.json');

function filesystem(savedFolder: string | null = null) {
  return {
    readFile: vi.fn().mockResolvedValue(JSON.stringify({ folder: savedFolder })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  };
}

describe('desktop emergency recording storage', () => {
  it('rejects recording without a configured folder before writing anything', async () => {
    const fs = filesystem();
    const storage = createClipStorage(settingsPath, fs);
    await expect(storage.save(new Uint8Array([1]), 'camera-fire.webm')).rejects.toThrow('No folder to save record');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('loads the persisted selected folder and writes only inside it', async () => {
    const fs = filesystem(selectedFolder);
    const storage = createClipStorage(settingsPath, fs);
    await expect(storage.save(new Uint8Array([1, 2]), 'camera-fire.webm')).resolves.toBe(selectedFolder);
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(selectedFolder, 'camera-fire.webm'), expect.any(Buffer), { flag: 'wx' });
  });

  it('persists explicit folder selection and removal', async () => {
    const fs = filesystem();
    const storage = createClipStorage(settingsPath, fs);
    await storage.setFolder(selectedFolder);
    expect(fs.writeFile).toHaveBeenCalledWith(settingsPath, JSON.stringify({ folder: selectedFolder }), 'utf8');
    await expect(storage.getFolder()).resolves.toBe(selectedFolder);
    await storage.setFolder(null);
    await expect(storage.save(new Uint8Array([1]), 'camera-fire.webm')).rejects.toThrow('No folder to save record');
  });

  it.each(['../escape.webm', '..\\escape.webm', 'C:\\escape.webm', 'camera.exe'])('rejects unsafe recording names: %s', async filename => {
    const fs = filesystem(selectedFolder);
    await expect(createClipStorage(settingsPath, fs).save(new Uint8Array([1]), filename)).rejects.toThrow('Invalid recording filename');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('reports a missing or unwritable folder without attempting another destination', async () => {
    const fs = filesystem(selectedFolder);
    fs.stat.mockRejectedValue(Object.assign(new Error('Missing'), { code: 'ENOENT' }));
    await expect(createClipStorage(settingsPath, fs).save(new Uint8Array([1]), 'camera-fire.webm')).rejects.toThrow('selected folder (ENOENT)');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
