/** Emergency clips save only to an explicitly selected folder. Alert handling never prompts. */
import { isDesktop } from '@/lib/desktop';

const FOLDER_LABEL_KEY = 'msds-clip-folder-label';
const DATABASE_NAME = 'msds-emergency-clips';
const STORE_NAME = 'settings';
export const EMERGENCY_CLIP_SECONDS = 10;
export const NO_CLIP_FOLDER_MESSAGE = 'No folder to save record';
export const CLIP_STATUS_EVENT = 'msds-clip-status';
export const CLIP_FOLDER_EVENT = 'msds-clip-folder';

type DirHandle = {
  name: string;
  requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  queryPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }>;
  }>;
};

export interface ClipRecordingStatus {
  state: 'recording' | 'saved' | 'error';
  message: string;
  filename?: string;
}

let folder: DirHandle | null = null;
let folderLabel = '';
let folderLoaded = false;
let folderVersion = 0;
let loadingFolder: Promise<string> | null = null;
let status: ClipRecordingStatus | null = null;

export function reportClipStatus(next: ClipRecordingStatus) {
  status = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CLIP_STATUS_EVENT, { detail: next }));
}
export const getClipRecordingStatus = () => status;
export const clipFolderSupported = () => typeof window !== 'undefined' && (
  (isDesktop() && typeof window.msds?.chooseClipFolder === 'function') ||
  typeof (window as unknown as Record<string, unknown>).showDirectoryPicker === 'function'
);
export const getClipFolderLabel = () => {
  if (folderLoaded) return folderLabel;
  try { return localStorage.getItem(FOLDER_LABEL_KEY) || ''; } catch { return ''; }
};
function updateFolderLabel(label: string) {
  folderLabel = label;
  try {
    if (label) localStorage.setItem(FOLDER_LABEL_KEY, label);
    else localStorage.removeItem(FOLDER_LABEL_KEY);
  } catch { /* The folder still works for this session if storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(CLIP_FOLDER_EVENT, { detail: label }));
}
export const getClipSeconds = () => EMERGENCY_CLIP_SECONDS;

function storedFolder(action: 'read' | 'write' | 'delete', handle?: DirHandle): Promise<DirHandle | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE_NAME, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE_NAME)) opening.result.createObjectStore(STORE_NAME);
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      try {
        const transaction = database.transaction(STORE_NAME, action === 'read' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = action === 'read' ? store.get('folder') : action === 'write' ? store.put(handle, 'folder') : store.delete('folder');
        transaction.oncomplete = () => { database.close(); resolve(action === 'read' ? request.result || null : null); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      } catch (error) { database.close(); reject(error); }
    };
  });
}

/** Restore an existing handle without opening a picker or requesting permission. */
export async function restoreClipFolder(): Promise<string> {
  if (folderLoaded) return folderLabel;
  if (loadingFolder) return loadingFolder;
  const version = folderVersion;
  loadingFolder = (async () => {
    let label = '';
    let restored: DirHandle | null = null;
    try {
      if (isDesktop()) label = await window.msds!.getClipFolder() || '';
      else { restored = await storedFolder('read'); label = restored?.name || ''; }
    } catch { /* Missing persistence is equivalent to no selected folder. */ }
    if (version === folderVersion) {
      folder = restored;
      folderLoaded = true;
      updateFolderLabel(label);
    }
    return getClipFolderLabel();
  })().finally(() => { loadingFolder = null; });
  return loadingFolder;
}

/** Only the explicit Choose folder settings button may invoke this permission flow. */
export async function pickClipFolder(): Promise<string> {
  if (isDesktop()) {
    const chosen = await window.msds!.chooseClipFolder();
    if (chosen === null) return getClipFolderLabel();
    folderVersion++;
    folderLoaded = true;
    updateFolderLabel(chosen);
    return chosen;
  }
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) throw new Error('Folder selection requires the desktop app or a browser supporting folder access.');
  const handle = await picker({ id: 'msds-clips', mode: 'readwrite' });
  const permission = await handle.queryPermission?.({ mode: 'readwrite' });
  if (permission !== 'granted' && handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
    throw new Error('Recording folder access was not granted. Choose a folder to enable automatic saving.');
  }
  folderVersion++;
  folderLoaded = true;
  folder = handle;
  updateFolderLabel(handle.name);
  try { await storedFolder('write', handle); } catch { /* Keep the selected handle for this session. */ }
  return handle.name;
}

export async function forgetClipFolder() {
  folderVersion++;
  folderLoaded = true;
  folder = null;
  if (isDesktop()) await window.msds!.forgetClipFolder();
  else { try { await storedFolder('delete'); } catch { /* Storage may be disabled. */ } }
  updateFolderLabel('');
  reportClipStatus({ state: 'error', message: NO_CLIP_FOLDER_MESSAGE });
}

function pickMimeType() {
  const options = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];
  return options.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || '';
}

/** Record the existing feed, without stopping or reopening the camera stream. */
export function recordClip(video: HTMLVideoElement, seconds = EMERGENCY_CLIP_SECONDS): Promise<Blob | null> {
  reportClipStatus({ state: 'recording', message: `Recording a ${seconds} second clip…` });
  return new Promise(resolve => {
    let timer: number | undefined;
    let finished = false;
    const finish = (blob: Blob | null) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (!blob) reportClipStatus({ state: 'error', message: 'Could not record a clip from this camera.' });
      resolve(blob);
    };
    try {
      const capturable = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
      const stream = typeof MediaStream !== 'undefined' && video.srcObject instanceof MediaStream
        ? video.srcObject : (capturable.captureStream || capturable.mozCaptureStream)?.call(video);
      if (!stream || stream.getTracks().length === 0) return finish(null);
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const parts: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      recorder.onstop = () => finish(parts.length ? new Blob(parts, { type: recorder.mimeType || 'video/webm' }) : null);
      recorder.onerror = () => finish(null);
      recorder.start();
      timer = window.setTimeout(() => { try { recorder.stop(); } catch { finish(null); } }, seconds * 1000);
    } catch { finish(null); }
  });
}

/** Save using existing permissions only. Never prompt or fall back to a download. */
export async function saveClip(blob: Blob, filename: string): Promise<string> {
  try {
    await restoreClipFolder();
    if (!getClipFolderLabel()) throw new Error(NO_CLIP_FOLDER_MESSAGE);
    let location: string;
    if (isDesktop()) location = await window.msds!.saveClip(await blob.arrayBuffer(), filename);
    else {
      if (!folder) throw new Error(NO_CLIP_FOLDER_MESSAGE);
      if (folder.queryPermission && await folder.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('Recording folder access expired. Choose the folder again in recording settings.');
      }
      const file = await folder.getFileHandle(filename, { create: true });
      const writable = await file.createWritable();
      try { await writable.write(blob); await writable.close(); }
      catch (error) { try { await writable.abort?.(); } catch { /* Keep the original error. */ } throw error; }
      location = folder.name;
    }
    reportClipStatus({ state: 'saved', message: `Clip saved to ${location}`, filename });
    return location;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save the recording to the selected folder.';
    reportClipStatus({ state: 'error', message, filename });
    throw error instanceof Error ? error : new Error(message);
  }
}

export const clipFileName = (cameraName: string, type: string, mimeType = 'video/webm') =>
  `${cameraName.replace(/[^\w-]+/g, '_')}-${type.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.${mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
