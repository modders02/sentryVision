import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell, Camera, Film, Filter, FolderOpen, Settings, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { useCameraSlots } from '@/hooks/useCameraSlots';
import {
  CLIP_FOLDER_EVENT, CLIP_STATUS_EVENT, EMERGENCY_CLIP_SECONDS, NO_CLIP_FOLDER_MESSAGE,
  clipFolderSupported, forgetClipFolder, getClipFolderLabel, getClipRecordingStatus,
  pickClipFolder, restoreClipFolder, type ClipRecordingStatus,
} from '@/lib/clipRecorder';
import type { DetectionEvent, DetectionType } from '@/types/multicam';

const typeIcon: Record<DetectionType, string> = {
  fire: '🔥', smoke: '💨', human: '🧍', object: '📦',
  'face-distress': '😨', 'audio-distress': '🗣', saliency: '✨',
};
const EMERGENCY_TYPES = new Set<DetectionType>(['fire', 'smoke', 'face-distress', 'audio-distress']);

/** Camera alerts, past detections, and emergency clips shown beside live feeds. */
export default function DashboardEvents({ initialFilter, syncUrl = true, showAlerts = true }: { initialFilter?: string; syncUrl?: boolean; showAlerts?: boolean }) {
  const { events, clearEvents } = useCameraRegistry();
  const { activeSlots } = useCameraSlots();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = (syncUrl ? searchParams.get('events') : null) || initialFilter || 'all';
  const [filter, setFilter] = useState(requestedFilter);
  const [showSettings, setShowSettings] = useState(false);
  const [folder, setFolder] = useState(getClipFolderLabel);
  const [clipStatus, setClipStatus] = useState(getClipRecordingStatus);
  const [folderError, setFolderError] = useState('');
  const [viewingSnapshot, setViewingSnapshot] = useState<DetectionEvent | null>(null);
  const snapshotOpener = useRef<HTMLButtonElement | null>(null);

  const openSnapshot = (event: DetectionEvent, opener: HTMLButtonElement) => {
    snapshotOpener.current = opener;
    setViewingSnapshot(event);
  };

  useEffect(() => {
    const folderChanged = (event: Event) => setFolder((event as CustomEvent<string>).detail);
    const statusChanged = (event: Event) => setClipStatus((event as CustomEvent<ClipRecordingStatus>).detail);
    window.addEventListener(CLIP_FOLDER_EVENT, folderChanged);
    window.addEventListener(CLIP_STATUS_EVENT, statusChanged);
    void restoreClipFolder();
    return () => {
      window.removeEventListener(CLIP_FOLDER_EVENT, folderChanged);
      window.removeEventListener(CLIP_STATUS_EVENT, statusChanged);
    };
  }, []);

  useEffect(() => { setFilter(requestedFilter); }, [requestedFilter]);

  const cameraOptions = useMemo(() => {
    const names = new Map(activeSlots.map(slot => [`slot-${slot.index}`, slot.name || `Camera ${slot.index}`]));
    for (const event of events) if (!names.has(event.cameraId)) names.set(event.cameraId, event.cameraName);
    if (filter !== 'all' && !names.has(filter)) names.set(filter, /^slot-\d+$/.test(filter) ? `Camera ${filter.slice(5)}` : filter);
    return Array.from(names.entries());
  }, [activeSlots, events, filter]);
  const filtered = useMemo(() => filter === 'all' ? events : events.filter(event => event.cameraId === filter), [events, filter]);
  const alerts = useMemo(() => filtered.filter(event => EMERGENCY_TYPES.has(event.type)), [filtered]);

  const selectFilter = (value: string) => {
    setFilter(value);
    if (!syncUrl) return;
    const next = new URLSearchParams(searchParams);
    next.set('events', value);
    setSearchParams(next, { replace: true });
  };

  const chooseFolder = async () => {
    setFolderError('');
    try { setFolder(await pickClipFolder()); setClipStatus(null); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setFolderError(error instanceof Error ? error.message : 'Could not open the folder picker.');
    }
  };

  const clearFolder = async () => {
    setFolderError('');
    try { await forgetClipFolder(); }
    catch (error) { setFolderError(error instanceof Error ? error.message : 'Could not clear the recording folder.'); }
  };

  return (
    <section id="camera-events" className="min-w-0 space-y-4 scroll-mt-5" aria-label="Camera alerts and event history">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
        <label htmlFor="camera-event-filter" className="sr-only">Filter events by camera</label>
        <select id="camera-event-filter" value={filter} onChange={event => selectFilter(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm">
          <option value="all">All cameras</option>
          {cameraOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button onClick={() => setShowSettings(value => !value)} title="Recording settings" aria-label="Recording settings" aria-expanded={showSettings} className={`rounded-lg p-2 hover:bg-muted ${showSettings ? 'text-primary' : 'text-muted-foreground'}`}><Settings className="h-4 w-4" /></button>
        <button onClick={clearEvents} title="Clear event history" aria-label="Clear event history" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><Trash2 className="h-4 w-4" /></button>
      </div>

      {(clipStatus || !folder) && (
        <p role="status" aria-live="polite" className={`break-words rounded-lg border border-border px-3 py-2 text-sm ${clipStatus?.state === 'error' || !folder ? 'text-destructive' : 'text-muted-foreground'}`}>
          {clipStatus?.message || NO_CLIP_FOLDER_MESSAGE}
        </p>
      )}

      {showSettings && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Emergency recording settings</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={chooseFolder} disabled={!clipFolderSupported()} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-60"><FolderOpen className="h-4 w-4" /> Choose folder</button>
            <span className="text-sm text-muted-foreground">{folder ? `Saving to “${folder}”` : NO_CLIP_FOLDER_MESSAGE}</span>
          </div>
          {!clipFolderSupported() && <p className="text-xs text-muted-foreground">Choose a folder using the desktop app or a browser supporting folder access to enable automatic recording saves.</p>}
          {folder && <button onClick={clearFolder} className="text-xs text-muted-foreground underline">Clear recording folder</button>}
          {folderError && <p role="alert" className="text-xs text-destructive">{folderError}</p>}
          <p className="text-sm">Emergency clips record for {EMERGENCY_CLIP_SECONDS} seconds and save automatically to your selected folder.</p>
        </div>
      )}

      {showAlerts && <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3"><Bell className="h-4 w-4 text-destructive" /><h3 className="text-sm font-bold">Camera alerts</h3><span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{alerts.length}</span></div>
        <div className="max-h-64 divide-y divide-border overflow-y-auto">
          {alerts.length === 0 && <p className="p-4 text-sm text-muted-foreground">No camera alerts yet.</p>}
          {alerts.length > 0 && <p className="px-4 py-2 text-xs text-muted-foreground">Alerts clear automatically when the next alert starts a new batch after 50. Informational sightings have their own 50-event batch.</p>}
          {alerts.slice(0, 40).map(alert => (
            <div key={alert.id} className="min-w-0 space-y-1 p-3">
              <p className="break-words text-sm font-semibold">{typeIcon[alert.type]} {alert.label}</p>
              <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{alert.cameraName}</span>{alert.location ? ` · ${alert.location}` : ''}</p>
              <p className="text-xs text-muted-foreground">{(alert.confidence * 100).toFixed(0)}% confidence · {new Date(alert.timestamp).toLocaleString()}</p>
              {alert.snapshot && <button onClick={button => openSnapshot(alert, button.currentTarget)} aria-label={`View snapshot of ${alert.label} from ${alert.cameraName}`} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-muted"><Camera className="h-3.5 w-3.5" /> Snapshot</button>}
            </div>
          ))}
        </div>
      </div>}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3"><Film className="h-4 w-4 text-primary" /><h3 className="text-sm font-bold">Event history</h3><span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{filtered.length}</span></div>
        <div className="max-h-64 divide-y divide-border overflow-y-auto">
          {filtered.length === 0 && <p className="p-4 text-sm text-muted-foreground">No events recorded for {filter === 'all' ? 'your cameras' : 'this camera'}.</p>}
          {filtered.slice(0, 100).map(event => (
            <div key={event.id} className="flex items-start gap-3 p-3">
              {event.clipUrl ? (
                <video src={event.clipUrl} controls preload="none" poster={event.snapshot} aria-label={`${event.label} recording from ${event.cameraName}`} className="h-16 w-24 shrink-0 rounded-lg border border-border bg-background" />
              ) : event.snapshot ? (
                <button onClick={button => openSnapshot(event, button.currentTarget)} aria-label={`View event snapshot of ${event.label} from ${event.cameraName}`} className="shrink-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><img src={event.snapshot} loading="lazy" alt={`${event.type} snapshot from ${event.cameraName}`} className="h-14 w-20 rounded-lg border border-border object-cover" /></button>
              ) : (
                <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-muted text-lg" aria-hidden="true">{typeIcon[event.type]}</div>
              )}
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-semibold">{event.label}</p>
                <p className="truncate text-xs text-muted-foreground">{event.cameraName}{event.location ? ` · ${event.location}` : ''} · {(event.confidence * 100).toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</p>
                {event.clipFile && <p className="flex items-center gap-1 truncate text-xs text-primary"><Film className="h-3.5 w-3.5 shrink-0" /> {event.clipFile}</p>}
                {event.clipUrl && event.snapshot && <button onClick={button => openSnapshot(event, button.currentTarget)} aria-label={`View event snapshot of ${event.label} from ${event.cameraName}`} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-muted"><Camera className="h-3.5 w-3.5" /> Snapshot</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Dialog open={!!viewingSnapshot} onOpenChange={open => { if (!open) setViewingSnapshot(null); }}>
        <DialogContent className="max-w-3xl" onCloseAutoFocus={event => { event.preventDefault(); snapshotOpener.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>{viewingSnapshot?.label}</DialogTitle>
            <DialogDescription>{viewingSnapshot?.cameraName}{viewingSnapshot ? ` · ${new Date(viewingSnapshot.timestamp).toLocaleString()}` : ''}</DialogDescription>
          </DialogHeader>
          {viewingSnapshot?.snapshot && <img src={viewingSnapshot.snapshot} alt={`${viewingSnapshot.label} snapshot from ${viewingSnapshot.cameraName}`} className="max-h-[70vh] w-full rounded-lg object-contain" />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
