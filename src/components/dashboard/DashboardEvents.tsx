import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell, Film, Filter, FolderOpen, Settings, Trash2 } from 'lucide-react';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { useCameraSlots } from '@/hooks/useCameraSlots';
import { clipFolderSupported, getClipFolderLabel, getClipSeconds, pickClipFolder, setClipSeconds } from '@/lib/clipRecorder';
import type { DetectionType } from '@/types/multicam';

const typeIcon: Record<DetectionType, string> = {
  fire: '🔥', smoke: '💨', human: '🧍', object: '📦',
  'face-distress': '😨', 'audio-distress': '🗣', saliency: '✨',
};
const EMERGENCY_TYPES = new Set<DetectionType>(['fire', 'smoke', 'face-distress', 'audio-distress']);

/** Camera alerts, past detections, and emergency clips shown beside live feeds. */
export default function DashboardEvents({ initialFilter }: { initialFilter?: string }) {
  const { events, clearEvents } = useCameraRegistry();
  const { activeSlots } = useCameraSlots();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get('events') || initialFilter || 'all';
  const [filter, setFilter] = useState(requestedFilter);
  const [showSettings, setShowSettings] = useState(false);
  const [folder, setFolder] = useState(getClipFolderLabel);
  const [seconds, setSeconds] = useState(getClipSeconds);
  const [folderError, setFolderError] = useState('');

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
    const next = new URLSearchParams(searchParams);
    next.set('events', value);
    setSearchParams(next, { replace: true });
  };

  const chooseFolder = async () => {
    setFolderError('');
    try { setFolder(await pickClipFolder()); }
    catch (error) { setFolderError(error instanceof Error ? error.message : 'Could not open the folder picker.'); }
  };

  return (
    <section id="camera-events" className="space-y-4 scroll-mt-5" aria-label="Camera alerts and event history">
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

      {showSettings && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Emergency recording settings</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={chooseFolder} disabled={!clipFolderSupported()} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-60"><FolderOpen className="h-4 w-4" /> Choose folder</button>
            <span className="text-sm text-muted-foreground">{folder ? `Saving to “${folder}”` : 'Saving to your Downloads folder'}</span>
          </div>
          {!clipFolderSupported() && <p className="text-xs text-muted-foreground">This browser saves clips to Downloads.</p>}
          {folderError && <p role="alert" className="text-xs text-destructive">{folderError}</p>}
          <label className="block text-sm font-semibold">Clip length: {seconds} seconds
            <input aria-label="Emergency clip length in seconds" type="range" min={5} max={30} step={5} value={seconds} onChange={event => { const value = Number(event.target.value); setSeconds(value); setClipSeconds(value); }} className="mt-2 w-full" />
          </label>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3"><Bell className="h-4 w-4 text-destructive" /><h3 className="text-sm font-bold">Camera alerts</h3><span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{alerts.length}</span></div>
        <div className="max-h-64 divide-y divide-border overflow-y-auto">
          {alerts.length === 0 && <p className="p-4 text-sm text-muted-foreground">No camera alerts yet.</p>}
          {alerts.slice(0, 40).map(alert => (
            <div key={alert.id} className="space-y-1 p-3">
              <p className="text-sm font-semibold">{typeIcon[alert.type]} {alert.label}</p>
              <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{alert.cameraName}</span>{alert.location ? ` · ${alert.location}` : ''}</p>
              <p className="text-xs text-muted-foreground">{(alert.confidence * 100).toFixed(0)}% confidence · {new Date(alert.timestamp).toLocaleString()}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3"><Film className="h-4 w-4 text-primary" /><h3 className="text-sm font-bold">Event history</h3><span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{filtered.length}</span></div>
        <div className="max-h-[420px] divide-y divide-border overflow-y-auto">
          {filtered.length === 0 && <p className="p-4 text-sm text-muted-foreground">No events recorded for {filter === 'all' ? 'your cameras' : 'this camera'}.</p>}
          {filtered.slice(0, 100).map(event => (
            <div key={event.id} className="flex items-start gap-3 p-3">
              {event.clipUrl ? (
                <video src={event.clipUrl} controls preload="none" poster={event.snapshot} aria-label={`${event.label} recording from ${event.cameraName}`} className="h-16 w-24 shrink-0 rounded-lg border border-border bg-background" />
              ) : event.snapshot ? (
                <img src={event.snapshot} loading="lazy" alt={`${event.type} snapshot from ${event.cameraName}`} className="h-14 w-20 shrink-0 rounded-lg border border-border object-cover" />
              ) : (
                <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-muted text-lg" aria-hidden="true">{typeIcon[event.type]}</div>
              )}
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-semibold">{event.label}</p>
                <p className="truncate text-xs text-muted-foreground">{event.cameraName}{event.location ? ` · ${event.location}` : ''} · {(event.confidence * 100).toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</p>
                {event.clipFile && <p className="flex items-center gap-1 truncate text-xs text-primary"><Film className="h-3.5 w-3.5 shrink-0" /> {event.clipFile}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
