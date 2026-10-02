import { useCallback, useEffect, useRef, useState } from 'react';
import PrefetchModelsButton from '@/components/dashboard/PrefetchModelsButton';
import {
  Play, Square, RefreshCw, CheckCircle2, XCircle, Loader2, Grid2x2,
  Square as SquareIcon, Columns2, Brain,
  ChevronDown, ChevronUp, Eye, EyeOff, Copy, Check, Wifi,
} from 'lucide-react';
import {
  backendHint,
  getMultiStatus,
  startCamera,
  stopCamera,
  syncCameras,
  testCamera,
  type BackendCameraStatus,
  type BackendStatus,
} from '@/lib/multiCamServer';
import {
  useCameraSlots,
  slotPath,
  slotRtsp,
  slotRtspMasked,
  AUTO_RTSP_PORTS,
  AUTO_RTSP_PATHS,
  loadServerHost,
  serverUrlFor,
  DEFAULT_RTSP_PORT,
  DEFAULT_STREAM_PATH,
  type CameraSlot,
  type SlotCount,
} from '@/hooks/useCameraSlots';
import IpAddressHelp from './IpAddressHelp';
import IdleHint from '@/components/IdleHint';

interface Props {
  selectedSlot?: number;
}

const Dot = ({ ok, label }: { ok: boolean; label: string }) => (
  <span className="flex items-center gap-1.5 text-[14px] font-semibold">
    {ok ? <CheckCircle2 className="w-4 h-4 text-success" /> : <XCircle className="w-4 h-4 text-muted-foreground" />}
    <span className={ok ? 'text-success' : 'text-muted-foreground'}>{label}</span>
  </span>
);

const cameraReady = (status: BackendCameraStatus | null) =>
  !!status?.ffmpeg && !!status?.hls_ready && !!(status?.stream_local || status?.stream);

