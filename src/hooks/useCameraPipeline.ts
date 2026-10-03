import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { openCameraWebRtc } from '@/lib/cameraWebRtc';
import { detectObjects, loadDetector } from '@/lib/detectionEngine';
import { computeSaliency, computeSaliencyScore } from '@/lib/saliency';
import { createFireState, detectFire } from '@/lib/fireDetection';
import { describeAudioStatus, getAudioEvents, getCameraSnapshot } from '@/lib/multiCamServer';
import { latestFinalTranscript, transcriptRemainingMs, TRANSCRIPT_CLEAR_MS } from '@/lib/transcription';
import { useFaceDistress } from '@/hooks/useFaceDistress';
import { matchWakeWord } from '@/lib/safetyLexicon';
import type {
  CameraConfig, CameraRuntime, DetectionEvent, MultiCamSettings,
} from '@/types/multicam';
import { hlsUrlFor, webrtcUrlFor } from '@/types/multicam';

const HUMAN_LABELS = new Set(['person']);
const DISPLAY_LABELS = new Set(['tv', 'cell phone', 'laptop', 'monitor', 'tablet', 'television']);
const SNAPSHOT_INTERVAL_MS = 3000;
const MONITORING_SNAPSHOT_INTERVAL_MS = 500;
const AUDIO_POLL_INTERVAL_MS = 200;
const VISUAL_INTERVAL_MS = 100;
const OBJECT_INTERVAL_MS = 200;
const FACE_INTERVAL_MS = 200;
const OBJECT_MAX_AGE_MS = 1500;

type FrameCapture = { grabFrame: () => Promise<ImageBitmap> };
type ImageCaptureConstructor = new (track: MediaStreamTrack) => FrameCapture;

/** Decode a still image without opening a video element or a streaming player. */
async function decodeSnapshot(blob: Blob, signal?: AbortSignal): Promise<{
  image: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    const image = await createImageBitmap(blob);
    return { image, width: image.width, height: image.height, close: () => image.close() };
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(new DOMException('Snapshot cancelled.', 'AbortError'));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unable to read camera snapshot.'));
      image.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => {} };
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(url);
  }
}

const emptyRuntime = (cameraId: string): CameraRuntime => ({
  cameraId,
  status: 'offline',
  error: null,
  fps: 0,
  latencyMs: 0,
  saliencyScore: 0,
  attentionScore: 0,
  objects: [],
  humanCount: 0,
  fire: { detected: false, confidence: 0 },
  smoke: { detected: false, confidence: 0 },
  faceDistress: { detected: false, label: '', confidence: 0 },
  audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' },
  transcript: '',
  interimTranscript: '',
  audioListening: false,
  audio: null,
  audioMessage: 'Connect this camera to start listening.',
  audioTone: 'wait',
  audioBackendReachable: true,
  lastDetectionAt: null,
  detections: 0,
  alerts: 0,
});


interface Options {
  camera: CameraConfig;
  settings: MultiCamSettings;
  onEvent?: (evt: Omit<DetectionEvent, 'id'>) => void;
  /** Own the source video independently of any visible camera card. */
  managedVideo?: boolean;
  /** Streaming playback belongs to the Cameras page; other views use stills. */
  playbackEnabled?: boolean;
  /** Local webcam tracks use still capture outside the live page. */
  sourceStream?: MediaStream | null;
}

/**
 * One fully independent Multimodal Saliency Detection pipeline per camera:
 * its own HLS player, frame queue, fire/saliency state, face session,
 * Whisper audio polling, statistics and fault-tolerant reconnect.
 */
