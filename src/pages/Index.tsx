import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Moon, Sun, Home, LogOut, Shield, Wifi, X, Flame, HelpCircle, Menu, Sparkles, Mic } from 'lucide-react';
import DashboardCameraCard from '@/components/dashboard/DashboardCameraCard';
import CameraMonitor from '@/components/dashboard/CameraMonitor';
import Monitoring from '@/pages/Monitoring';
import DashboardEvents from '@/components/dashboard/DashboardEvents';
import ControlsPanel from '@/components/dashboard/ControlsPanel';
import AttentionGauge from '@/components/dashboard/AttentionGauge';
import DetectionFeedback from '@/components/dashboard/DetectionFeedback';
import PerformanceMonitor from '@/components/dashboard/PerformanceMonitor';
import TutorialOverlay, { type TutorialStep } from '@/components/dashboard/TutorialOverlay';
import ExpertMode, { type AlgorithmId } from '@/components/dashboard/ExpertMode';
import AccessibilityPanel from '@/components/dashboard/AccessibilityPanel';
import MultiCameraConnect from '@/components/dashboard/MultiCameraConnect';
import { setHintsSuppressed } from '@/components/IdleHint';
import { useCamera } from '@/hooks/useCamera';
import { useAudioAnalysis } from '@/hooks/useAudioAnalysis';
import { useYamnet } from '@/hooks/useYamnet';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useAuth } from '@/hooks/useAuth';
import { useHousehold } from '@/hooks/useHousehold';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { loadServerHost, serverUrlFor, useCameraSlots, type SlotCount } from '@/hooks/useCameraSlots';
import { useWakeLock } from '@/hooks/useWakeLock';
import { announce } from '@/lib/voiceGuide';
import { sendAlertEmail } from '@/lib/alertEmail';
import { stopAll as stopAllCameras, stopCamera } from '@/lib/multiCamServer';
import { matchWakeWord } from '@/lib/safetyLexicon';
import { getCameraSession } from '@/lib/cameraSessions';
import { appendAlertBatch } from '@/lib/alertHistory';
import { clipFileName, recordClip, saveClip, restoreClipFolder, getClipFolderLabel, reportClipStatus, NO_CLIP_FOLDER_MESSAGE } from '@/lib/clipRecorder';
import { recordCameraClip } from '@/lib/cameraRecording';
import type { CameraRuntime, DetectionEvent } from '@/types/multicam';
import type { Alert, QualityMode } from '@/types/dashboard';
import { DEFAULT_PRIORITY_OBJECTS } from '@/types/dashboard';

const monitoringSession = { running: false };
const EMERGENCY_TYPES = new Set<DetectionEvent['type']>(['fire', 'smoke', 'face-distress', 'audio-distress']);

