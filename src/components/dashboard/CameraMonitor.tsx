import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useCameraPipeline } from '@/hooks/useCameraPipeline';
import { slotCamera, slotSettings, type CameraSlot } from '@/hooks/useCameraSlots';
import { clearCameraSession, getCameraSession, publishCameraSession, saveCameraStill } from '@/lib/cameraSessions';
import type { CameraRuntime, DetectionEvent, MultiCamSettings } from '@/types/multicam';

interface CameraMonitorProps {
  slot: CameraSlot;
  monitoring: boolean;
  playbackEnabled: boolean;
  localStream?: MediaStream | null;
  baseSettings?: MultiCamSettings;
  onEvent?: (evt: Omit<DetectionEvent, 'id'>) => void;
  onMetrics?: (index: number, runtime: CameraRuntime) => void;
}

/** Persistent camera processing; visible cards only consume its session. */
export default function CameraMonitor({ slot, monitoring, playbackEnabled, localStream, baseSettings, onEvent, onMetrics }: CameraMonitorProps) {
  const camera = useMemo(() => {
    const configured = slotCamera(slot);
    return {
      ...configured,
      enabled: localStream ? localStream.getVideoTracks().some(track => track.readyState !== 'ended') : configured.enabled,
      location: localStream ? 'Local webcam' : configured.location,
      aiEnabled: slot.aiEnabled && monitoring,
    };
  }, [slot, monitoring, localStream]);
  const settings = useMemo(() => slotSettings(slot, baseSettings), [slot, baseSettings]);
  const { videoRef, homeRef, runtime, reconnect, preview, previewTimestamp } = useCameraPipeline({
    camera,
    settings,
    onEvent,
    managedVideo: true,
    playbackEnabled,
    sourceStream: localStream,
  });
  const metricsRef = useRef(onMetrics);
  metricsRef.current = onMetrics;
  const latestStillRef = useRef<{ image: string; timestamp: number } | null>(null);
  if (preview && previewTimestamp !== null) latestStillRef.current = { image: preview, timestamp: previewTimestamp };
  const sourceVideo = videoRef.current;

  // A disconnection or unmount records the latest available real still. The
  // live cleanup below can replace this with the final video frame afterward.
  useLayoutEffect(() => {
    if (!camera.enabled) return;
    return () => {
      const still = latestStillRef.current;
      if (still) saveCameraStill(camera.id, still.image, still.timestamp);
    };
  }, [camera.id, camera.enabled]);

  // Layout cleanup runs before the pipeline's passive video teardown. Capture
  // the actual final ready frame on leaving Cameras, disconnect, or unmount.
  useLayoutEffect(() => {
    if (!camera.enabled || !playbackEnabled || !sourceVideo) return;
    const capture = (onlyIfEmpty: boolean) => {
      if (onlyIfEmpty && getCameraSession(camera.id).preview) return;
      if (sourceVideo.readyState < 2 || !sourceVideo.videoWidth || !sourceVideo.videoHeight) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(640, sourceVideo.videoWidth);
        canvas.height = Math.max(1, Math.round(canvas.width * sourceVideo.videoHeight / sourceVideo.videoWidth));
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
        saveCameraStill(camera.id, canvas.toDataURL('image/jpeg', 0.65), Date.now(), onlyIfEmpty);
      } catch {
        // Keep the previous image if this source does not allow canvas access.
      }
    };
    const captureFirst = () => capture(true);
    const captureFinal = () => capture(false);
    sourceVideo.addEventListener('loadeddata', captureFirst);
    window.addEventListener('pagehide', captureFinal);
    captureFirst();
    return () => {
      sourceVideo.removeEventListener('loadeddata', captureFirst);
      window.removeEventListener('pagehide', captureFinal);
      captureFinal();
    };
  }, [camera.id, camera.enabled, playbackEnabled, sourceVideo]);

  useEffect(() => {
    publishCameraSession(camera.id, {
      video: videoRef.current,
      home: homeRef.current,
      runtime,
      reconnect,
    });
    metricsRef.current?.(slot.index, runtime);
  }, [camera.id, slot.index, runtime, reconnect, videoRef, homeRef, playbackEnabled]);

  useEffect(() => {
    return () => {
      clearCameraSession(camera.id);
    };
  }, [camera.id]);

  useEffect(() => {
    if (preview && previewTimestamp !== null) {
      saveCameraStill(camera.id, preview, previewTimestamp, true);
    }
  }, [camera.id, preview, previewTimestamp]);

  return null;
}
