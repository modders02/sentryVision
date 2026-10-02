import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Camera, Columns2, Grid2x2, LayoutDashboard, VideoOff } from 'lucide-react';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { useCamera } from '@/hooks/useCamera';
import { useCameraSlots, slotCamera, slotSettings, type CameraSlot } from '@/hooks/useCameraSlots';
import LiveCameraFeed from '@/components/multicam/LiveCameraFeed';
import DashboardEvents from '@/components/dashboard/DashboardEvents';

/** Displays existing monitoring sessions; changing the view never starts another pipeline. */
export default function Monitoring() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { settings } = useCameraRegistry();
  const { slots, count } = useCameraSlots();
  const { cameras } = useCamera();
  const requestedCamera = searchParams.get('camera');
  const isConnected = (slot: CameraSlot) => !!cameras[slot.index - 1]?.active || !!(slot.ip.trim() && slot.connected);
  const includedSlots = slots.filter(slot => slot.index <= count || isConnected(slot) || requestedCamera === `slot-${slot.index}`);
  const [columns, setColumns] = useState<1 | 2>(2);
  const focused = includedSlots.some(slot => `slot-${slot.index}` === requestedCamera) ? requestedCamera : null;
  const visible = focused ? includedSlots.filter(slot => `slot-${slot.index}` === focused) : includedSlots;
  const connected = includedSlots.filter(isConnected);

  useEffect(() => {
    if (searchParams.has('events')) {
      document.getElementById('camera-events')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }, [searchParams]);

  const selectCamera = (cameraId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (cameraId) next.set('camera', cameraId);
    else next.delete('camera');
    next.delete('events');
    setSearchParams(next);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/60 px-4 py-4 backdrop-blur-sm sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Camera className="h-5 w-5" /></span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Live cameras</h1>
            <p className="text-sm text-muted-foreground">{connected.length} connected camera{connected.length === 1 ? '' : 's'}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!focused && (
            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1" aria-label="Live camera layout">
              <button onClick={() => setColumns(1)} aria-label="One column" aria-pressed={columns === 1} className={`rounded-md p-2 transition-colors ${columns === 1 ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}><Columns2 className="h-4 w-4 rotate-90" /></button>
              <button onClick={() => setColumns(2)} aria-label="Camera grid" aria-pressed={columns === 2} className={`rounded-md p-2 transition-colors ${columns === 2 ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}><Grid2x2 className="h-4 w-4" /></button>
            </div>
          )}
          <button onClick={() => navigate('/dashboard')} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-muted"><LayoutDashboard className="h-4 w-4" /> Dashboard</button>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {focused ? (
            <button onClick={() => selectCamera(null)} className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All live cameras</button>
          ) : (
            <p className="text-sm text-muted-foreground">Select a camera to open its live feed, alerts, and event history.</p>
          )}
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            View
            <select aria-label="Choose live camera" value={focused || 'all'} onChange={event => selectCamera(event.target.value === 'all' ? null : event.target.value)} className="rounded-lg border border-border bg-card px-3 py-2 text-foreground">
              <option value="all">All cameras</option>
              {includedSlots.map(slot => <option key={slot.index} value={`slot-${slot.index}`}>{slot.name || `Camera ${slot.index}`}</option>)}
            </select>
          </label>
        </div>

        <div className={`grid gap-5 ${focused || columns === 1 ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'}`}>
          {visible.map(slot => isConnected(slot) ? (
            <LiveCameraFeed key={slot.index} camera={slotCamera(slot)} settings={slotSettings(slot, settings)} onExpand={focused ? undefined : selectCamera} onConnect={() => navigate(`/dashboard?connect=${slot.index}`)} />
          ) : (
            <button key={slot.index} onClick={() => navigate(`/dashboard?connect=${slot.index}`)} className="flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-card/60 p-8 text-center transition-colors hover:border-primary hover:bg-primary/5">
              <VideoOff className="h-8 w-8 text-muted-foreground" />
              <span className="text-lg font-semibold">{slot.name || `Camera ${slot.index}`}</span>
              <span className="text-sm text-muted-foreground">Camera not connected</span>
              <span className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Connect CCTV</span>
            </button>
          ))}
        </div>
        <DashboardEvents initialFilter={focused || 'all'} />
      </main>
    </div>
  );
}
