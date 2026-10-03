import { describe, expect, it } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';
import type { DetectedObject } from '@/types/dashboard';

type Color = [number, number, number];
const BACKGROUND: Color = [20, 45, 90];
const FLAME: Color = [255, 145, 20];
const BRIGHT_FLAME: Color = [225, 180, 60];
const GRAY: Color = [165, 165, 165];

function scene(color: (x: number, y: number) => Color, width = 100, height = 100): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data.set([...color(x, y), 255], offset);
    }
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

describe('fire and smoke emergency decisions', () => {
  it.each(['tv', 'cell phone', 'laptop', 'monitor', 'tablet', 'television'])('rejects flame footage that occupies a %s display', label => {
    const state = createFireState();
    const display: DetectedObject = { label, confidence: 0.95, bbox: [0, 0, 100, 100] };
    detectFire(scene(() => FLAME), state, [display]);
    const result = detectFire(scene(() => BRIGHT_FLAME), state, [display]);
    expect(result.detected).toBe(false);
    expect(result.fireDetected).toBe(false);
    expect(result.smokeEmergency).toBe(false);
    expect(result.classification).toBe('electronics-with-fire');
    expect(result.confidence).toBe(0);
    expect(result.firePixelRatio).toBe(0);
    expect(result.screenFireRatio).toBeGreaterThan(0);
    expect(result.visibility).toBe(100);
  });

  it('retains a real changing fire around a television', () => {
    const state = createFireState();
    const display: DetectedObject = { label: 'tv', confidence: 0.95, bbox: [20, 20, 60, 60] };
    detectFire(scene(() => FLAME), state, [display]);
    const result = detectFire(scene(() => BRIGHT_FLAME), state, [display]);
    expect(result.fireDetected).toBe(true);
    expect(result.detected).toBe(true);
    expect(result.screenFireRatio).toBeGreaterThan(0);
    expect(result.firePixelRatio).toBeGreaterThan(0);
    expect(result.classification).toBe('large-fire');
  });

  it('confirms a large fire with smoke after two samples even when flame coverage is static', () => {
    const state = createFireState();
    const frame = scene(x => x < 50 ? FLAME : GRAY);
    expect(detectFire(frame, state).fireDetected).toBe(false);
    const confirmed = detectFire(frame, state);
    expect(confirmed.largeFire).toBe(true);
    expect(confirmed.fireDetected).toBe(true);
    expect(confirmed.detected).toBe(true);
    expect(confirmed.classification).toBe('large-fire');
  });

  it('does not treat a static gray wall at startup as a smoke emergency', () => {
    const state = createFireState();
    const wall = scene(() => GRAY);
    for (let i = 0; i < 15; i++) {
      const result = detectFire(wall, state);
      expect(result.smokeRatio).toBeGreaterThan(0.18);
      expect(result.visibility).toBeLessThanOrEqual(45);
      expect(result.smokeEmergency).toBe(false);
      expect(result.detected).toBe(false);
    }
  });

  it('detects smoke as a clear scene becomes obscured, without requiring visible flames', () => {
    const state = createFireState();
    detectFire(scene((x, y) => (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? [20, 50, 180] : [40, 220, 60]), state);
    const smoke = detectFire(scene(() => GRAY), state);
    expect(smoke.fireDetected).toBe(false);
    expect(smoke.smokeEmergency).toBe(true);
    expect(smoke.detected).toBe(true);
    expect(smoke.classification).toBe('smoke');
  });

  it('does not classify a tiny flame candidate as a fire emergency', () => {
    const state = createFireState();
    const small = (color: Color) => scene((x, y) => x < 4 && y < 4 ? color : BACKGROUND);
    detectFire(small(FLAME), state);
    const result = detectFire(small(BRIGHT_FLAME), state);
    expect(result.fireDetected).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.rejectedReason).toContain('small');
  });

  it('recognizes spatial flame movement when its total area remains constant', () => {
    const state = createFireState();
    const patch = (left: number) => scene((x, y) => x >= left && x < left + 20 && y >= 20 && y < 40 ? FLAME : BACKGROUND);
    const before = detectFire(patch(0), state);
    const after = detectFire(patch(60), state);
    expect(after.firePixelRatio).toBe(before.firePixelRatio);
    expect(after.flickerScore).toBeGreaterThan(0);
    expect(after.fireDetected).toBe(true);
  });

  it('does not suppress a candidate using an uncertain display box', () => {
    const state = createFireState();
    const uncertain: DetectedObject = { label: 'tv', confidence: 0.1, bbox: [0, 0, 100, 100] };
    detectFire(scene(() => FLAME), state, [uncertain]);
    const result = detectFire(scene(() => BRIGHT_FLAME), state, [uncertain]);
    expect(result.fireDetected).toBe(true);
    expect(result.screenFireRatio).toBe(0);
  });
});