export function useCameraPipeline({ camera, settings, onEvent, managedVideo = false, playbackEnabled = true, sourceStream = null }: Options) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const homeRef = useRef<HTMLElement | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const webRtcRef = useRef<ReturnType<typeof openCameraWebRtc> | null>(null);
  const fireStateRef = useRef(createFireState());
  const prevFrameRef = useRef<ImageData | null>(null);
  const busyRef = useRef(false);
  const objectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastObjectStartedRef = useRef(0);
  const lastObjectAtRef = useRef(0);
  const lastFaceStartedRef = useRef(0);
  const latestFrameRef = useRef(0);
  const analysisRevisionRef = useRef(0);
  const faceAnalysisRevisionRef = useRef<number | null>(null);
  const analysisActiveRef = useRef(camera.enabled && camera.aiEnabled);
  analysisActiveRef.current = camera.enabled && camera.aiEnabled;
  const framesRef = useRef(0);
  const lastFpsRef = useRef(Date.now());
  const lastAudioRef = useRef<string | undefined>(undefined);
  const lastTranscriptRevisionRef = useRef('');
  const audioSourceRef = useRef('');
  const clearTimerRef = useRef<number | undefined>(undefined);
  const audioDistressTimerRef = useRef<number | undefined>(undefined);

  const cooldownRef = useRef<Record<string, number>>({});
  const retryRef = useRef(0);
  const runtimeRef = useRef<CameraRuntime>(emptyRuntime(camera.id));

  const [runtime, setRuntime] = useState<CameraRuntime>(() => emptyRuntime(camera.id));
  const [nonce, setNonce] = useState(0);
  const [preview, setPreview] = useState<{ image: string; timestamp: number } | null>(null);
  const face = useFaceDistress(camera.enabled && camera.aiEnabled);
  const analyzeFace = face.analyze;

  // Visible camera cards share this player only while the live page is open.
  // Dashboard snapshots and background audio never create a video element.
  useEffect(() => {
    if (!managedVideo || !playbackEnabled || !camera.enabled) return;
    const home = document.createElement('div');
    home.setAttribute('aria-hidden', 'true');
    home.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.crossOrigin = 'anonymous';
    home.appendChild(video);
    document.body.appendChild(home);
    videoRef.current = video;
    homeRef.current = home;
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.srcObject = null;
      video.load();
      video.remove();
      home.remove();
      if (videoRef.current === video) videoRef.current = null;
      if (homeRef.current === home) homeRef.current = null;
    };
  }, [managedVideo, playbackEnabled, camera.enabled]);

  const patch = useCallback((p: Partial<CameraRuntime>) => {
    runtimeRef.current = { ...runtimeRef.current, ...p };
    setRuntime(runtimeRef.current);
  }, []);

  // Work already awaiting a detector must not publish after its camera, AI
  // switch, source, or thresholds change. Audio retains its separate lifecycle.
  useEffect(() => {
    analysisRevisionRef.current += 1;
    faceAnalysisRevisionRef.current = null;
    lastObjectAtRef.current = 0;
    lastObjectStartedRef.current = 0;
    lastFaceStartedRef.current = 0;
    if (!camera.enabled || !camera.aiEnabled) {
      prevFrameRef.current = null;
      fireStateRef.current = createFireState();
      patch({
        objects: [], humanCount: 0, saliencyScore: 0, attentionScore: 0,
        fire: { detected: false, confidence: 0 },
        smoke: { detected: false, confidence: 0 },
        faceDistress: { detected: false, label: '', confidence: 0 },
      });
    }
    return () => { analysisRevisionRef.current += 1; };
  }, [camera.enabled, camera.aiEnabled, camera.id, sourceStream, playbackEnabled, settings.objectThreshold, settings.fireThreshold, settings.saliencyThreshold, settings.priorityObjects, patch]);

  /** A final utterance replaces prior words; polls never extend its lifetime. */
  const showTranscript = useCallback((text: string, remainingMs: number) => {
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = undefined;
    patch({ transcript: remainingMs > 0 ? text : '', interimTranscript: '' });
    if (text && remainingMs > 0) {
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = undefined;
        patch({ transcript: '' });
      }, remainingMs);
    }
  }, [patch]);

  useEffect(() => () => { if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current); }, []);

  const snapshot = useCallback(() => {
    const c = workRef.current;
    try { return c ? c.toDataURL('image/jpeg', 0.5) : undefined; } catch { return undefined; }
  }, []);

  const emit = useCallback(
    (type: DetectionEvent['type'], label: string, confidence: number, withSnapshot = true) => {
      const now = Date.now();
      const key = `${type}:${label}`;
      const cooldown = ['fire', 'smoke', 'face-distress', 'audio-distress'].includes(type) ? 3000 : 15000;
      if (cooldownRef.current[key] && now - cooldownRef.current[key] < cooldown) return;
      cooldownRef.current[key] = now;
      runtimeRef.current.alerts += 1;
      onEventRef.current?.({
        cameraId: camera.id,
        cameraName: camera.name,
        location: camera.location,
        type,
        label,
        confidence,
        timestamp: new Date().toISOString(),
        snapshot: withSnapshot ? snapshot() : undefined,
      });
    },
    [camera.id, camera.name, camera.location, snapshot],
  );

  // Prefer WebRTC for realtime playback; HLS is a compatibility fallback.
  const url = hlsUrlFor(camera, settings);
  const whepUrl = webrtcUrlFor(camera, settings);

  useEffect(() => {
    if (!camera.enabled) {
      patch({ status: 'offline', error: null });
      return;
    }
    if (!playbackEnabled) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let firstFrameTimer: number | undefined;
    let usingHls = false;
    patch({ status: 'connecting', error: null, playbackWarning: null });
    const ready = () => {
      if (cancelled) return;
      window.clearTimeout(firstFrameTimer);
      retryRef.current = 0;
      patch({ status: 'online', error: null });
    };
    video.addEventListener('loadeddata', ready);

    const startHls = () => {
      if (cancelled) return;
      usingHls = true;
      window.clearTimeout(firstFrameTimer);
      webRtcRef.current?.close();
      webRtcRef.current = null;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.srcObject = null;
      patch({ status: 'connecting', error: null, transport: 'hls', playbackWarning: 'Using a compatibility stream. Delay may exceed one second; reconnect to retry realtime playback.' });
      if (Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          liveSyncDuration: 0.4,
          liveMaxLatencyDuration: 1.2,
          maxLiveSyncPlaybackRate: 1.5,
          manifestLoadingTimeOut: 8000,
          manifestLoadingMaxRetry: 3,
          levelLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 3,
          fragLoadingRetryDelay: 500,
          maxBufferLength: 2,
          backBufferLength: 0,
        });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          retryRef.current = 0;
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || cancelled) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            patch({ status: 'connecting', error: 'Recovering video playback…' });
            hls.recoverMediaError();
            return;
          }
          patch({ status: 'connecting', error: 'Waiting for camera stream…' });
          hls.destroy();
          hlsRef.current = null;
          retryRef.current += 1;
          retryTimer = window.setTimeout(startHls, Math.min(5000, 1000 * retryRef.current));
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => {
          if (!cancelled) patch({ status: 'error', error: 'Playback blocked' });
        });
      } else {
        patch({ status: 'error', error: 'HLS unsupported in this browser' });
      }
    };

    if (sourceStream) {
      patch({ transport: 'local' });
      video.srcObject = sourceStream;
      video.play().then(() => { if (!cancelled && video.readyState >= 2) ready(); }).catch(() => {
        if (!cancelled) patch({ status: 'error', error: 'Playback blocked' });
      });
    } else if (typeof RTCPeerConnection === 'function') {
      patch({ transport: 'webrtc' });
      firstFrameTimer = window.setTimeout(startHls, 8000);
      try {
        webRtcRef.current = openCameraWebRtc(whepUrl, {
          onStream: stream => {
            if (cancelled || usingHls) return;
            if (video.srcObject !== stream) video.srcObject = stream;
            void video.play().catch(() => {
              if (!cancelled) patch({ status: 'error', error: 'Playback blocked' });
            });
          },
          onError: () => { if (!usingHls) startHls(); },
        });
      } catch { startHls(); }
    } else startHls();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(firstFrameTimer);
      video.removeEventListener('loadeddata', ready);
      webRtcRef.current?.close();
      webRtcRef.current = null;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const v = videoRef.current;
      if (v) { v.pause(); v.removeAttribute('src'); v.srcObject = null; v.load(); }
    };
  }, [url, whepUrl, camera.enabled, managedVideo, playbackEnabled, sourceStream, nonce, patch]);

  // ---- FPS counter ---------------------------------------------------------
  useEffect(() => {
    framesRef.current = 0;
    lastFpsRef.current = Date.now();
    if (!camera.enabled || !playbackEnabled || runtime.status !== 'online') {
      if (runtimeRef.current.fps !== 0) patch({ fps: 0 });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    let frameCallback: number | undefined;
    let previousFrames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const countFrame: VideoFrameRequestCallback = () => {
      framesRef.current += 1;
      frameCallback = video.requestVideoFrameCallback(countFrame);
    };
    if (video.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(countFrame);
    const id = window.setInterval(() => {
      const now = Date.now();
      const elapsed = (now - lastFpsRef.current) / 1000;
      const totalFrames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? previousFrames;
      const frames = frameCallback === undefined ? totalFrames - previousFrames : framesRef.current;
      const fps = elapsed > 0 ? Math.round(frames / elapsed) : 0;
      previousFrames = totalFrames;
      framesRef.current = 0;
      lastFpsRef.current = now;
      if (runtimeRef.current.fps !== fps) patch({ fps });
    }, 1000);
    return () => {
      window.clearInterval(id);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    };
  }, [camera.enabled, playbackEnabled, runtime.status, patch]);

  // ---- Shared analysis of live frames and lightweight still snapshots -----
  const drawWorkFrame = useCallback((source: CanvasImageSource, width: number, height: number) => {
    const canvas = workRef.current ?? (workRef.current = document.createElement('canvas'));
    const w = Math.min(320, width);
    const h = Math.max(1, Math.round(height / width * w));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return { canvas, frame: ctx.getImageData(0, 0, w, h) };
  }, []);

  const analyzeFrame = useCallback(async (
    source: CanvasImageSource,
    width: number,
    height: number,
    isStopped: () => boolean,
  ) => {
    if (!camera.enabled || isStopped()) return;
    const revision = analysisRevisionRef.current;
    const cancelled = () => isStopped()
      || revision !== analysisRevisionRef.current || !analysisActiveRef.current;
    const started = performance.now();
    try {
      const drawn = drawWorkFrame(source, width, height);
      if (!drawn) return;
      if (!camera.aiEnabled || cancelled()) return;
      const { canvas, frame } = drawn;
      const frameId = ++latestFrameRef.current;
      const sal = computeSaliency(frame, prevFrameRef.current, 'sobel', settings.saliencyThreshold ?? 40);
      prevFrameRef.current = frame;
      const saliencyScore = computeSaliencyScore(sal);
      const fuseAttention = (objects = runtimeRef.current.objects) => Math.min(100, Math.round(
        0.5 * runtimeRef.current.saliencyScore
        + 0.3 * Math.max(0, ...objects.map(object => object.confidence * 100))
        + 0.2 * (runtimeRef.current.audioDistress.detected ? runtimeRef.current.audioDistress.confidence * 100 : 0),
      ));
      // Publish cheap metrics immediately. Neither neural model holds up the UI.
      patch({
        saliencyScore,
        frameWidth: canvas.width, frameHeight: canvas.height,
        lastDetectionAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
      });
      const attentionScore = fuseAttention();
      patch({ attentionScore });
      if (saliencyScore > 70) emit('saliency', `High saliency (${saliencyScore})`, saliencyScore / 100, false);
      if (attentionScore > 70) emit('saliency', `High attention (${attentionScore})`, attentionScore / 100, false);

      const analyzeFire = (objects = runtimeRef.current.objects) => {
        if (cancelled()) return;
        const fire = detectFire(frame, fireStateRef.current, objects);
        patch({
          fire: { detected: fire.fireDetected && fire.confidence >= settings.fireThreshold,
            confidence: fire.confidence, bbox: fire.smoothedBbox,
            classification: fire.classification, rejectedReason: fire.rejectedReason },
          fireAnalysis: fire,
          smoke: { detected: fire.smokeEmergency, confidence: fire.smokeRatio },
        });
        if (fire.fireDetected && fire.confidence >= settings.fireThreshold) {
          emit('fire', fire.largeFire ? 'Large fire detected' : 'Fire detected', fire.confidence);
        }
        if (fire.smokeEmergency) emit('smoke', 'Smoke / low visibility', fire.smokeRatio);
      };
      // Screen exclusions need a recent object pass. Never assume an unscanned
      // orange rectangle is a real flame while the display detector is loading.
      const objectsFresh = lastObjectAtRef.current > 0 && Date.now() - lastObjectAtRef.current <= OBJECT_MAX_AGE_MS;
      if (objectsFresh) analyzeFire();

      if (Date.now() - lastFaceStartedRef.current >= FACE_INTERVAL_MS) {
        lastFaceStartedRef.current = Date.now();
        faceAnalysisRevisionRef.current = revision;
        void analyzeFace(canvas).catch(() => {});
      }
      if (busyRef.current || Date.now() - lastObjectStartedRef.current < OBJECT_INTERVAL_MS) return;
      const objectCanvas = objectCanvasRef.current ?? (objectCanvasRef.current = document.createElement('canvas'));
      objectCanvas.width = canvas.width; objectCanvas.height = canvas.height;
      objectCanvas.getContext('2d')?.drawImage(canvas, 0, 0);
      busyRef.current = true;
      lastObjectStartedRef.current = Date.now();
      const objectStarted = performance.now();
      void detectObjects(objectCanvas, Math.min(settings.objectThreshold, 0.45)).then(predictions => {
        if (cancelled()) return;
        const objects = predictions.filter(object => object.confidence >= settings.objectThreshold || DISPLAY_LABELS.has(object.label));
        lastObjectAtRef.current = Date.now();
        const humanCount = objects.filter(o => HUMAN_LABELS.has(o.label)).length;
        patch({ objects, humanCount, attentionScore: fuseAttention(objects),
          objectLatencyMs: Math.round(performance.now() - objectStarted),
          detections: runtimeRef.current.detections + objects.length });
        // Only score this captured frame if it is still the latest one.
        if (!objectsFresh && latestFrameRef.current === frameId) analyzeFire(objects);
        const historyObjects = settings.priorityObjects
          ? objects.filter(object => HUMAN_LABELS.has(object.label) || settings.priorityObjects.includes(object.label))
          : objects;
        for (const object of historyObjects) emit('object', object.label, object.confidence, false);
        if (humanCount > 0) emit('human', `${humanCount} person(s)`, 0.9, false);
      }).catch(() => {}).finally(() => { busyRef.current = false; });
    } catch {
      // A detector failure does not interrupt previews, playback, or audio.
    }
  }, [camera.enabled, camera.aiEnabled, settings.objectThreshold, settings.fireThreshold, settings.saliencyThreshold, settings.priorityObjects, analyzeFace, drawWorkFrame, patch, emit]);
  const analyzeFrameRef = useRef(analyzeFrame);
  analyzeFrameRef.current = analyzeFrame;

  useEffect(() => {
    if (!camera.enabled || !camera.aiEnabled) return;
    void loadDetector().catch(() => {});
  }, [camera.enabled, camera.aiEnabled]);

  // Monitoring samples stills twice a second; idle previews use three seconds.
  // Requests never overlap. This leaves the
  // backend's audio listener active without a browser video or HLS connection.
  useEffect(() => {
    if (!camera.enabled || playbackEnabled) return;
    let stopped = false;
    let inFlight = false;
    let request: AbortController | null = null;
    let lastSnapshotTimestamp: number | null = null;
    const canvas = document.createElement('canvas');
    const Capture = (window as Window & { ImageCapture?: ImageCaptureConstructor }).ImageCapture;
    const track = sourceStream?.getVideoTracks()[0];
    let capture: FrameCapture | null = null;
    try {
      if (track && Capture) capture = new Capture(track);
    } catch (error) {
      patch({ status: 'error', error: error instanceof Error ? error.message : 'Unable to capture webcam snapshots.' });
      return;
    }
    if (sourceStream && !capture) {
      patch({ status: 'error', error: 'Still previews are unavailable for this webcam in this browser. Open Cameras for live video.' });
      return;
    }
    patch({ status: 'connecting', error: null, fps: 0 });
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      let decoded: Awaited<ReturnType<typeof decodeSnapshot>> | null = null;
      try {
        let timestamp: number;
        if (capture) {
          const image = await capture.grabFrame();
          decoded = { image, width: image.width, height: image.height, close: () => image.close() };
          timestamp = Date.now();
        } else {
          request = new AbortController();
          const result = await getCameraSnapshot(settings.pythonServer, camera.id, request.signal, analysisActiveRef.current);
          if (stopped) return;
          decoded = await decodeSnapshot(result.blob, request.signal);
          timestamp = result.timestamp;
        }
        if (stopped) return;
        if (!decoded.width || !decoded.height) throw new Error('Camera snapshot is empty.');
        const w = Math.min(640, decoded.width);
        const h = Math.max(1, Math.round(w * decoded.height / decoded.width));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Unable to display camera snapshot.');
        ctx.drawImage(decoded.image, 0, 0, w, h);
        setPreview({ image: canvas.toDataURL('image/jpeg', 0.65), timestamp });
        patch({ status: 'online', error: null, fps: 0 });
        // Keep a durable still for audio-triggered event snapshots even when AI
        // is disabled. Never alter a canvas while its detector is reading it.
        // The analyzer copies pixels synchronously before its first await. Let
        // a slow model finish independently so still previews keep refreshing,
        // and release the decoded full-size bitmap as soon as it is copied.
        if (timestamp !== lastSnapshotTimestamp) {
          lastSnapshotTimestamp = timestamp;
          void analyzeFrameRef.current(decoded.image, decoded.width, decoded.height, () => stopped);
        }
      } catch (error) {
        if (!stopped) patch({ status: 'error', fps: 0, error: error instanceof Error ? error.message : 'Camera snapshot unavailable.' });
      } finally {
        decoded?.close();
        request = null;
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(tick, camera.aiEnabled ? MONITORING_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS);
    return () => { stopped = true; window.clearInterval(id); request?.abort(); };
  }, [camera.enabled, camera.aiEnabled, camera.id, playbackEnabled, sourceStream, settings.pythonServer, nonce, patch, drawWorkFrame]);

  // Live frames are processed only while their camera player is visible.
  useEffect(() => {
    if (!camera.enabled || !camera.aiEnabled || !playbackEnabled) return;
    let stopped = false;
    const tick = async () => {
      const video = videoRef.current;
      if (stopped || !video || video.readyState < 2 || !video.videoWidth) return;
      await analyzeFrameRef.current(video, video.videoWidth, video.videoHeight, () => stopped);
    };
    const id = window.setInterval(tick, VISUAL_INTERVAL_MS);
    return () => { stopped = true; window.clearInterval(id); };
  }, [camera.enabled, camera.aiEnabled, playbackEnabled]);

  // Facial distress -> runtime + event
  useEffect(() => {
    if (!camera.enabled || !camera.aiEnabled || faceAnalysisRevisionRef.current !== analysisRevisionRef.current) return;
    const d = face.distress;
    const detected = d.hasFace && d.distressLevel !== 'none';
    patch({
      faceLatencyMs: face.latencyMs,
      faceDistress: {
        detected,
        label: d.expression ?? '',
        confidence: d.distressScore / 100,
      },
    });
    if (d.distressLevel === 'severe') emit('face-distress', d.expression || 'distress', d.distressScore / 100);
  }, [camera.enabled, camera.aiEnabled, face.distress, face.latencyMs, patch, emit]);

  // ---- Audio: RTSP audio -> ffmpeg -> Whisper on the backend ---------------
  // The browser never opens a microphone. Listening runs whenever the camera is
  // connected, independently of the AI detection switch.
  useEffect(() => {
    const source = `${settings.pythonServer}:${camera.id}`;
    if (audioSourceRef.current !== source) {
      audioSourceRef.current = source;
      lastAudioRef.current = undefined;
      lastTranscriptRevisionRef.current = '';
      showTranscript('', 0);
    }
    if (sourceStream) {
      showTranscript('', 0);
      patch({ audioListening: false, audioMessage: 'Local microphone listening is managed on the dashboard.', audioTone: 'wait' });
      return;
    }
    if (!camera.enabled) {
      showTranscript('', 0);
      patch({
        audioListening: false,
        audioMessage: 'Connect this camera to start listening.',
        audioTone: 'wait',
      });
      return;
    }
    let stopped = false;
    let inFlight = false;
    patch({ audioListening: true, audioMessage: 'Starting to listen…', audioTone: 'wait' });

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { events, status } = await getAudioEvents(
          settings.pythonServer, camera.id, lastAudioRef.current,
        );
        if (stopped) return;
        const described = describeAudioStatus(status, true);
        patch({
          audio: status,
          interimTranscript: '',
          audioBackendReachable: true,
          audioMessage: described.message,
          audioTone: described.tone,
        });

        const fresh = events ?? [];
        const final = latestFinalTranscript(fresh, status);
        const revision = final ? `${final.timestamp}:${final.text}` : '';
        if (final && revision !== lastTranscriptRevisionRef.current) {
          lastTranscriptRevisionRef.current = revision;
          showTranscript(final.text, transcriptRemainingMs(final.timestamp));
        }
        if (fresh.length) {
          lastAudioRef.current = fresh[fresh.length - 1].timestamp;
          for (const e of fresh) {
            // Retained event history belongs in the sidebar, not in new alerts.
            if (transcriptRemainingMs(e.timestamp) === 0) continue;
            // Backend keyword list OR the full Tagalog/English safety library.
            const safety = matchWakeWord(e.transcript || '');
            const keyword = safety.matched ? safety.phrase : e.keyword;
            const confidence = Math.max(e.confidence || 0, safety.matched ? safety.confidence : 0);
            if (!keyword || confidence < settings.audioThreshold) continue;
            patch({
              audioDistress: {
                detected: true, keyword, confidence, transcript: e.transcript,
              },
              attentionScore: Math.min(100, Math.round(0.5 * runtimeRef.current.saliencyScore
                + 0.3 * Math.max(0, ...runtimeRef.current.objects.map(object => object.confidence * 100))
                + 0.2 * confidence * 100)),
            });
            window.clearTimeout(audioDistressTimerRef.current);
            audioDistressTimerRef.current = window.setTimeout(() => {
              patch({ audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' },
                attentionScore: Math.min(100, Math.round(0.5 * runtimeRef.current.saliencyScore
                  + 0.3 * Math.max(0, ...runtimeRef.current.objects.map(object => object.confidence * 100)))) });
            }, TRANSCRIPT_CLEAR_MS);
            emit('audio-distress', `Safety word: "${keyword}"`, confidence);
          }
        }
      } catch (err) {
        if (stopped) return;
        const message = err instanceof Error ? err.message : String(err);
        const described = describeAudioStatus(null, false);
        patch({
          audioBackendReachable: false,
          audioMessage: `${described.message} (${message})`,
          audioTone: 'error',
        });
      } finally {
        inFlight = false;
      }
    };

    const id = window.setInterval(poll, AUDIO_POLL_INTERVAL_MS);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.clearTimeout(audioDistressTimerRef.current);
      patch({ audioListening: false, audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' } });
    };
  }, [camera.enabled, camera.id, sourceStream, settings.pythonServer, settings.audioThreshold, patch, emit, showTranscript]);


  const reconnect = useCallback(() => {
    webRtcRef.current?.close();
    webRtcRef.current = null;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    retryRef.current = 0;
    patch({ status: 'connecting', error: null });
    setNonce(n => n + 1);
  }, [patch]);

  return { videoRef, homeRef, runtime, reconnect, streamUrl: url, faceReady: face.ready, preview: preview?.image ?? null, previewTimestamp: preview?.timestamp ?? null };
}