const ALGORITHM_TOURS: Record<AlgorithmId, TutorialStep[]> = {
  vision: [
    {
      selector: '#tour-fused-view', placement: 'bottom', title: 'Visual saliency',
      body: 'Each camera frame is changed to grayscale. Sobel edges or frame-to-frame motion reveal the parts that deserve attention.',
      implementation: 'src/lib/saliency.ts',
      code: `const saliency = computeSaliency(frame, previousFrame, 'sobel', 40);\nconst score = computeSaliencyScore(saliency);`,
    },
    {
      selector: '#tour-fused-view', placement: 'bottom', title: 'Object detection',
      body: 'COCO-SSD with MobileNet v2 identifies people and common objects. A confidence threshold removes uncertain boxes.',
      implementation: 'src/lib/detectionEngine.ts',
      code: `const predictions = await model.detect(frame, 20, minimumConfidence);`,
    },
  ],
  fire: [
    {
      selector: '#tour-fire-analysis', placement: 'top', title: 'Fire and smoke analysis',
      body: 'The system combines fire-colored pixels, movement over recent frames, smoke color, and visibility. TV, phone, laptop, poster, and static-red false alarms are rejected.',
      implementation: 'src/lib/fireDetection.ts',
      code: `confidence = fireColor + flicker + smoke + lowVisibility;\nif (insideScreen || staticRedObject) rejectCandidate();`,
    },
  ],
  face: [
    {
      selector: '#tour-face-distress', placement: 'top', title: 'Facial distress',
      body: 'TinyFaceDetector finds faces; the largest face is scored. Expression probabilities are weighted and averaged across three samples. This is a visual distress heuristic.',
      implementation: 'src/hooks/useFaceDistress.ts',
      code: `distress = min(100, round(100*(sad + 1.4*fearful + 0.8*angry + 0.7*disgusted)));\nscore = average(lastThreeSamples);`,
    },
  ],
  speech: [
    {
      selector: '#tour-live-transcription', placement: 'bottom', title: 'CCTV speech transcription',
      body: 'Sound comes from the CCTV RTSP stream. FFmpeg creates 16 kHz mono WAV chunks, then local Whisper returns the complete English or Tagalog sentence.',
      implementation: 'local-server/msds/camera.py · local-server/msds/whisper_engine.py',
      code: `RTSP audio → FFmpeg WAV chunks → Whisper sentence`,
    },
    {
      selector: '#tour-live-transcription', placement: 'bottom', title: 'Safety phrase matching',
      body: 'The complete sentence stays visible. Separately, the safety library checks phrases such as “help me”, “call police”, “tulong”, and “tumawag kayo ng pulis” for alert logic.',
      implementation: 'src/lib/safetyLexicon.ts',
      code: `const safetyMatch = matchWakeWord(fullTranscript);`,
    },
  ],
  audio: [
    {
      selector: '#tour-audio-distress', placement: 'top', title: 'Sound distress',
      body: 'YAMNet examines short sound windows and scores safety sounds such as screaming, crying, shouting, and wailing while suppressing ordinary sounds.',
      implementation: 'src/hooks/useYamnet.ts',
      code: `distress = weightedSafetySounds - 0.5 * ordinarySounds;`,
    },
  ],
  hybrid: [
    {
      selector: '#tour-fused-view', placement: 'bottom', title: '1. Observe every signal',
      body: 'The hybrid system watches visual saliency and objects while listening for sound distress and English or Tagalog safety speech. It also checks faces, fire, smoke, and visibility.',
      implementation: 'src/hooks/useCameraPipeline.ts',
      code: `vision + objects + sound + speech + face + fire + smoke`,
    },
    {
      selector: '#tour-saliency-score', placement: 'top', title: '2. Combine attention',
      body: 'The main attention score combines visual saliency, audio activity, and object confidence. Other critical detectors can independently raise a safety event.',
      implementation: 'src/pages/Index.tsx',
      code: `attention = 0.40*visual + 0.30*audio + 0.30*objects;`,
    },
    {
      selector: '#tour-alert-log', placement: 'left', title: '3. Record the result',
      body: 'Only meaningful safety events become alerts. The system applies cooldowns, records the source and time, and shows the result in the event log.',
      implementation: 'src/pages/Index.tsx · src/components/dashboard/AlertLog.tsx',
      code: `if (safetyEvent && cooldownReady) addAlert(event);`,
    },
  ],
};