function SlotCard({
  slot,
  allSlots,
  server,
  serverOk,
  mediamtx,
  onRename,
  onIp,
  onAi,
  onPatch,
  onConnected,
}: {
  slot: CameraSlot;
  /** Every configured slot — synced together so cameras never evict each other. */
  allSlots: CameraSlot[];
  server: string;
  serverOk: boolean;
  mediamtx: boolean;
  onRename: (v: string) => void;
  onIp: (v: string) => void;
  onAi: (v: boolean) => void;
  onPatch: (v: Partial<CameraSlot>) => void;
  onConnected: (v: { connected: boolean; streamUrl: string; webrtcUrl?: string }) => void;
}) {
  const [status, setStatus] = useState<BackendCameraStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'start' | 'stop' | 'test'>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const lastRef = useRef('');
  const id = `slot-${slot.index}`;

  const apply = useCallback((c: BackendCameraStatus | null) => {
    setStatus(c);
    const url = c?.stream_local || c?.stream || '';
    const webrtcUrl = c?.webrtc_local || c?.webrtc || '';
    const live = cameraReady(c);
    const key = `${live}|${live ? url : ''}|${live ? webrtcUrl : ''}`;
    if (lastRef.current !== key) {
      lastRef.current = key;
      onConnected({ connected: live, streamUrl: live ? url : '', webrtcUrl: live ? webrtcUrl : '' });
    }
    if (live) setError('');
  }, [onConnected]);

  const check = useCallback(async (silent = true) => {
    if (!silent) { setBusy('check'); setError(''); }
    try {
      const s = await getMultiStatus(server);
      const mine = s.cameras.find(c => c.id === id) ?? null;
      apply(mine);
      if (!silent) {
        setMessage(cameraReady(mine) ? '' : mine?.ffmpeg
          ? 'Waiting for camera connection confirmation.'
          : 'Camera is not connected. Press Connect to try again.');
        if (mine?.error) setError(mine.error);
      }
      return mine;
    } catch {
      apply(null);
      if (!silent) {
        setMessage('');
        setError(backendHint(server) || `Could not reach the local server at ${server}.`);
      }
      return null;
    } finally {
      if (!silent) setBusy('');
    }
  }, [server, id, apply]);

  // Dashboard metrics must not reset this timer before it can refresh status.
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (!slot.ip.trim()) return;
    void checkRef.current(true);
    const t = window.setInterval(() => { void checkRef.current(true); }, 2500);
    return () => window.clearInterval(t);
  }, [slot.ip, server, id]);

  const handleConnect = async () => {
    if (!slot.ip.trim()) { setError('Enter the camera IP address first.'); return; }
    setBusy('start'); setError(''); setMessage(`Connecting ${slot.name}…`);
    try {
      // Auto-discover the full RTSP endpoint, not just the port. Different
      // camera brands expose video under different paths (/stream1,
      // /live/ch00_1, /Streaming/Channels/101, ...).
      let active = slot;
      const preferredPort = Number(slot.port) > 0 ? Number(slot.port) : null;
      const ports = [
        ...(preferredPort ? [preferredPort] : []),
        ...AUTO_RTSP_PORTS.filter(p => p !== preferredPort),
      ];
      const preferredPath = (slot.streamPath || DEFAULT_STREAM_PATH).trim() || DEFAULT_STREAM_PATH;
      const paths = [
        preferredPath,
        ...AUTO_RTSP_PATHS.filter(p => p !== preferredPath),
      ];

      setMessage(`Checking ${slot.name}…`);
      let found = false;
      let lastProbeError = '';
      for (const port of ports) {
        for (const streamPath of paths) {
          try {
            const candidate = { ...slot, port, streamPath };
            const probe = await testCamera(server, slotRtsp(candidate));
            if (probe.success) {
              active = candidate;
              onPatch({ port, streamPath });
              found = true;
              break;
            }
            lastProbeError = probe.error || lastProbeError;
          } catch (err) {
            lastProbeError = err instanceof Error ? err.message : String(err);
          }
        }
        if (found) break;
      }

      if (!found) {
        const authHint = !slot.username.trim()
          ? ' If the camera requires login, expand the camera details and enter its username and password.'
          : '';
        setError(
          `Could not connect to the camera at ${slot.ip}.${authHint}` +
          (lastProbeError ? ` Last error: ${lastProbeError}` : ''),
        );
        setMessage('');
        return;
      }
      setMessage(`Connecting ${slot.name}…`);

      // Sync EVERY configured camera, otherwise the backend drops the others.
      const configured = allSlots.filter(s => s.ip.trim());
      const payload = (configured.length ? configured : [active]).map(s => {
        const cur = s.index === active.index ? active : s;
        return {
          id: `slot-${cur.index}`, path: slotPath(cur), name: cur.name, location: '',
          rtspUrl: slotRtsp(cur), enabled: true, aiEnabled: cur.aiEnabled,
          recording: false, createdAt: new Date().toISOString(),
        };
      });
      await syncCameras(server, payload);
      const res = await startCamera(server, id);
      if (!res.success) { setMessage(''); setError(res.error || 'Could not connect this camera.'); return; }
      const confirmed = await check(true);
      if (cameraReady(confirmed)) setMessage('');
      else if (!confirmed) { setMessage(''); setError('Could not confirm the camera connection. Try again.'); }
      else { setMessage('Waiting for camera connection confirmation.'); if (confirmed.error) setError(confirmed.error); }
    } catch {
      setMessage('');
      setError(backendHint(server) || `Could not reach the local server at ${server}.`);
    } finally { setBusy(''); }
  };

  const handleDisconnect = async () => {
    setBusy('stop');
    try {
      await stopCamera(server, id);
      apply(null);
      setMessage(`${slot.name} disconnected.`);
      setError('');
    } catch {
      setError('Could not stop this camera on the local server.');
    } finally { setBusy(''); }
  };

  const rtspUrl = slotRtsp(slot);

  const handleCopy = async () => {
    if (!rtspUrl) return;
    try {
      await navigator.clipboard.writeText(rtspUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  };

  const handleTest = async () => {
    if (!rtspUrl) { setTestResult({ ok: false, text: 'Enter the camera IP address first.' }); return; }
    setBusy('test'); setTestResult(null);
    try {
      const res = await testCamera(server, rtspUrl);
      setTestResult(res.success
        ? { ok: true, text: 'Camera answered the connection test.' }
        : { ok: false, text: res.error || 'The camera did not answer on this address.' });
    } catch {
      setTestResult({ ok: false, text: backendHint(server) || `Could not reach the local server at ${server}.` });
    } finally { setBusy(''); }
  };

  const live = cameraReady(status);

  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[16px] font-bold">CAM{slot.index}</span>
        <span className={`text-[14px] font-bold px-2.5 py-0.5 rounded-full ${live ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}>
          {live ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 items-end">
        <div className="space-y-1 min-w-0">
          <label className="text-[14px] font-semibold">Camera name</label>
          <input
            value={slot.name}
            onChange={e => onRename(e.target.value)}
            placeholder="Front Door"
            className="w-full text-[15px] px-3 py-2.5 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide camera login details' : 'Show camera login details'}
          title={expanded ? 'Hide login details' : 'Show login details'}
          className="justify-self-center h-9 w-9 flex items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <div className="space-y-1 min-w-0">
          <label className="text-[14px] font-semibold">Camera IP address</label>
          <div className="flex items-center gap-2">
            <input
              value={slot.ip}
              onChange={e => onIp(e.target.value)}
              placeholder="192.168.18.98"
              className="w-full min-w-0 text-[15px] px-3 py-2.5 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <IpAddressHelp />
          </div>
        </div>
      </div>

      {expanded && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 min-w-0">
              <label className="text-[14px] font-semibold">Username</label>
              <input
                value={slot.username ?? ''}
                onChange={e => onPatch({ username: e.target.value })}
                autoComplete="off"
                placeholder="admin"
                className="w-full text-[15px] px-3 py-2.5 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="space-y-1 min-w-0">
              <label className="text-[14px] font-semibold">Password</label>
              <div className="flex items-center gap-2">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={slot.password ?? ''}
                  onChange={e => onPatch({ password: e.target.value })}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  className="w-full min-w-0 text-[15px] px-3 py-2.5 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="shrink-0 h-10 w-10 flex items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 min-w-0">
              <label className="text-[14px] font-semibold">Stream path</label>
              <input
                value={slot.streamPath ?? DEFAULT_STREAM_PATH}
                onChange={e => onPatch({ streamPath: e.target.value })}
                placeholder={DEFAULT_STREAM_PATH}
                className="w-full text-[15px] px-3 py-2.5 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="space-y-1 min-w-0">
              <label className="text-[14px] font-semibold">Port (leave empty for Auto)</label>
              <input
                inputMode="numeric"
                value={Number(slot.port) > 0 ? String(slot.port) : ''}
                onChange={e => onPatch({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                placeholder="Auto" 
                className="w-full text-[15px] px-3 py-2.5 rounded-lg border border-input bg-background focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>

          <div className="space-y-1 min-w-0">
            <label className="text-[14px] font-semibold">RTSP URL (Auto-generated)</label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={showPassword ? rtspUrl : slotRtspMasked(slot)}
                placeholder="rtsp://username:password@192.168.18.98:554/stream1"
                className="w-full min-w-0 text-[15px] px-3 py-2.5 rounded-lg border border-input bg-muted/60 text-muted-foreground focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy RTSP URL"
                className="shrink-0 flex items-center gap-1.5 text-[14px] font-semibold px-3 py-2.5 rounded-lg border border-border bg-background hover:bg-muted"
              >
                {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={busy !== ''}
              className="flex items-center gap-2 text-[15px] font-semibold px-3 py-2.5 rounded-lg border border-border bg-background hover:bg-muted disabled:opacity-50"
            >
              {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
              Test connection
            </button>
            {testResult && (
              <span className={`text-[14px] font-semibold break-all ${testResult.ok ? 'text-success' : 'text-destructive'}`}>
                {testResult.text}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 rounded-lg bg-background/60 border border-border">
            <Dot ok={serverOk && mediamtx} label="MediaMTX" />
            <Dot ok={!!status?.ffmpeg} label="FFmpeg" />
            <Dot ok={!!status?.hls_ready} label="HLS" />
            <PrefetchModelsButton className="ml-auto" />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1">
          <IdleHint
            message={slot.ip.trim() ? 'Press Connect to start this camera' : 'Type the camera IP address, then press Connect'}
            disabled={live || busy !== ''}
          />
          <button
            onClick={handleConnect}
            disabled={busy !== ''}
            className="w-full flex items-center justify-center gap-2 text-[15px] font-bold px-3 py-2.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
          >
            {busy === 'start' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {busy === 'start' ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        <button
          onClick={handleDisconnect}
          disabled={busy !== '' || !live}
          className="flex items-center gap-2 text-[15px] font-semibold px-3 py-2.5 rounded-lg border border-border hover:bg-muted disabled:opacity-50"
        >
          <Square className="w-4 h-4" /> Disconnect
        </button>
        <button
          onClick={() => check(false)}
          disabled={busy !== ''}
          className="flex items-center gap-2 text-[15px] font-semibold px-3 py-2.5 rounded-lg border border-border hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${busy === 'check' ? 'animate-spin' : ''}`} /> Check
        </button>
        <button
          onClick={() => onAi(!slot.aiEnabled)}
          className={`flex items-center gap-2 text-[15px] font-semibold px-3 py-2.5 rounded-lg border transition-colors ${
            slot.aiEnabled ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'
          }`}
          title="AI detection only — this never stops the stream"
        >
          <Brain className="w-4 h-4" /> AI {slot.aiEnabled ? 'On' : 'Off'}
        </button>
      </div>

      {live ? <p role="status" className="text-[14px] font-semibold text-success">{slot.name} connected successfully.</p>
        : message && <p role="status" className="text-[14px] text-muted-foreground break-all">{message}</p>}
      {status?.error && <p className="text-[14px] text-destructive break-all">{status.error}</p>}
      {error && (
        <p className="text-[14px] text-destructive bg-destructive/10 border border-destructive/30 px-3 py-2 rounded-lg break-all">{error}</p>
      )}
    </div>
  );
}

