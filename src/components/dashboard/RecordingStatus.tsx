import { useEffect, useState } from 'react';
import { CLIP_STATUS_EVENT, getClipRecordingStatus, type ClipRecordingStatus } from '@/lib/clipRecorder';

export default function RecordingStatus() {
  const [status, setStatus] = useState(getClipRecordingStatus);
  useEffect(() => {
    const update = (event: Event) => setStatus((event as CustomEvent<ClipRecordingStatus>).detail);
    window.addEventListener(CLIP_STATUS_EVENT, update);
    return () => window.removeEventListener(CLIP_STATUS_EVENT, update);
  }, []);
  if (!status) return null;
  return <p role="status" className={`fixed bottom-4 left-4 z-[60] max-w-[calc(100vw-2rem)] rounded-lg border bg-card px-4 py-3 text-sm shadow-lg ${status.state === 'error' ? 'border-destructive/50 text-destructive' : 'border-border text-foreground'}`}>{status.message}</p>;
}