/** Camera monitoring persists across routes; browser video exists only in the live view. */
export default function Index() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const liveView = location.pathname === '/cameras';
  const requestedCamera = searchParams.get('camera');
  const { events, settings, addEvent, updateEvent, updateSettings } = useCameraRegistry();
  const { householdId, checkForWakeWord, logAlert, logNotification } = useHousehold(user?.id);
  const { cameras, devices, startCameras, stopCameras, enumerateDevices } = useCamera();
  const { count, slots, setCount, updateSlot } = useCameraSlots();
  const { audioFeatures, startAudio, stopAudio } = useAudioAnalysis();
  const speech = useSpeechRecognition();
  const { start: startSpeech, stop: stopSpeech, clear: clearSpeech, supported: speechSupported } = speech;
  const [running, setRunningState] = useState(monitoringSession.running);
  const setRunning = useCallback((value: boolean) => {
    monitoringSession.running = value;
    setRunningState(value);
  }, []);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('safewatch-dark-mode') === 'true');
  const [showIpDialog, setShowIpDialog] = useState(false);
  const [selectedCamera, setSelectedCamera] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showEmergency, setShowEmergency] = useState(false);
  const [showExpert, setShowExpert] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialOverride, setTutorialOverride] = useState<TutorialStep[] | null>(null);
  const [runtimes, setRuntimes] = useState<Record<number, CameraRuntime>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [cameraError, setCameraError] = useState('');
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showAlerts, setShowAlerts] = useState(true);
  const [quality, setQuality] = useState<QualityMode>('SD');
  const [mirror, setMirror] = useState(false);
  const [heatmapOpacity, setHeatmapOpacity] = useState(50);
  const [simulationMode, setSimulationMode] = useState(false);
  const [priorityObjects, setPriorityObjects] = useState<string[]>(DEFAULT_PRIORITY_OBJECTS);
  const alertCooldown = useRef(new Map<string, number>());
  const recordingCameras = useRef(new Set<string>());
  const householdMatches = useRef(new Map<number, { phrase: string; at: number }>());
  const previousConnections = useRef(new Set<number>());
  const connected = slots.filter(slot => slot.connected);
  const localCameras = cameras.filter(camera => camera.active && camera.stream);
  const localAudioEnabled = running && localCameras.length > 0 && connected.length === 0;
  const yamnet = useYamnet(localAudioEnabled);
  const pipelineSettings = useMemo(() => ({ ...settings, priorityObjects }), [settings, priorityObjects]);
  const currentRuntime = runtimes[selectedCamera];
  const focusedLiveCamera = slots.some(slot => `slot-${slot.index}` === requestedCamera) ? requestedCamera : null;
  const attention = selectedCamera === 1 && localAudioEnabled
    ? Math.round((currentRuntime?.saliencyScore ?? 0) * 0.4 + yamnet.distressScore * 0.3 + Math.max(0, ...(currentRuntime?.objects.map(object => object.confidence * 100) || [])) * 0.3)
    : currentRuntime?.attentionScore ?? 0;
  const saliency = currentRuntime?.saliencyScore ?? 0;
  const eventCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.cameraId, (counts.get(event.cameraId) || 0) + 1);
    return counts;
  }, [events]);
  useWakeLock(running || connected.length > 0);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('safewatch-dark-mode', String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    void enumerateDevices();
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const refresh = () => { void enumerateDevices(); };
    media.addEventListener('devicechange', refresh);
    return () => media.removeEventListener('devicechange', refresh);
  }, [enumerateDevices]);

  useEffect(() => {
    setHintsSuppressed(running || connected.length > 0);
    return () => setHintsSuppressed(false);
  }, [running, connected.length]);

  const openConnection = useCallback((index: number) => {
    if (index > count) setCount(index as SlotCount);
    setSelectedCamera(index);
    setShowIpDialog(true);
  }, [count, setCount]);

  useEffect(() => {
    if (liveView) return;
    const index = Number(searchParams.get('connect'));
    if (index >= 1 && index <= 4) openConnection(index);
    const eventCamera = searchParams.get('events');
    if (eventCamera) navigate(`/cameras?camera=${encodeURIComponent(eventCamera)}&events=${encodeURIComponent(eventCamera)}`, { replace: true });
  }, [searchParams, liveView, openConnection, navigate]);

  const closeConnection = () => {
    setShowIpDialog(false);
    if (searchParams.has('connect')) {
      const next = new URLSearchParams(searchParams);
      next.delete('connect');
      setSearchParams(next, { replace: true });
    }
  };

  useEffect(() => {
    const current = new Set(slots.filter(slot => slot.connected).map(slot => slot.index));
    const added = [...current].some(index => !previousConnections.current.has(index));
    previousConnections.current = current;
    if (added) { setRunning(true); setCameraError(''); }
  }, [slots, setRunning]);

  const storeEvent = useCallback((event: Omit<DetectionEvent, 'id'>) => {
    const id = crypto.randomUUID();
    addEvent({ ...event, id });
    const video = getCameraSession(event.cameraId).video;
    if (!EMERGENCY_TYPES.has(event.type) || recordingCameras.current.has(event.cameraId)) return id;
    recordingCameras.current.add(event.cameraId);
    void (async () => {
      await restoreClipFolder();
      if (!getClipFolderLabel()) throw new Error(NO_CLIP_FOLDER_MESSAGE);
      reportClipStatus({ state: 'recording', message: `${event.cameraName}: Recording a 10 second clip…` });
      const index = Number(event.cameraId.replace('slot-', '')) || 1;
      const stream = cameras[index - 1]?.stream;
      // Borrow live playback or a webcam stream; CCTV still view records on the
      // bridge from its existing restream without opening dashboard playback.
      let localVideo: HTMLVideoElement | null = null;
      try {
        if (!video && stream) {
          localVideo = document.createElement('video');
          localVideo.srcObject = stream;
        }
        const blob = video || localVideo
          ? await recordClip((video || localVideo)!)
          : await recordCameraClip(settings.pythonServer, event.cameraId);
        if (!blob) throw new Error('Could not record a clip from this camera.');
        const name = clipFileName(event.cameraName, event.type, blob.type);
      await saveClip(blob, name);
      updateEvent(id, { clipFile: name, clipUrl: URL.createObjectURL(blob) });
      } finally { if (localVideo) localVideo.srcObject = null; }
    })().catch(error => reportClipStatus({ state: 'error', message: error instanceof Error ? error.message : 'Could not save the emergency recording.' }))
      .finally(() => recordingCameras.current.delete(event.cameraId));
    return id;
  }, [addEvent, updateEvent, cameras, settings.pythonServer]);

  const raiseAlert = useCallback((event: Omit<DetectionEvent, 'id'>, severity: Alert['severity'], alreadyStored = false) => {
    const key = `${event.cameraId}:${event.label}`;
    const now = Date.now();
    if (now - (alertCooldown.current.get(key) || 0) < (severity === 'critical' ? 3000 : 15000)) return;
    alertCooldown.current.set(key, now);
    const id = alreadyStored ? crypto.randomUUID() : storeEvent(event);
    const index = Number(event.cameraId.replace('slot-', '')) || 1;
    setAlerts(previous => appendAlertBatch(previous, { id, timestamp: new Date(event.timestamp), message: `${event.cameraName}: ${event.label}`, severity, cameraId: index }));
    if (severity === 'high' || severity === 'critical') {
      announce(`Alert. ${event.cameraName}. ${event.label}`, true);
      void logAlert(event.type, `${event.cameraName}: ${event.label}`);
      if (householdId) void sendAlertEmail({
        householdId, alertId: id, alertType: event.type, message: `${event.cameraName}: ${event.label}`,
        severity, cameraLabel: event.cameraName, occurredAt: event.timestamp, confidence: event.confidence,
        trigger: event.label, details: { Location: event.location || undefined },
      });
      if (EMERGENCY_TYPES.has(event.type)) setShowEmergency(true);
    }
  }, [storeEvent, logAlert, householdId]);

  const handleEvent = useCallback((event: Omit<DetectionEvent, 'id'>) => {
    if (event.type === 'object' || event.type === 'human') { storeEvent(event); return; }
    raiseAlert(event, event.type === 'fire' || event.type === 'smoke' ? 'critical' : 'high');
  }, [storeEvent, raiseAlert]);

  const handleMetrics = useCallback((index: number, runtime: CameraRuntime) => {
    setRuntimes(previous => previous[index] === runtime ? previous : { ...previous, [index]: runtime });
    const match = runtime.transcript ? checkForWakeWord(runtime.transcript) : null;
    if (!match?.matched) return;
    const previous = householdMatches.current.get(index);
    const now = Date.now();
    if (previous?.phrase === match.phrase && now - previous.at < 15000) return;
    householdMatches.current.set(index, { phrase: match.phrase, at: now });
    const slot = slots[index - 1];
    raiseAlert({ cameraId: `slot-${index}`, cameraName: slot.name, location: slot.ip,
      type: 'audio-distress', label: `Wake word: "${match.phrase}"`, confidence: 1,
      timestamp: new Date(now).toISOString(), snapshot: getCameraSession(`slot-${index}`).preview || undefined,
    }, match.isEmergency ? 'critical' : 'high');
    void logNotification(match.wakeWordId, match.phrase, match.actionType, match.isEmergency);
  }, [checkForWakeWord, slots, raiseAlert, logNotification]);

  // A local webcam uses the existing local microphone. CCTV speech comes only from its bridge.
  useEffect(() => {
    if (!running || !localCameras.length || connected.length) return;
    const text = speech.transcript.trim();
    const household = checkForWakeWord(text);
    const safety = matchWakeWord(text);
    if (!household.matched && !safety.matched) return;
    const phrase = household.matched ? household.phrase : safety.phrase;
    const emergency = household.matched ? household.isEmergency : safety.severity === 'critical';
    const slot = slots[0];
    raiseAlert({ cameraId: 'slot-1', cameraName: slot.name, location: '', type: 'audio-distress',
      label: `Wake word: "${phrase}"`, confidence: household.matched ? 1 : safety.confidence,
      timestamp: new Date().toISOString(), snapshot: getCameraSession('slot-1').preview || undefined,
    }, emergency ? 'critical' : 'high');
  }, [running, localCameras.length, connected.length, speech.transcript, speech.transcriptRevision, checkForWakeWord, slots, raiseAlert]);

  useEffect(() => {
    if (!running || !localCameras.length || connected.length || !['scream', 'bang'].includes(audioFeatures.audioEvent)) return;
    raiseAlert({ cameraId: 'slot-1', cameraName: slots[0].name, location: '', type: 'audio-distress',
      label: `${audioFeatures.audioEvent === 'scream' ? 'Scream' : 'Impact'} detected`, confidence: 0,
      timestamp: new Date().toISOString(), snapshot: getCameraSession('slot-1').preview || undefined,
    }, audioFeatures.audioEvent === 'bang' ? 'critical' : 'high');
  }, [running, localCameras.length, connected.length, audioFeatures.audioEvent, slots, raiseAlert]);

  useEffect(() => {
    if (!localAudioEnabled || yamnet.distressScore < 35) return;
    raiseAlert({ cameraId: 'slot-1', cameraName: slots[0].name, location: 'Local microphone', type: 'audio-distress',
      label: `Audio distress: ${yamnet.topLabel} (${yamnet.distressScore}%)`, confidence: yamnet.topScore,
      timestamp: new Date().toISOString(), snapshot: getCameraSession('slot-1').preview || undefined,
    }, yamnet.distressScore >= 60 ? 'critical' : 'high');
  }, [localAudioEnabled, yamnet.distressScore, yamnet.topLabel, yamnet.topScore, slots, raiseAlert]);

  const handleStart = useCallback(async () => {
    setCameraError('');
    if (slots.some(slot => slot.connected)) { setRunning(true); return; }
    const started = await startCameras(quality).catch(() => []);
    if (!started.some(camera => camera.active)) {
      setCameraError('Connect a CCTV camera or an available webcam to start monitoring.');
      openConnection(1);
      return;
    }
    void startAudio().catch(() => {});
    if (speechSupported) startSpeech();
    setRunning(true);
  }, [slots, startCameras, quality, startAudio, speechSupported, startSpeech, setRunning, openConnection]);

  const handleStop = useCallback(() => {
    setRunning(false);
    stopCameras(); stopAudio(); stopSpeech(); clearSpeech();
    const server = serverUrlFor(loadServerHost());
    for (const slot of slots) if (slot.connected) {
      updateSlot(slot.index, { connected: false, streamUrl: '' });
      void stopCamera(server, `slot-${slot.index}`).catch(() => {});
    }
    void stopAllCameras(server).catch(() => {});
  }, [setRunning, stopCameras, stopAudio, stopSpeech, clearSpeech, slots, updateSlot]);

  const exportCSV = () => {
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [['Timestamp', 'Camera', 'Detection', 'Confidence'], ...events.map(event => [event.timestamp, event.cameraName, event.label, String(event.confidence)])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
    const link = document.createElement('a'); link.href = url; link.download = `camera-events-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const tutorialSteps: TutorialStep[] = [
    { selector: '#tour-header', title: 'Monitoring dashboard', placement: 'bottom', body: 'Connect your cameras and review their latest snapshots here.' },
    { selector: '#tour-cams', title: 'Last-seen images', placement: 'bottom', body: 'Each card holds the last image captured from its camera. Open a connected camera for realtime video; offline cards open connection settings.' },
    { selector: '#tour-live-transcription', title: 'Camera audio', placement: 'bottom', body: 'CCTV speech and safety triggers continue while the dashboard displays snapshots. Muting live playback does not stop listening.' },
    { selector: '#tour-alert-log', title: 'Safety alerts', placement: 'left', body: 'Urgent safety triggers appear here. Each card’s Events button opens detailed alerts and history on the Cameras page.' },
    { selector: '#tour-start', title: 'Monitoring controls', placement: 'left', body: 'Use Start and Stop to control monitoring. Live video plays only on the Cameras page.' },
  ];
  useEffect(() => {
    if (authLoading || liveView) return;
    const key = user ? `msds-tutorial-done-${user.id}` : 'msds-tutorial-done-guest';
    if (localStorage.getItem(key)) return;
    const timeout = window.setTimeout(() => setShowTutorial(true), 600);
    return () => window.clearTimeout(timeout);
  }, [authLoading, liveView, user]);

  const openAlgorithmTutorial = (algorithm: AlgorithmId) => {
    setShowExpert(false); setTutorialOverride(ALGORITHM_TOURS[algorithm]); setShowTutorial(true);
  };

  return (
    <>
      {slots.map(slot => <CameraMonitor key={slot.index} slot={slot} monitoring={running} baseSettings={pipelineSettings}
        localStream={slot.connected ? undefined : cameras[slot.index - 1]?.stream || undefined}
        playbackEnabled={liveView && (!focusedLiveCamera || focusedLiveCamera === `slot-${slot.index}`)}
        onEvent={handleEvent} onMetrics={handleMetrics} />)}
      {liveView && <Monitoring />}
      {!liveView && <div className="min-h-screen bg-background text-foreground">
        <header id="tour-header" className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/60 px-4 py-3">
          <button onClick={() => navigate('/')} className="flex items-center gap-2"><Shield className="h-6 w-6 text-primary" /><h1 className="text-lg font-bold">MSDSystem</h1></button>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-3 py-1.5 text-sm ${running ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>{running ? 'Monitoring' : 'Standby'}</span>
            <button onClick={() => navigate('/household')} className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-sm text-primary"><Home className="h-4 w-4" /><span className="hidden sm:inline">Home</span></button>
            <button onClick={() => navigate('/cameras')} className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-sm text-primary"><Wifi className="h-4 w-4" /><span>Cameras</span></button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowExpert(true)} title="Expert Mode" className="flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-sm text-accent"><Sparkles className="h-4 w-4" /><span className="hidden sm:inline">Expert</span></button>
            <button onClick={() => setDarkMode(value => !value)} title={darkMode ? 'Light mode' : 'Dark mode'} className="rounded-lg p-2 hover:bg-muted">{darkMode ? <Sun className="h-5 w-5 text-warning" /> : <Moon className="h-5 w-5" />}</button>
            <AccessibilityPanel />
            <button onClick={() => { setTutorialOverride(null); setShowTutorial(true); }} title="Replay tutorial" className="rounded-lg p-2 hover:bg-muted"><HelpCircle className="h-5 w-5" /></button>
            <span className="hidden max-w-40 truncate text-sm text-muted-foreground sm:inline">{user?.email}</span>
            <button onClick={signOut} title="Sign Out" className="rounded-lg p-2 hover:bg-muted"><LogOut className="h-5 w-5" /></button>
            <button onClick={() => setSidebarOpen(true)} aria-label="Open controls" className="rounded-lg p-2 hover:bg-muted lg:hidden"><Menu className="h-5 w-5" /></button>
          </div>
        </header>

        <main className="flex min-h-[calc(100vh-65px)] flex-col lg:h-[calc(100vh-65px)] lg:flex-row">
          <div className="min-w-0 flex-1 space-y-4 p-3 lg:overflow-y-auto">
            <div className="flex flex-wrap items-end justify-between gap-3 py-2">
              <div><h2 className="text-2xl font-bold tracking-tight">Dashboard</h2><p className="mt-1 text-sm text-muted-foreground">Last-seen images. Open a camera for realtime video.</p></div>
              <button onClick={() => openConnection(1)} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Manage cameras</button>
            </div>
            <div id="tour-cams"><div id="tour-fused-view" className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {slots.map(slot => <DashboardCameraCard key={slot.index} slot={slot} monitoring={running} mirror={mirror}
                transcript={slot.index === 1 && localAudioEnabled ? speech.transcript : undefined}
                eventCount={eventCounts.get(`slot-${slot.index}`) || 0} onConnect={openConnection}
                onToggleAi={index => updateSlot(index, { aiEnabled: !slots[index - 1].aiEnabled })} />)}
            </div></div>

            <section id="tour-saliency-score" className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm font-semibold">Detection summary
                  <select aria-label="Choose detection summary camera" value={selectedCamera} onChange={event => setSelectedCamera(Number(event.target.value))} className="rounded-lg border border-border bg-background px-2 py-1">
                    {slots.map(slot => <option key={slot.index} value={slot.index}>{slot.name}</option>)}
                  </select>
                </label>
                <span className={`text-xl font-bold tabular-nums ${saliency > 70 ? 'text-destructive' : 'text-primary'}`}>Saliency {saliency}%</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div id="tour-fire-analysis" className={`rounded-lg border p-3 ${currentRuntime?.fire.detected || currentRuntime?.smoke.detected ? 'border-destructive/50 bg-destructive/5' : 'border-border'}`}>
                  <h3 className="flex items-center gap-2 text-sm"><Flame className="h-4 w-4" />Fire &amp; smoke</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{currentRuntime?.fire.detected ? currentRuntime.fireAnalysis?.largeFire ? 'Large fire detected' : 'Fire detected'
                    : currentRuntime?.smoke.detected ? 'Smoke / low visibility detected'
                    : currentRuntime?.fire.classification === 'electronics-with-fire' ? 'Electronics with fire: display footage excluded'
                    : 'No fire or smoke detected'}</p>
                  {currentRuntime?.fireAnalysis && <p className="mt-1 text-xs text-muted-foreground">Visibility {currentRuntime.fireAnalysis.visibility}/100 · Smoke-colored area {Math.round(currentRuntime.fireAnalysis.smokeRatio * 100)}%</p>}
                  {currentRuntime?.fire.detected && <DetectionFeedback householdId={householdId} eventType="fire" confidence={currentRuntime.fire.confidence} />}
                </div>
                <div id="tour-audio-distress" className="rounded-lg border border-border p-3">
                  <h3 className="flex items-center gap-2 text-sm"><Mic className="h-4 w-4" />Audio &amp; safety phrases</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{selectedCamera === 1 && localAudioEnabled ? (yamnet.error || `${yamnet.topLabel} (${yamnet.distressScore}% distress)`) : currentRuntime?.audioDistress.detected ? currentRuntime.audioDistress.keyword || 'Safety phrase detected' : currentRuntime?.audioMessage || 'Connect a camera to start listening.'}</p>
                </div>
                <div id="tour-face-distress" className="rounded-lg border border-border p-3">
                  <h3 className="text-sm">Facial distress</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{currentRuntime?.faceDistress.detected ? `${currentRuntime.faceDistress.label} (${Math.round(currentRuntime.faceDistress.confidence * 100)}%)` : 'No facial distress detected'}</p>
                </div>
              </div>
            </section>
            {cameraError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{cameraError}</p>}
          </div>

          {sidebarOpen && <button aria-label="Close controls overlay" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-40 bg-black/40 lg:hidden" />}
          <aside id="tour-sidebar" aria-label="Camera controls and activity sidebar" className={`${sidebarOpen ? 'fixed right-0 top-0 z-50 h-full w-80 max-w-[90vw]' : 'relative w-full'} min-w-0 space-y-3 overflow-y-auto border-t border-border bg-card p-3 lg:static lg:z-auto lg:h-auto lg:w-[360px] lg:max-w-none lg:shrink-0 lg:border-l lg:border-t-0 lg:bg-transparent`}>
            {sidebarOpen && <button onClick={() => setSidebarOpen(false)} aria-label="Close controls" className="ml-auto block rounded-lg p-2 lg:hidden"><X className="h-4 w-4" /></button>}
            <div id="tour-start" className="rounded-xl border border-border bg-card p-3">
              <button onClick={running ? handleStop : handleStart} className={`w-full rounded-lg px-3 py-2.5 text-sm ${running ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'}`}>{running ? 'Stop Monitoring' : 'Start Monitoring'}</button>
              <p className="mt-2 text-center text-sm text-muted-foreground">{running ? 'Snapshot detection and audio triggers are active.' : 'Connect a camera, then start monitoring.'}</p>
            </div>
            <AttentionGauge score={attention} />
            <div id="tour-alert-log"><DashboardEvents syncUrl={false} showAlerts={showAlerts} /></div>
            <ControlsPanel snapshotMode running={running} threshold={settings.saliencyThreshold ?? 40} showBoundingBoxes={showBoundingBoxes} showHeatmap={showHeatmap} showAlerts={showAlerts}
              quality={quality} mirror={mirror} heatmapOpacity={heatmapOpacity} simulationMode={simulationMode} priorityObjects={priorityObjects} minConfidence={Math.round(settings.objectThreshold * 100)}
              onStart={handleStart} onStop={handleStop} onThresholdChange={value => updateSettings({ saliencyThreshold: value })} onToggleBoundingBoxes={() => setShowBoundingBoxes(value => !value)}
              onToggleHeatmap={() => setShowHeatmap(value => !value)} onToggleAlerts={() => setShowAlerts(value => !value)} onQualityChange={setQuality}
              onToggleMirror={() => setMirror(value => !value)} onHeatmapOpacityChange={setHeatmapOpacity} onToggleSimulation={() => setSimulationMode(value => !value)}
              onPriorityObjectsChange={setPriorityObjects} onMinConfidenceChange={value => updateSettings({ objectThreshold: value / 100 })} onExportCSV={exportCSV} />
            <PerformanceMonitor runtime={currentRuntime} />
          </aside>
        </main>
      </div>}

      {!liveView && showIpDialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={closeConnection}>
        <div role="dialog" aria-modal="true" aria-labelledby="camera-connect-title" className="max-h-[92vh] w-full max-w-5xl space-y-5 overflow-y-auto rounded-xl border border-border bg-card p-6" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3"><h3 id="camera-connect-title" className="flex items-center gap-2 text-xl"><Wifi className="h-5 w-5 text-primary" />Connect CCTV / IP Camera</h3><button onClick={closeConnection} aria-label="Close camera connection panel" className="rounded-lg p-2 hover:bg-muted"><X className="h-5 w-5" /></button></div>
          <MultiCameraConnect selectedSlot={selectedCamera} />
          <p className="text-sm text-muted-foreground">Open a connected camera on the Cameras page to view realtime video.</p>
          {devices.length > 0 && <p className="text-sm text-muted-foreground">{devices.length} local webcam{devices.length === 1 ? '' : 's'} available through Start Monitoring.</p>}
          <button onClick={closeConnection} className="w-full rounded-lg border border-border px-4 py-2 hover:bg-muted">Close</button>
        </div>
      </div>}

      {showEmergency && <div className="fixed bottom-4 right-4 z-[60] w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-destructive bg-destructive p-4 text-destructive-foreground shadow-xl">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm">EMERGENCY DETECTED</h3><button onClick={() => setShowEmergency(false)} aria-label="Close emergency alert"><X className="h-5 w-5" /></button></div>
        <p className="text-sm">A camera safety trigger needs your attention.</p>
        <a href="tel:911" className="block rounded-lg bg-background px-4 py-2.5 text-center text-sm font-bold text-destructive">CALL 911</a>
        <button onClick={() => setShowEmergency(false)} className="w-full text-sm">Dismiss (false alarm)</button>
      </div>}
      <TutorialOverlay steps={tutorialOverride || tutorialSteps} open={!liveView && showTutorial} onClose={() => { setShowTutorial(false); setTutorialOverride(null); }} onFinish={() => localStorage.setItem(user ? `msds-tutorial-done-${user.id}` : 'msds-tutorial-done-guest', '1')} />
      <ExpertMode open={!liveView && showExpert} onClose={() => setShowExpert(false)} onSelectAlgorithm={openAlgorithmTutorial}
        runtime={currentRuntime} settings={pipelineSettings} cameraLabel={slots[selectedCamera - 1]?.name}
        attentionScore={attention} audioDistressScore={localAudioEnabled ? yamnet.distressScore : undefined} />
    </>
  );
}
