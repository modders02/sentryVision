/** Restricts recording writes to the explicitly selected directory. Never opens a dialog. */
const fs = require('node:fs/promises');
const path = require('node:path');

function createClipStorage(settingsPath, filesystem = fs) {
  let folder;
  async function getFolder() {
    if (folder !== undefined) return folder;
    try {
      const saved = JSON.parse(await filesystem.readFile(settingsPath, 'utf8'));
      folder = typeof saved.folder === 'string' && path.isAbsolute(saved.folder) ? path.resolve(saved.folder) : null;
    } catch { folder = null; }
    return folder;
  }
  async function setFolder(directory) {
    if (directory !== null && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new Error('Invalid recording folder.');
    const normalized = directory === null ? null : path.resolve(directory);
    await filesystem.writeFile(settingsPath, JSON.stringify({ folder: normalized }), 'utf8');
    folder = normalized;
    return folder;
  }
  async function save(data, filename) {
    const directory = await getFolder();
    if (!directory) throw new Error('No folder to save record');
    if (typeof filename !== 'string' || filename.length > 240 || !/^[\w-]+\.(?:webm|mp4)$/.test(filename)) throw new Error('Invalid recording filename.');
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Invalid recording data.');
    const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (!bytes.length || bytes.length > 256 * 1024 * 1024) throw new Error('Invalid recording size.');
    const destination = path.join(directory, filename);
    if (path.dirname(destination) !== directory) throw new Error('Invalid recording destination.');
    try {
      if (!(await filesystem.stat(directory)).isDirectory()) throw new Error('Folder unavailable');
      await filesystem.writeFile(destination, bytes, { flag: 'wx' });
    } catch (error) {
      throw new Error(`Could not save the recording to the selected folder (${error.code || error.message}). Choose a writable folder in recording settings.`);
    }
    return directory;
  }
  return { getFolder, setFolder, save };
}
module.exports = { createClipStorage };
