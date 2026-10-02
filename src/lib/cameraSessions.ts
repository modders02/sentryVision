import { useCallback, useSyncExternalStore } from 'react';
import type { CameraRuntime } from '@/types/multicam';

/** One playback and detection session, shared by the dashboard and live view. */
export interface CameraSession {
  video: HTMLVideoElement | null;
  home: HTMLElement | null;
  runtime: CameraRuntime | null;
  preview: string | null;
  previewTimestamp: number | null;
  reconnect: (() => void) | null;
}

const EMPTY_SESSION: CameraSession = {
  video: null,
  home: null,
  runtime: null,
  preview: null,
  previewTimestamp: null,
  reconnect: null,
};

const sessions = new Map<string, CameraSession>();
const listeners = new Map<string, Set<() => void>>();
const restored = new Set<string>();
const STILL_STORAGE_KEY = 'msds-camera-last-seen-v1';
const SLOT_IDS = ['slot-1', 'slot-2', 'slot-3', 'slot-4'];
const MAX_IMAGE_LENGTH = 200_000;
const MAX_STORED_LENGTH = 4 * (MAX_IMAGE_LENGTH + 256);
type StoredStill = Pick<CameraSession, 'preview' | 'previewTimestamp'>;

function validStill(value: unknown): value is { preview: string; previewTimestamp: number } {
  if (!value || typeof value !== 'object') return false;
  const still = value as StoredStill;
  return typeof still.preview === 'string' && still.preview.length <= MAX_IMAGE_LENGTH
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(still.preview)
    && typeof still.previewTimestamp === 'number' && Number.isFinite(still.previewTimestamp)
    && still.previewTimestamp > 0 && still.previewTimestamp <= 8.64e15;
}

function readStoredStills(): Record<string, StoredStill> {
  try {
    const raw = localStorage.getItem(STILL_STORAGE_KEY);
    if (!raw || raw.length > MAX_STORED_LENGTH) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const valid: Record<string, StoredStill> = {};
    for (const id of SLOT_IDS) {
      if (validStill(parsed[id])) valid[id] = { preview: parsed[id].preview, previewTimestamp: parsed[id].previewTimestamp };
    }
    return valid;
  } catch {
    return {};
  }
}

function persistStill(id: string, session: CameraSession): void {
  if (!SLOT_IDS.includes(id)) return;
  try {
    const saved = readStoredStills();
    if (validStill(session)) saved[id] = { preview: session.preview, previewTimestamp: session.previewTimestamp };
    else delete saved[id];
    if (Object.keys(saved).length) localStorage.setItem(STILL_STORAGE_KEY, JSON.stringify(saved));
    else localStorage.removeItem(STILL_STORAGE_KEY);
  } catch {
    // Storage limits or browser privacy settings do not interrupt monitoring.
  }
}

export function getCameraSession(id: string): CameraSession {
  if (!restored.has(id)) {
    restored.add(id);
    const saved = SLOT_IDS.includes(id) ? readStoredStills()[id] : undefined;
    if (saved && !sessions.has(id)) sessions.set(id, { ...EMPTY_SESSION, ...saved });
  }
  return sessions.get(id) ?? EMPTY_SESSION;
}

export function publishCameraSession(id: string, patch: Partial<CameraSession>): void {
  const previous = getCameraSession(id);
  if (Object.keys(patch).every(key => previous[key as keyof CameraSession] === patch[key as keyof CameraSession])) return;
  const next = { ...previous, ...patch };
  sessions.set(id, next);
  if (next.preview !== previous.preview || next.previewTimestamp !== previous.previewTimestamp) persistStill(id, next);
  listeners.get(id)?.forEach(listener => listener());
}

/** Save a durable image only at a viewing boundary or the first connection. */
export function saveCameraStill(id: string, preview: string, previewTimestamp: number, onlyIfEmpty = false): void {
  const previous = getCameraSession(id);
  if (onlyIfEmpty && previous.preview) return;
  if (previous.previewTimestamp !== null && previewTimestamp < previous.previewTimestamp) return;
  publishCameraSession(id, { preview, previewTimestamp });
}

/** Keep the last still image when its stream stops or a slot is removed. */
export function clearCameraSession(id: string, video?: HTMLVideoElement): void {
  if (video && getCameraSession(id).video !== video) return;
  publishCameraSession(id, { video: null, home: null, runtime: null, reconnect: null });
}

export function useCameraSession(id: string): CameraSession {
  const subscribe = useCallback((listener: () => void) => {
    let cameraListeners = listeners.get(id);
    if (!cameraListeners) {
      cameraListeners = new Set();
      listeners.set(id, cameraListeners);
    }
    cameraListeners.add(listener);
    return () => {
      cameraListeners.delete(listener);
      if (!cameraListeners.size) listeners.delete(id);
    };
  }, [id]);
  const getSnapshot = useCallback(() => getCameraSession(id), [id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
