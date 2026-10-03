import type { DetectionEvent } from '@/types/multicam';

export const ALERT_BATCH_SIZE = 50;
export const MAX_INFORMATIONAL_EVENTS = 50;
export const isAlertEvent = (event: Pick<DetectionEvent, 'type'>) => event.type !== 'object' && event.type !== 'human';

/** Keep the 50th alert visible; clear that completed batch on the next alert. */
export function appendAlertBatch<T>(previous: T[], next: T): T[] {
  return [next, ...(previous.length >= ALERT_BATCH_SIZE ? [] : previous)];
}

export function appendDetectionEvent(previous: DetectionEvent[], next: DetectionEvent): DetectionEvent[] {
  const reset = isAlertEvent(next) && previous.filter(isAlertEvent).length >= ALERT_BATCH_SIZE;
  let information = 0;
  return [next, ...previous.filter(event => !reset || !isAlertEvent(event))].filter(event =>
    isAlertEvent(event) || ++information <= MAX_INFORMATIONAL_EVENTS,
  );
}

export function releaseRemovedClips(previous: DetectionEvent[], next: DetectionEvent[]) {
  const retained = new Set(next.map(event => event.clipUrl).filter(Boolean));
  for (const event of previous) {
    if (event.clipUrl?.startsWith('blob:') && !retained.has(event.clipUrl)) URL.revokeObjectURL(event.clipUrl);
  }
}
