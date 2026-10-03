import { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';

interface Props {
  cameraName: string;
  transcript?: string;
  listening?: boolean;
  message?: string;
  tone?: 'ok' | 'wait' | 'error';
  id?: string;
  appearance?: 'default' | 'dark';
}

/** Displays one finalized utterance without letting speech resize the camera card. */
export default function TranscriptionBox({ cameraName, transcript = '', listening = false, message, tone, id, appearance = 'default' }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const status = message || (listening ? 'Listening… no speech yet' : 'Listening is off');
  const dark = appearance === 'dark';

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [transcript]);

  return (
    <div id={id} className={`flex h-24 min-w-0 shrink-0 flex-col gap-1 overflow-hidden px-3 py-2 ${dark ? 'rounded-lg bg-black/20 text-slate-300' : 'border-t border-border bg-card text-foreground'}`}>
      <div className={`flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider ${dark ? 'text-slate-300' : 'text-primary'}`}>
        <Mic aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${listening ? (dark ? 'text-cyan-400' : 'text-primary') : (dark ? 'text-slate-500' : 'text-muted-foreground')}`} />
        Live transcription
      </div>
      <div ref={scrollRef} role="region" aria-label={`Transcription for ${cameraName}`} tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-sm leading-snug [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        {transcript || <span className={tone === 'error' ? 'text-destructive' : dark ? 'text-slate-400' : 'text-muted-foreground'}>{status}</span>}
        {transcript && tone === 'error' && <p className="mt-1 text-xs text-destructive">{status}</p>}
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{transcript || status}{transcript && tone === 'error' ? ` ${status}` : ''}</span>
    </div>
  );
}
