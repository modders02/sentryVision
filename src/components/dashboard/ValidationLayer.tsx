import { CheckCircle2, CircleDashed, ShieldCheck, TriangleAlert } from 'lucide-react';
import { validateSafetySpeech } from '@/lib/safetyValidation';
import type { CameraRuntime } from '@/types/multicam';

interface ValidationLayerProps {
  runtime?: CameraRuntime;
  cameraLabel?: string;
  transcriptOverride?: string;
}

export default function ValidationLayer({ runtime, cameraLabel = 'Camera', transcriptOverride }: ValidationLayerProps) {
  const transcript = transcriptOverride?.trim()
    || runtime?.transcript?.trim()
    || runtime?.audioDistress.transcript?.trim()
    || runtime?.audioDistress.keyword?.trim()
    || '';

  const validation = validateSafetySpeech(transcript, {
    fireDetected: runtime?.fire.detected,
    smokeDetected: runtime?.smoke.detected,
  });

  const statusLabel = validation.status === 'validated'
    ? 'Validated'
    : validation.status === 'pending'
      ? 'Verify'
      : 'Clear';

  const StatusIcon = validation.status === 'validated'
    ? CheckCircle2
    : validation.status === 'pending'
      ? TriangleAlert
      : CircleDashed;

  return (
    <section id="tour-validation-layer" className="rounded-xl border border-border bg-card p-3" aria-label="Safety validation layer">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Validation layer
        </h3>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${
          validation.status === 'validated'
            ? 'bg-success/10 text-success'
            : validation.status === 'pending'
              ? 'bg-warning/10 text-warning'
              : 'bg-muted text-muted-foreground'
        }`}>
          <StatusIcon className="h-3 w-3" />
          {statusLabel}
        </span>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Second-stage speech check for {cameraLabel}. Short fire words must be corroborated before they escalate.
      </p>

      <div className="mt-3 space-y-2 text-xs">
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground">Speech candidate</span>
          <span className="max-w-[60%] text-right font-mono text-foreground">
            {validation.match.matched ? `“${validation.match.phrase}”` : 'None'}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground">Whole-word match</span>
          <span className={validation.match.matched ? 'text-success' : 'text-muted-foreground'}>
            {validation.match.matched ? 'Pass' : 'Waiting'}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground">Visual corroboration</span>
          <span className={runtime?.fire.detected || runtime?.smoke.detected ? 'text-success' : 'text-muted-foreground'}>
            {runtime?.fire.detected ? 'Fire detected' : runtime?.smoke.detected ? 'Smoke detected' : 'None'}
          </span>
        </div>
      </div>

      <div className={`mt-3 rounded-lg border px-2.5 py-2 text-xs ${
        validation.status === 'pending'
          ? 'border-warning/30 bg-warning/5 text-warning'
          : validation.status === 'validated'
            ? 'border-success/30 bg-success/5 text-success'
            : 'border-border bg-muted/30 text-muted-foreground'
      }`}>
        {validation.reason}
      </div>
    </section>
  );
}