export const MultiCameraConnect = ({ selectedSlot }: Props) => {
  const { count, slots, activeSlots, setCount, updateSlot } = useCameraSlots();
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const server = serverUrlFor(loadServerHost());

  useEffect(() => {
    if (!selectedSlot) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`connect-camera-${selectedSlot}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [selectedSlot]);

  useEffect(() => {
    const poll = async () => {
      try { setBackend(await getMultiStatus(server)); } catch { setBackend(null); }
    };
    void poll();
    const t = window.setInterval(poll, 4000);
    return () => window.clearInterval(t);
  }, [server]);

  return (
    <div className="space-y-4">
      <div>
        <label className="text-[16px] font-bold">Cameras</label>
        <p className="text-[15px] text-muted-foreground">
          Add up to 4 cameras. Enter a camera name and IP address, then press Connect.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-[15px] font-semibold">Number of cameras</label>
        <div className="flex flex-wrap items-center gap-2">
          {([1, 2, 3, 4] as SlotCount[]).map(n => (
            <button
              key={n}
              onClick={() => setCount(n)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-[15px] font-bold border transition-colors ${
                count === n ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'
              }`}
            >
              {n === 1 ? <SquareIcon className="w-4 h-4" /> : n === 2 ? <Columns2 className="w-4 h-4" /> : <Grid2x2 className="w-4 h-4" />}
              {n} camera{n === 1 ? '' : 's'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 rounded-lg bg-secondary/30 border border-border">
        <Dot ok={!!backend} label="Camera service" />
        <Dot ok={!!backend?.whisper} label="Audio detection" />
      </div>

      <div className={`grid gap-4 ${count === 1 ? 'grid-cols-1' : 'lg:grid-cols-2'}`}>
        {activeSlots.map(slot => (
          <div key={slot.index} id={`connect-camera-${slot.index}`} className={selectedSlot === slot.index ? 'rounded-xl ring-2 ring-primary/40' : undefined}>
          <SlotCard
            slot={slot}
            allSlots={slots}
            server={server}
            serverOk={!!backend}
            mediamtx={!!backend?.mediamtx}
            onRename={v => updateSlot(slot.index, { name: v })}
            onIp={v => updateSlot(slot.index, { ip: v })}
            onAi={v => updateSlot(slot.index, { aiEnabled: v })}
            onPatch={v => updateSlot(slot.index, v)}
            onConnected={v => updateSlot(slot.index, v)}
          />
          </div>
        ))}
      </div>

    </div>
  );
};

export default MultiCameraConnect;
