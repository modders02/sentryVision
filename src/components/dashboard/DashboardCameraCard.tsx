import { Bell, BellOff, Camera, ChevronRight, Ellipsis, Mic, Play, Settings2, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCameraSession } from '@/lib/cameraSessions';
import type { CameraSlot } from '@/hooks/useCameraSlots';

interface Props {
  slot: CameraSlot;
  monitoring: boolean;
  eventCount: number;
  onConnect: (index: number) => void;
  onToggleAi: (index: number) => void;
  mirror?: boolean;
  transcript?: string;
}

export default function DashboardCameraCard({ slot, monitoring, eventCount, onConnect, onToggleAi, mirror = false, transcript }: Props) {
  const navigate = useNavigate();
  const session = useCameraSession(`slot-${slot.index}`);
  const connected = session.runtime?.status === 'online';
  const configured = !!slot.connected || connected;
  const armed = configured && monitoring && slot.aiEnabled;
  const openCamera = () => configured ? navigate(`/cameras?camera=slot-${slot.index}`) : onConnect(slot.index);

  return (
    <article className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#151e24] p-3 text-white shadow-sm sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <button onClick={openCamera} className="min-w-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">
          <h3 className="truncate text-xl font-semibold tracking-tight">{slot.name || `Camera ${slot.index}`}</h3>
          <span className="text-sm text-slate-400">Camera {slot.index}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <span title={connected ? 'Camera online' : 'Camera offline'} className={`flex h-10 w-10 items-center justify-center rounded-full ${connected ? 'bg-sky-500 text-white' : 'bg-white/5 text-slate-400'}`}>
            {connected ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
          </span>
          <button onClick={() => onToggleAi(slot.index)} aria-label={`${slot.aiEnabled ? 'Disable' : 'Enable'} AI detection for ${slot.name}`} title="Toggle AI detection" className={`flex h-10 w-10 items-center justify-center rounded-full ${armed ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 text-slate-400'} focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400`}>
            <ShieldCheck className="h-5 w-5" />
          </button>
          <button onClick={() => onConnect(slot.index)} aria-label={`Camera settings for ${slot.name}`} title="Camera connection settings" className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-slate-300 text-slate-200 transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">
            <Ellipsis className="h-6 w-6" />
          </button>
        </div>
      </div>

      <button onClick={openCamera} aria-label={configured ? `Open live feed for ${slot.name}` : `Connect ${slot.name} to CCTV`} className="relative block aspect-video w-full overflow-hidden rounded-xl bg-[#0b1219] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">
        {session.preview ? (
          <img src={session.preview} alt={`Last seen image from ${slot.name}`} className={`h-full w-full object-cover ${connected ? '' : 'opacity-50'}`} style={{ transform: mirror ? 'scaleX(-1)' : undefined }} />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_#243846_0%,_#0b1219_75%)]" />
        )}
        <span className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white">
          {armed ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          {armed ? 'Monitoring' : 'Disarmed'}
        </span>
        {session.previewTimestamp && (
          <time dateTime={new Date(session.previewTimestamp).toISOString()} aria-label={`Last seen ${new Date(session.previewTimestamp).toLocaleString()}`} className="absolute right-3 top-4 max-w-[50%] rounded bg-black/35 px-1.5 text-right text-xs tabular-nums text-white">
            {new Date(session.previewTimestamp).toLocaleString()}
          </time>
        )}
        {(!connected || !session.preview) && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            {!session.preview && <Camera className="h-10 w-10 text-slate-500" />}
            <span className="text-xl font-semibold">{configured ? (connected ? 'No saved image yet' : session.runtime?.status === 'connecting' ? 'Connecting' : 'Camera offline') : 'Device offline'}</span>
            <span className="text-sm text-slate-300">{configured ? 'Open camera to view live video' : 'Click to connect your CCTV'}</span>
          </span>
        )}
        <span className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8 text-sm text-white">
          <span>ID: {slot.index.toString().padStart(2, '0')}</span>
          <span className="rounded bg-black/40 px-2 py-0.5">Last seen</span>
        </span>
      </button>

      <div className="flex items-center divide-x divide-white/15 pt-3">
        <button onClick={() => navigate(`/cameras?camera=slot-${slot.index}&events=slot-${slot.index}`)} className="flex flex-1 items-center gap-2.5 py-1 pr-3 text-left transition-colors hover:text-rose-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500"><Bell className="h-5 w-5 fill-white" /></span>
          <span>Events{eventCount > 0 ? ` (${eventCount})` : ''}</span>
        </button>
        <button onClick={openCamera} className="flex flex-1 items-center justify-end gap-2.5 py-1 pl-3 text-sky-400 transition-colors hover:text-sky-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white">{configured ? <Play className="h-5 w-5 fill-white" /> : <Settings2 className="h-5 w-5" />}</span>
          <span>{configured ? 'Live view' : 'Connect CCTV'}</span>
          <ChevronRight className="hidden h-5 w-5 shrink-0 sm:block" />
        </button>
      </div>
      <div id={slot.index === 1 ? 'tour-live-transcription' : undefined} className="mt-3 flex items-start gap-2 rounded-lg bg-black/20 px-3 py-2 text-sm text-slate-300">
        <Mic className={`mt-0.5 h-4 w-4 shrink-0 ${session.runtime?.audioListening ? 'text-cyan-400' : 'text-slate-500'}`} />
        <p aria-live="polite" className="min-w-0 break-words">{transcript || session.runtime?.transcript || session.runtime?.audioMessage || 'Connect this camera to start listening.'}</p>
      </div>
    </article>
  );
}
