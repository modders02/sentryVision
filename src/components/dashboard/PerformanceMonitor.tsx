import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { perfMonitor, AI_RATES, type PerfSnapshot } from '@/lib/performance';
import type { CameraRuntime } from '@/types/multicam';

/**
 * Compact pipeline performance panel — samples the shared perf monitor at
 * ~2 Hz (the monitor's own roll rate), so it adds no measurable overhead.
 */
export default function PerformanceMonitor({ runtime }: { runtime?: CameraRuntime }) {
  const [snap, setSnap] = useState<PerfSnapshot>(() => perfMonitor.get());

  useEffect(() => perfMonitor.subscribe(setSnap), []);

  const statusColor =
    snap.status === 'THROTTLED'
      ? 'bg-warning/20 text-warning'
      : snap.status === 'NORMAL'
      ? 'bg-success/20 text-success'
      : 'bg-muted text-muted-foreground';

  const measured = (value?: number | null) => value == null ? 'Waiting' : `${value} ms`;
  const rows: Array<[string, string]> = runtime ? [
    ['Video FPS', String(runtime.fps)],
    ['Visual analysis', measured(runtime.latencyMs)],
    ['Object inference', measured(runtime.objectLatencyMs)],
    ['Face inference', measured(runtime.faceLatencyMs)],
    ['Transcription queue + decode', measured(runtime.audio?.transcription_latency_ms)],
  ] : [
    ['Video FPS', snap.videoFps.toFixed(1)],
    ['AI FPS', snap.aiFps.toFixed(1)],
    ['Latency', `${snap.latencyMs} ms`],
    ['Stale frames', String(snap.dropped)],
  ];

  return (
    <div className="bg-card rounded-md border border-border panel-glow p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono text-primary uppercase tracking-wider flex items-center gap-1">
          <Activity className="w-3.5 h-3.5" /> Pipeline Performance
        </span>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${statusColor}`}>
          {runtime ? runtime.status.toUpperCase() : snap.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="bg-secondary/40 rounded px-2 py-1">
            <p className="text-[9px] font-mono text-muted-foreground">{label}</p>
            <p className="text-sm font-mono text-foreground">{value}</p>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[9px] font-mono text-muted-foreground leading-relaxed">
        {runtime ? 'Live checks up to 10 Hz; object and face jobs up to 5 Hz. Background stills 2 Hz; finalized transcription polled every 200 ms. Measured processing times exclude camera and network delay.' : `Targets — obj ${AI_RATES.object}fps · sal ${AI_RATES.saliency}fps · fire ${AI_RATES.fire}fps · face ${AI_RATES.face}fps · UI ${AI_RATES.ui}Hz`}
      </p>
      {!runtime && snap.status === 'THROTTLED' && (
        <p className="text-[9px] font-mono text-warning">
          Adaptive throttle active — analysing at obj {snap.stageFps.object}fps / sal {snap.stageFps.saliency}fps.
        </p>
      )}
    </div>
  );
}
