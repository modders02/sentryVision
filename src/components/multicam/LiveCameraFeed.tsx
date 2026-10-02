import { useEffect, useRef, useState } from 'react';
import { Camera, Maximize2, Mic, MicOff, RefreshCw, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { useCctvTalk } from '@/hooks/useCctvTalk';
import { useCameraSession } from '@/lib/cameraSessions';
import type { CameraConfig, MultiCamSettings } from '@/types/multicam';

interface Props {
  camera: CameraConfig;
  settings: MultiCamSettings;
  onExpand?: (id: string) => void;
  onConnect: () => void;
}

/** Mounts the monitoring session's video, keeping a single stream and AI pipeline per camera. */
export default function LiveCameraFeed({ camera, settings, onExpand, onConnect }: Props) {
  const { video, runtime, home, reconnect } = useCameraSession(camera.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [speaker, setSpeaker] = useState(false);
  const talk = useCctvTalk(settings.pythonServer, camera.id);
  const stopTalk = talk.stopTalk;
  const status = runtime?.status || 'connecting';

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !video) return;
    const originalParent = home || video.parentElement;
    const originalStyle = video.style.cssText;
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;';
    video.playsInline = true;
    container.appendChild(video);
    void video.play().catch(() => { /* Existing session will retry playback when the stream becomes ready. */ });
    return () => {
      if (video.parentElement === container) {
        video.muted = true;
        video.style.cssText = originalStyle;
        if (originalParent?.isConnected) originalParent.appendChild(video);
        else video.remove();
      }
    };
  }, [video, home]);

  useEffect(() => {
    if (video) video.muted = !speaker;
    return () => { if (video) video.muted = true; };
  }, [speaker, video]);

  useEffect(() => stopTalk, [stopTalk]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !video || !video.videoWidth) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!runtime || !camera.aiEnabled) return;
    const sx = canvas.width / (runtime.frameWidth || 320);
    const sy = canvas.height / (runtime.frameHeight || Math.max(1, Math.round((video.videoHeight / video.videoWidth) * 320)));
    ctx.lineWidth = 3;
    ctx.font = '600 16px Inter, sans-serif';
    for (const object of runtime.objects) {
      const [x, y, width, height] = object.bbox;
      ctx.strokeStyle = object.label === 'person' ? 'hsl(150 90% 50%)' : 'hsl(190 90% 55%)';
      ctx.strokeRect(x * sx, y * sy, width * sx, height * sy);
      const label = `${object.label} ${(object.confidence * 100).toFixed(0)}%`;
      const textWidth = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x * sx, Math.max(0, y * sy - 22), textWidth, 22);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x * sx + 5, Math.max(17, y * sy - 6));
    }
    if (runtime.fire.detected && runtime.fire.bbox) {
      const [x, y, width, height] = runtime.fire.bbox;
      ctx.strokeStyle = 'hsl(0 90% 55%)';
      ctx.lineWidth = 4;
      ctx.strokeRect(x * sx, y * sy, width * sx, height * sy);
    }
  }, [runtime, video, camera.aiEnabled]);

  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{camera.name}</h2>
          <p className="truncate text-xs text-muted-foreground">{camera.location || camera.id}</p>
        </div>
        <div className="flex items-center gap-1">
          <span className={`mr-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${status === 'online' ? 'bg-success/15 text-success' : status === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status === 'online' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}</span>
          <button onClick={() => setSpeaker(value => !value)} title={speaker ? 'Mute camera sound' : 'Hear camera sound'} aria-label={speaker ? 'Mute camera sound' : 'Hear camera sound'} aria-pressed={speaker} className={`rounded-lg p-2 hover:bg-muted ${speaker ? 'text-primary' : 'text-muted-foreground'}`}>{speaker ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</button>
          <button
            onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); void talk.startTalk(); }}
            onPointerUp={talk.stopTalk}
            onPointerCancel={talk.stopTalk}
            onLostPointerCapture={talk.stopTalk}
            onKeyDown={event => { if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); void talk.startTalk(); } }}
            onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); talk.stopTalk(); } }}
            onBlur={talk.stopTalk}
            title="Hold to talk through this camera"
            aria-label="Hold to talk through this camera"
            aria-pressed={talk.talking}
            className={`touch-none rounded-lg p-2 hover:bg-muted ${talk.talking ? 'text-destructive' : 'text-muted-foreground'}`}
          >{talk.talking ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}</button>
          {reconnect && <button onClick={reconnect} title="Reconnect camera" aria-label="Reconnect camera" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><RefreshCw className="h-4 w-4" /></button>}
          {onExpand && <button onClick={() => onExpand(camera.id)} title="Open camera" aria-label={`Open ${camera.name}`} className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><Maximize2 className="h-4 w-4" /></button>}
        </div>
      </div>
      <div className="relative aspect-video bg-black">
        <div ref={containerRef} className="absolute inset-0" />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
        {status !== 'online' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 px-6 text-center">
            <VideoOff className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-semibold">{status === 'connecting' ? 'Connecting to live feed…' : runtime?.error || 'Device offline'}</p>
            {status !== 'connecting' && <button onClick={onConnect} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-muted">Connection settings</button>}
          </div>
        )}
        {talk.error && <div role="alert" className="absolute right-3 top-3 max-w-[80%] rounded-lg bg-destructive px-3 py-2 text-xs text-destructive-foreground">{talk.error}</div>}
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Camera className="h-3.5 w-3.5" />{camera.aiEnabled ? 'AI monitoring on' : 'AI monitoring off'}</span>
        {runtime?.status === 'online' && <span className="font-mono">{runtime.transport === 'webrtc' || runtime.transport === 'local' ? 'Realtime · ' : ''}{runtime.fps} FPS</span>}
      </div>
      {runtime?.playbackWarning && <p role="status" className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{runtime.playbackWarning}</p>}
    </article>
  );
}
