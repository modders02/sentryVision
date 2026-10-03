import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFaceDistress } from '@/hooks/useFaceDistress';

const face = vi.hoisted(() => ({
  loadDetector: vi.fn(), loadExpressions: vi.fn(), detect: vi.fn(), extract: vi.fn(), recognize: vi.fn(),
}));
vi.mock('@vladmandic/face-api', () => ({
  nets: {
    tinyFaceDetector: { loadFromUri: face.loadDetector },
    faceExpressionNet: { loadFromUri: face.loadExpressions },
  },
  TinyFaceDetectorOptions: class { constructor(public options: unknown) {} },
  detectAllFaces: face.detect, extractFaces: face.extract, recognizeFaceExpressions: face.recognize,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const detection = (area: number) => ({ box: { area } });
const drawImage = vi.fn();
const makeSource = () => {
  const source = document.createElement('canvas');
  source.width = 640;
  source.height = 480;
  return source;
};

beforeEach(() => {
  vi.clearAllMocks();
  face.loadDetector.mockResolvedValue(undefined);
  face.loadExpressions.mockResolvedValue(undefined);
  face.detect.mockResolvedValue([detection(100)]);
  face.extract.mockResolvedValue([document.createElement('canvas')]);
  face.recognize.mockResolvedValue({ neutral: 1 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const readyHook = async () => {
  const hook = renderHook(({ active }) => useFaceDistress(active), { initialProps: { active: true } });
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current.ready).toBe(true);
  return hook;
};

describe('face distress latency and session safety', () => {
  it('loads both models in parallel, retries a failed load, and shares the retry', async () => {
    const firstDetector = deferred<void>();
    const firstExpressions = deferred<void>();
    face.loadDetector.mockReturnValueOnce(firstDetector.promise);
    face.loadExpressions.mockReturnValueOnce(firstExpressions.promise);
    const first = renderHook(({ active }) => useFaceDistress(active), { initialProps: { active: true } });
    expect(face.loadDetector).toHaveBeenCalledTimes(1);
    expect(face.loadExpressions).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstDetector.reject(new Error('model download unavailable'));
      firstExpressions.resolve();
      await Promise.resolve();
    });
    expect(first.result.current.ready).toBe(false);
    expect(first.result.current.error).toBe('model download unavailable');
    const retryDetector = deferred<void>();
    const retryExpressions = deferred<void>();
    face.loadDetector.mockReturnValueOnce(retryDetector.promise);
    face.loadExpressions.mockReturnValueOnce(retryExpressions.promise);
    first.rerender({ active: false });
    first.rerender({ active: true });
    const second = renderHook(() => useFaceDistress(true));
    expect(face.loadDetector).toHaveBeenCalledTimes(2);
    expect(face.loadExpressions).toHaveBeenCalledTimes(2);
    await act(async () => { retryDetector.resolve(); retryExpressions.resolve(); await Promise.resolve(); });
    expect(first.result.current.ready).toBe(true);
    expect(second.result.current.ready).toBe(true);
    expect(first.result.current.error).toBeNull();
  });

  it('recognizes expressions only on the largest detected face', async () => {
    const smaller = detection(50);
    const larger = detection(400);
    const crop = document.createElement('canvas');
    face.detect.mockResolvedValue([smaller, larger, detection(80)]);
    face.extract.mockResolvedValue([crop]);
    face.recognize.mockResolvedValue({ fearful: 0.7, neutral: 0.3 });
    const { result } = await readyHook();
    const source = makeSource();
    await act(async () => { await result.current.analyze(source); });
    const ownedCanvas = face.detect.mock.calls[0][0];
    expect(face.extract).toHaveBeenCalledWith(ownedCanvas, [larger]);
    expect(face.recognize).toHaveBeenCalledTimes(1);
    expect(face.recognize).toHaveBeenCalledWith(crop);
    expect(result.current.distress).toMatchObject({ hasFace: true, expression: 'fearful', distressScore: 98, distressLevel: 'severe' });
  });

  it('copies the frame before awaiting inference and excludes overlapping analyses', async () => {
    const detectionWork = deferred<ReturnType<typeof detection>[]>();
    face.detect.mockReturnValueOnce(detectionWork.promise);
    const { result } = await readyHook();
    const source = makeSource();
    let job!: Promise<void>;
    act(() => { job = result.current.analyze(source); });
    const ownedCanvas = face.detect.mock.calls[0][0] as HTMLCanvasElement;
    expect(ownedCanvas).not.toBe(source);
    expect(ownedCanvas.width).toBe(640);
    expect(ownedCanvas.height).toBe(480);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
    source.width = 320;
    source.height = 240;
    await act(async () => { await result.current.analyze(source); });
    expect(face.detect).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(ownedCanvas.width).toBe(640);
    await act(async () => { detectionWork.resolve([detection(100)]); await job; });
  });

  it('smooths exactly the latest three samples and resets after the face disappears', async () => {
    const { result } = await readyHook();
    const source = makeSource();
    face.recognize.mockResolvedValueOnce({ sad: 1 });
    await act(async () => { await result.current.analyze(source); });
    expect(result.current.distress.distressScore).toBe(100);
    face.recognize.mockResolvedValueOnce({ neutral: 1 });
    await act(async () => { await result.current.analyze(source); });
    expect(result.current.distress.distressScore).toBe(50);
    face.recognize.mockResolvedValueOnce({ neutral: 1 });
    await act(async () => { await result.current.analyze(source); });
    expect(result.current.distress.distressScore).toBe(33);
    face.recognize.mockResolvedValueOnce({ neutral: 1 });
    await act(async () => { await result.current.analyze(source); });
    expect(result.current.distress.distressScore).toBe(0);
    face.detect.mockResolvedValueOnce([]);
    await act(async () => { await result.current.analyze(source); });
    expect(result.current.distress.hasFace).toBe(false);
    face.recognize.mockResolvedValueOnce({ sad: 1 });
    await act(async () => { await result.current.analyze(source); });
    expect(result.current.distress.distressScore).toBe(100);
  });

  it('discards pending expression results across disable/re-enable and starts fresh', async () => {
    const expressions = deferred<Record<string, number>>();
    face.recognize.mockReturnValueOnce(expressions.promise);
    const { result, rerender } = await readyHook();
    const source = makeSource();
    let stale!: Promise<void>;
    await act(async () => { stale = result.current.analyze(source); await Promise.resolve(); });
    expect(face.recognize).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => { expressions.resolve({ sad: 1 }); await stale; });
    expect(result.current.distress.hasFace).toBe(false);
    expect(result.current.distress.distressScore).toBe(0);
    face.recognize.mockResolvedValueOnce({ fearful: 0.5, neutral: 0.5 });
    await act(async () => { await result.current.analyze(source); });
    expect(result.current.distress.distressScore).toBe(70);
  });

  it('does not launch expression inference after disabled detection completes', async () => {
    const detections = deferred<ReturnType<typeof detection>[]>();
    face.detect.mockReturnValueOnce(detections.promise);
    const { result, rerender } = await readyHook();
    let stale!: Promise<void>;
    act(() => { stale = result.current.analyze(makeSource()); });
    rerender({ active: false });
    await act(async () => { detections.resolve([detection(100)]); await stale; });
    expect(face.extract).not.toHaveBeenCalled();
    expect(face.recognize).not.toHaveBeenCalled();
    expect(result.current.distress.hasFace).toBe(false);
  });
});
