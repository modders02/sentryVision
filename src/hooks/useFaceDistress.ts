import { useEffect, useRef, useState, useCallback } from 'react';
import * as faceapi from '@vladmandic/face-api';

// Loads pretrained face detection + expression models from a CDN.
// Expression probabilities are a visual heuristic, not an emotion diagnosis.
// We map the 7 base expressions into a single "distress level".

const MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model';

export type FaceDistress = {
  hasFace: boolean;
  expression: string | null;     // dominant expression
  probability: number;           // 0..1
  distressScore: number;         // 0..100, how distressed the person is
  distressLevel: 'none' | 'mild' | 'severe';
};

const EMPTY: FaceDistress = {
  hasFace: false,
  expression: null,
  probability: 0,
  distressScore: 0,
  distressLevel: 'none',
};

let modelLoadPromise: Promise<void> | null = null;
function loadModels(): Promise<void> {
  if (modelLoadPromise) return modelLoadPromise;
  modelLoadPromise = (async () => {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
    ]);
  })().catch(error => { modelLoadPromise = null; throw error; });
  return modelLoadPromise;
}

export function useFaceDistress(active: boolean) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [distress, setDistress] = useState<FaceDistress>(EMPTY);
  const [latencyMs, setLatencyMs] = useState(0);
  const busyRef = useRef(false);
  const historyRef = useRef<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const revisionRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    revisionRef.current++;
    historyRef.current = [];
    setDistress(EMPTY);
    return () => { revisionRef.current++; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loadModels()
      .then(() => { if (!cancelled) { setReady(true); setError(null); } })
      .catch(err => {
        console.error('[FaceDistress] Failed to load models:', err);
        if (!cancelled) setError(err?.message || 'Failed to load face models');
      });
    return () => { cancelled = true; };
  }, [active]);

  const analyze = useCallback(async (source: HTMLCanvasElement | HTMLVideoElement | null) => {
    if (!activeRef.current || !ready || !source || busyRef.current) return;
    const revision = revisionRef.current;
    const started = performance.now();
    const cancelled = () => revision !== revisionRef.current || !activeRef.current;
    busyRef.current = true;
    try {
      // The pipeline keeps drawing new frames. Own a stable copy for this job.
      const canvas = canvasRef.current ?? (canvasRef.current = document.createElement('canvas'));
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!width || !height) return;
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(source, 0, 0);
      const detections = await faceapi.detectAllFaces(canvas,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }));
      if (cancelled()) return;

      if (!detections.length) {
        historyRef.current = [];
        setDistress(EMPTY);
        return;
      }

      // Pick the largest face
      const main = detections.reduce((biggest, d) => {
        return d.box.area > biggest.box.area ? d : biggest;
      });
      // The score uses one face, so run the expression network only on that face.
      const [crop] = await faceapi.extractFaces(canvas, [main]);
      if (!crop || cancelled()) return;
      const expressions = await faceapi.recognizeFaceExpressions(crop);
      if (cancelled()) return;
      const expr = expressions as unknown as Record<string, number>;
      // Distress = sad + fearful + angry + disgusted ; positive = happy + surprised + neutral
      const sad = expr.sad ?? 0;
      const fearful = expr.fearful ?? 0;
      const angry = expr.angry ?? 0;
      const disgusted = expr.disgusted ?? 0;
      const distressRaw = sad * 1.0 + fearful * 1.4 + angry * 0.8 + disgusted * 0.7;
      const instant = Math.min(100, Math.round(distressRaw * 100));
      // Three samples reduce smoothing lag while rejecting single-frame spikes.
      historyRef.current.push(instant);
      if (historyRef.current.length > 3) historyRef.current.shift();
      const distressScore = Math.round(
        historyRef.current.reduce((a, b) => a + b, 0) / historyRef.current.length
      );

      let dominant = 'neutral';
      let dominantProb = 0;
      for (const [k, v] of Object.entries(expr)) {
        if (v > dominantProb) { dominantProb = v; dominant = k; }
      }

      setDistress({
        hasFace: true,
        expression: dominant,
        probability: dominantProb,
        distressScore,
        distressLevel: distressScore > 55 ? 'severe' : distressScore > 25 ? 'mild' : 'none',
      });
    } catch (err) {
      console.error('[FaceDistress] analyze error:', err);
    } finally {
      busyRef.current = false;
      if (!cancelled()) setLatencyMs(Math.round(performance.now() - started));
    }
  }, [ready]);

  return { ready, error, distress, analyze, latencyMs };
}
