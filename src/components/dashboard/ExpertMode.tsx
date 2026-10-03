import { BrainCircuit, ChevronRight, Flame, ScanSearch, ShieldAlert, Sparkles, Volume2, Workflow, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccessibleDialog } from '@/hooks/useAccessibleDialog';
import { FIRE_RULES } from '@/lib/fireDetection';
import { SAFETY_LEXICON_SIZE, SAFETY_WAKE_WORD_COUNT } from '@/lib/safetyLexicon';
import type { CameraRuntime, MultiCamSettings } from '@/types/multicam';
import { DEFAULT_SETTINGS } from '@/types/multicam';

export type AlgorithmId = 'vision' | 'fire' | 'face' | 'speech' | 'audio' | 'hybrid';

interface AlgorithmDetails {
  id: AlgorithmId;
  name: string;
  file: string;
  summary: string;
  icon: typeof Workflow;
  steps: string[];
  calculations: string;
  decision: string;
  example: string;
  limitation: string;
}

interface ExpertModeProps {
  open: boolean;
  onClose: () => void;
  onSelectAlgorithm: (id: AlgorithmId) => void;
  runtime?: CameraRuntime;
  settings?: MultiCamSettings;
  cameraLabel?: string;
  attentionScore?: number;
  /** Present only for the dashboard's local-microphone YAMNet branch. */
  audioDistressScore?: number;
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const fixed = (value: number) => value.toFixed(1);

function algorithms(settings: MultiCamSettings): AlgorithmDetails[] {
  return [
    {
      id: 'vision', name: 'Visual saliency and object detection', icon: ScanSearch,
      file: 'src/lib/saliency.ts · src/lib/detectionEngine.ts · src/hooks/useCameraPipeline.ts',
      summary: 'Computes frame structure immediately, while COCO-SSD identifies objects in an independent inference job.',
      steps: [
        'Resize analysis frames to at most 320 pixels wide, keeping their aspect ratio. This bounds pixel-processing work independently of playback resolution.',
        'Convert RGB to grayscale. The active camera pipeline uses Sobel gradients; the library also supports frame difference and Laplacian edges.',
        `Discard gradients at or below the configured threshold (${settings.saliencyThreshold ?? 40}), clamp remaining intensity to 255 and average the intensity over every pixel.`,
        `COCO-SSD with MobileNet v2 returns up to 20 object boxes with confidence at least ${percent(settings.objectThreshold)}. The object contribution is the maximum surviving confidence, multiplied by 100.`,
      ],
      calculations: `gray = 0.299R + 0.587G + 0.114B\nSobel Gx = [-1 0 1; -2 0 2; -1 0 1] * gray\nSobel Gy = [-1 -2 -1; 0 0 0; 1 2 1] * gray\nmagnitude = sqrt(Gx² + Gy²)\nintensity = magnitude > threshold ? min(255, magnitude) : 0\nvisualScore = min(100, round(100 × mean(intensity) / 255))\n\nmotion intensity = |grayNow − grayPrevious| > threshold\n  ? min(255, 2 × |grayNow − grayPrevious|) : 0\nLaplacian = up + down + left + right − 4 × center\nLaplacian intensity = |Laplacian| > threshold ? min(255, 2 × |Laplacian|) : 0`,
      decision: 'Visual saliency above 70 creates a visual activity event. Ordinary objects, people and visual activity alone do not establish an emergency.',
      example: 'Mean retained intensity 102 gives round(102 / 255 × 100) = 40. An object confidence of 0.80 contributes an object score of 80.',
      limitation: 'Strong edges can come from furniture, shadows or camera movement. COCO confidence is a model estimate, and a high object score describes recognition rather than danger.',
    },
    {
      id: 'fire', name: 'Fire, smoke and visibility', icon: Flame,
      file: 'src/lib/fireDetection.ts · src/hooks/useCameraPipeline.ts',
      summary: 'Evaluates flame motion and smoke outside detected digital displays, then exposes each score and rejection reason.',
      steps: [
        `Sample every ${FIRE_RULES.sampleStep} pixels horizontally and vertically. Detect TV, phone, laptop, monitor, tablet and television boxes with confidence at least ${percent(FIRE_RULES.screenConfidence)} and mask only their pixels. Ratios use the full-frame sample count.`,
        'Classify a sample as flame when R > 200, 100 < G < 200, B < 100, R > G + 40 and G > B + 20. Classify smoke-like samples by low saturation, gray color and medium brightness.',
        'Measure luminance contrast, horizontal edges and mean saturation outside screens. Compare flame coverage over up to 10 frames and smoke/visibility over up to 12 frames.',
        'Measure both changing flame coverage and per-pixel luminance changes. Smooth the overlay box with 35% current measurement and 65% previous box; hold it for up to 6 missing measurements.',
      ],
      calculations: `L = (0.299R + 0.587G + 0.114B) / 255\nS = max(R,G,B) = 0 ? 0 : (max(R,G,B) − min(R,G,B)) / max(R,G,B)\nsmoke-like = S < 0.18 AND 0.30 < L < 0.88 AND max(R,G,B) − min(R,G,B) < 30\ncontrast = sqrt(mean(L²) − mean(L)²)\nedges = fraction of sampled horizontal neighbors where |ΔL| > 0.08\nvisibility = clamp(round(45 × contrast/0.25 + 30 × edges/0.20 + 25 × mean(S)/0.35), 0, 100)\nflicker = max(variance(recent flame ratios), (sum(flame-pixel |ΔL|) / total samples)²)\n\nfire points = min(40, flameRatio/0.05 × 40)\nflicker points = min(25, flicker × 25000000)\nsmoke points = min(20, smokeRatio/0.18 × 20)\nvisibility-loss points = min(15, (100 − visibility)/100 × 15)\nfire saliency = max(0, round(sum(points) − suppression))\n\nconfidence = min(1, flameRatio × 30 + min(0.5, flicker × 50000))\nif smokeRatio > 0.08: confidence = min(1, confidence + 0.15)\nif visibility < 60: confidence = min(1, confidence + 0.10)`,
      decision: `A flame candidate needs at least ${percent(FIRE_RULES.minFireRatio)} coverage and two observations. Ordinary flames need flicker ≥ ${FIRE_RULES.minFlicker}, a box covering ≥ 0.2%, and confidence > 0.3; the camera alert additionally requires confidence ≥ ${percent(settings.fireThreshold)}. Large flames (≥ ${percent(FIRE_RULES.largeFireRatio)}) with smoke ≥ ${percent(FIRE_RULES.smokeWithFire)} or visibility ≤ ${FIRE_RULES.visibilityLow} bypass static/planar rejection after two observations. Smoke-only requires coverage ≥ ${percent(FIRE_RULES.smokeCoverageHigh)}, visibility ≤ ${FIRE_RULES.visibilityLow}, and rising coverage (> 5 percentage points), a visibility drop (> 15 points), or smoke-pixel luminance movement > 0.01 after three observations. Display-only flame footage returns false with “electronics-with-fire”; real hazards outside the display remain eligible.`,
      example: 'Flame ratio 0.02, flicker 0.000004, smoke ratio 0.10 and visibility 40 give min(1, 0.60 + 0.20 + 0.15 + 0.10) = 1.00 confidence. Rejection checks still run before an alert.',
      limitation: 'RGB, motion and visibility are heuristics. Gray walls, haze, reflections, unusual fire colors and missed display boxes can cause errors. Low visibility alone is insufficient. The reported score is not a calibrated probability of fire.',
    },
    {
      id: 'face', name: 'Facial expression distress', icon: BrainCircuit,
      file: 'src/hooks/useFaceDistress.ts · src/hooks/useCameraPipeline.ts',
      summary: 'Selects the largest face, runs its expression model once, and averages three observations.',
      steps: [
        'Load the tiny face detector and expression network in parallel. Detect faces on a stable copy of the frame with a 224-pixel model input and score threshold 0.50.',
        'Choose the face with the largest bounding-box area, crop that face and run the expression network only on that crop.',
        'Weight sad, fearful, angry and disgusted model outputs; clamp the resulting instant score and average the latest three samples. Clear the history when no face is found.',
        'Report the highest-probability expression separately from distress. The visible distress confidence is the smoothed score divided by 100.',
      ],
      calculations: 'raw = 1.0 × sad + 1.4 × fearful + 0.8 × angry + 0.7 × disgusted\ninstant = min(100, round(raw × 100))\nscore = round(mean(latest up to 3 instant scores))\nlevel = score > 55 ? severe : score > 25 ? mild : none\nreported distress confidence = score / 100',
      decision: 'A severe score (> 55) emits a facial distress event. Mild expression scores do not independently trigger the emergency recording.',
      example: 'sad = 0.20, fearful = 0.30, angry = 0.10, disgusted = 0.05 produce raw = 0.735 and instant = 74. Samples 50, 60 and 74 average to 61, which is severe.',
      limitation: 'This estimates expressions; it does not identify a person or establish their emotional or medical condition. Lighting, pose and obscured faces affect results. Only the largest visible face contributes.',
    },
    {
      id: 'speech', name: 'Original transcription and safety phrases', icon: ShieldAlert,
      file: 'local-server/msds/camera.py · local-server/msds/whisper_engine.py · src/lib/safetyLexicon.ts',
      summary: 'Shows finalized speech in the spoken language and checks those words for safety phrases.',
      steps: [
        'Capture the camera RTSP audio through FFmpeg as 16 kHz, mono, 16-bit PCM. Voice activity separates speech from silence.',
        'Collect one utterance until 0.6 seconds of quiet or a maximum 6-second context window, both configurable. Submit only finalized audio; draft transcription jobs are disabled. The current utterance replaces earlier text and clears after 5 seconds.',
        'The default multilingual small Whisper model transcribes without translating. Detect the spoken language automatically or use the configured language. Decode with beam size 5, Silero voice activity filtering, word timestamps and hallucination silence checks. Reject weak, non-speech and implausibly fast repetition results; preserve credible spoken repetitions.',
        `Normalize text to lowercase, remove diacritics and punctuation, normalize “wag” to “huwag”, and match whole phrases. ${SAFETY_LEXICON_SIZE} lexicon entries include ${SAFETY_WAKE_WORD_COUNT} urgent entries. Critical phrases outrank high-severity phrases; ties use the lexicon confidence.`,
      ],
      calculations: `PCM bytes per second = 16000 samples × 1 channel × 2 bytes = 32000\nnormalized audio RMS = sqrt(mean(PCM sample²)) / 32768\nsegmentation speech gate = RMS ≥ 0.001\nWhisper VAD: threshold 0.5, speech ≥ 100 ms, silence ≥ 200 ms, padding 150 ms\nfinal segment accepted = no_speech_prob ≤ 0.85 AND avg_logprob ≥ −1.0\ncompressed loops rejected = compression > 2.4 AND ≥ 12 words AND rate > 8 words/second\nnormalized = lowercase → NFKD → remove marks/punctuation → collapse spaces\nmatch = normalized transcript contains a complete normalized safety phrase\nurgent = severity is high OR critical\nconfidence = max(backend keyword confidence, matched lexicon confidence)\nalert allowed = finalized phrase exists AND confidence ≥ ${settings.audioThreshold.toFixed(2)}`,
      decision: 'Only finalized transcription is displayed and checked for alerts. Final English or Tagalog safety phrases can create a speech distress alert once the confidence threshold and event cooldown pass.',
      example: 'The finalized words “please help me” appear as spoken and match a critical lexicon phrase with confidence 0.98. They replace the previous utterance instead of being appended to it.',
      limitation: 'No recognizer can guarantee 100% accuracy or subsecond finalized speech on every device. Capture time, model work, queued jobs and network delivery contribute to delay. The displayed measured transcription time covers queue/model work after audio submission, rather than the entire audio-to-screen journey. Phrase confidence comes from the safety lexicon and is not word accuracy.',
    },
    {
      id: 'audio', name: 'Sound distress classifier', icon: Volume2,
      file: 'src/hooks/useYamnet.ts',
      summary: 'Classifies the local microphone’s sound using YAMNet and subtracts competing non-distress classes.',
      steps: [
        'Resample microphone audio to 16 kHz. Use 15,600 samples (0.975 seconds), retaining roughly half-window overlap for the next analysis.',
        'Compute root mean square amplitude; skip the classifier when RMS < 0.004. Average YAMNet score rows across the window’s patches.',
        'Add weighted distress classes: shout 0.85, bellow 0.75, whoop 0.40, yell 0.85, children shouting 0.55, screaming 1.00, crying 0.90, baby cry 0.90, wail/moan 0.85, sigh 0.10 and groan 0.60.',
        'Subtract half the sum of non-distress class scores (whispering, laughter/giggles, cheering and selected music classes), then clamp the final score to 0–100.',
      ],
      calculations: 'window duration = 15600 / 16000 = 0.975 seconds\nRMS = sqrt(mean(sample²))\npositive = Σ(mean class score × distress weight)\nnegative = Σ(mean non-distress class score)\ndistress = clamp(round(100 × (positive − 0.5 × negative)), 0, 100)',
      decision: 'The local dashboard uses this score as its audio attention contribution. CCTV audio uses its own finalized safety phrase confidence rather than this local microphone classifier.',
      example: 'A scream score of 0.60 and laughter score of 0.20, with other relevant classes zero, give round(100 × (0.60 − 0.50 × 0.20)) = 50.',
      limitation: 'The analysis window alone is almost a second. TV audio, music and ordinary shouting can resemble distress. YAMNet’s output is a sound classification estimate rather than an emergency diagnosis.',
    },
    {
      id: 'hybrid', name: 'Multimodal attention and alert decisions', icon: Workflow,
      file: 'src/pages/Index.tsx · src/hooks/useCameraPipeline.ts · src/hooks/useCameraRegistry.ts',
      summary: 'Explains both attention formulas and the independent emergency decisions that can start recording.',
      steps: [
        'Visual analysis runs independently from object and face inference. The newest available results are combined without waiting for every model to finish.',
        'The CCTV camera pipeline weights visual saliency 50%, objects 30% and active safety speech 20%. The local microphone dashboard branch weights visual saliency 40%, objects 30% and YAMNet sound distress 30%.',
        'Fire, smoke, severe face distress and urgent finalized speech can independently create an emergency event. Attention above 70 creates an activity event; attention alone does not prove an emergency.',
        'Apply per-source event cooldowns, timestamp the event and start a 10-second clip. Save automatically to the preselected recording folder; without one, report “No folder to save record.” Alert history clears in batches of 50.',
      ],
      calculations: 'objectScore = max(0, all detected object confidences × 100)\nCCTV audioScore = safety speech detected ? confidence × 100 : 0\nCCTV attention = min(100, round(0.50 × visual + 0.30 × objectScore + 0.20 × audioScore))\nlocal attention = round(0.40 × visual + 0.30 × objectScore + 0.30 × YAMNet distress)\nactivity event = visual > 70 OR attention > 70\nemergency event = confirmed fire OR smoke emergency OR severe face distress OR urgent final speech',
      decision: 'Emergency detectors retain their own rules and thresholds. A weighted attention value does not veto a confirmed emergency, and an ordinary recognized object does not independently start recording.',
      example: 'Visual 40, objects 80 and audio distress 50 give CCTV attention = round(20 + 24 + 10) = 54; local microphone attention = round(16 + 24 + 15) = 55.',
      limitation: 'Components are estimates with different update times. Shared CPU/GPU limits, missing audio, network delay and camera frame rate affect freshness. Monitoring still requires human review of the evidence.',
    },
  ];
}

function RuntimeValues({ algorithm, runtime, attentionScore, audioDistressScore }: Pick<ExpertModeProps, 'runtime' | 'attentionScore' | 'audioDistressScore'> & { algorithm: AlgorithmId }) {
  if (!runtime) return <p className="text-sm text-muted-foreground">Connect a camera to inspect its live inputs and calculated result.</p>;
  const fire = runtime.fireAnalysis;
  const objects = Math.max(0, ...runtime.objects.map(object => object.confidence * 100));
  const audio = audioDistressScore ?? (runtime.audioDistress.detected ? runtime.audioDistress.confidence * 100 : 0);
  const local = audioDistressScore !== undefined;
  const visualWeight = local ? 0.4 : 0.5;
  const audioWeight = local ? 0.3 : 0.2;
  const attentionCalculation = Math.min(100, Math.round(runtime.saliencyScore * visualWeight + objects * 0.3 + audio * audioWeight));
  let values: [string, string][] = [];
  if (algorithm === 'vision') values = [
    ['Analysis dimensions', `${runtime.frameWidth ?? '—'} × ${runtime.frameHeight ?? '—'} pixels`],
    ['Visual saliency', `${runtime.saliencyScore}/100`], ['Object count', String(runtime.objects.length)],
    ['Strongest object confidence', `${fixed(objects)}/100`], ['Visual processing time', `${runtime.latencyMs} ms`],
  ];
  if (algorithm === 'fire') values = fire ? [
    ['Classification', fire.classification], ['Flame coverage outside displays', percent(fire.firePixelRatio)],
    ['Display flame coverage excluded', percent(fire.screenFireRatio)], ['Smoke-like coverage', percent(fire.smokeRatio)],
    ['Visibility', `${fire.visibility}/100`], ['Flicker', fire.flickerScore.toExponential(4)],
    ['Contrast / edge density / saturation', `${fire.contrast.toFixed(4)} / ${fire.edgeDensity.toFixed(4)} / ${fire.saturation.toFixed(4)}`],
    ['Confidence', percent(fire.confidence)], ['Fire / smoke decisions', `${fire.fireDetected ? 'true' : 'false'} / ${fire.smokeEmergency ? 'true' : 'false'}`],
    ['Rejection reason', fire.rejectedReason || 'None'],
    ['Saliency calculation', `${fixed(fire.saliency.fireColor)} + ${fixed(fire.saliency.flicker)} + ${fixed(fire.saliency.smoke)} + ${fixed(fire.saliency.visibility)} ${fire.saliency.screenSuppression < 0 ? `− ${fixed(-fire.saliency.screenSuppression)}` : ''} ${fire.saliency.otherSuppression < 0 ? `− ${fixed(-fire.saliency.otherSuppression)}` : ''} → ${fire.saliency.total}/100`],
  ] : [['Fire analysis', 'Waiting for a sampled frame']];
  if (algorithm === 'face') values = [
    ['Reported expression', runtime.faceDistress.label || 'No expression reported'],
    ['Smoothed distress score', `${fixed(runtime.faceDistress.confidence * 100)}/100`],
    ['Severe distress decision', String(runtime.faceDistress.detected)],
  ];
  if (algorithm === 'speech') values = [
    ['Whisper model', runtime.audio?.whisper_model || 'Not reported'],
    ['Transcription mode', 'Finalized utterances only'],
    ['Silence boundary', runtime.audio?.caption_silence_seconds != null ? `${runtime.audio.caption_silence_seconds} seconds` : 'Not reported'],
    ['Maximum audio window', runtime.audio?.chunk_seconds != null ? `${runtime.audio.chunk_seconds} seconds` : 'Not reported'],
    ['Measured queue and model time', runtime.audio?.transcription_latency_ms != null ? `${Math.round(runtime.audio.transcription_latency_ms)} ms` : 'No completed measurement'],
    ['Final transcript', runtime.transcript || 'None'],
    ['Matched safety phrase', runtime.audioDistress.keyword || 'None'], ['Safety confidence', percent(runtime.audioDistress.confidence)],
  ];
  if (algorithm === 'audio') values = [
    ['Source for this camera', local ? 'Local microphone (YAMNet)' : 'CCTV finalized speech (separate classifier)'],
    ['Available audio distress contribution', `${fixed(audio)}/100`],
  ];
  if (algorithm === 'hybrid') values = [
    ['Active attention formula', local ? '40% visual + 30% objects + 30% YAMNet' : '50% visual + 30% objects + 20% CCTV speech'],
    ['Live substitution', `${visualWeight} × ${runtime.saliencyScore} + 0.3 × ${fixed(objects)} + ${audioWeight} × ${fixed(audio)} = ${attentionCalculation}`],
    ['Published attention', `${attentionScore ?? runtime.attentionScore}/100`],
    ['Emergency flags: fire / smoke / face / speech', [runtime.fire.detected, runtime.smoke.detected, runtime.faceDistress.detected, runtime.audioDistress.detected].map(String).join(' / ')],
    ['Last analysis timestamp', runtime.lastDetectionAt || 'Not available'],
  ];
  return <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
    {values.map(([label, value]) => <div key={label} className="contents">
      <dt className="font-semibold text-muted-foreground">{label}</dt>
      <dd className="break-words font-mono text-foreground">{value}</dd>
    </div>)}
  </dl>;
}

export default function ExpertMode({ open, onClose, onSelectAlgorithm, runtime, settings = DEFAULT_SETTINGS, cameraLabel, attentionScore, audioDistressScore }: ExpertModeProps) {
  const dialogRef = useAccessibleDialog(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/85 p-3 backdrop-blur-sm" onClick={onClose}>
      <section ref={node => { dialogRef.current = node; }} role="dialog" aria-modal="true" aria-labelledby="expert-mode-title" aria-describedby="expert-mode-description" tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-primary/40 bg-background shadow-2xl" onClick={event => event.stopPropagation()}>
        <header className="flex items-start justify-between gap-4 border-b border-border bg-card p-5">
          <div>
            <h2 id="expert-mode-title" className="flex items-center gap-2 text-2xl font-bold text-foreground"><Workflow aria-hidden="true" className="h-6 w-6 text-primary" />Expert Mode <Sparkles aria-hidden="true" className="h-5 w-5 text-primary" /></h2>
            <p id="expert-mode-description" className="mt-1 text-base text-muted-foreground">Inspect the implemented steps, exact calculations, decision thresholds and live inputs. Open a dashboard guide for any algorithm.</p>
            <p className="mt-2 text-sm font-semibold text-primary">{runtime ? `${cameraLabel || runtime.cameraId} · ${runtime.status} · ${runtime.fps} FPS` : 'No selected camera runtime available'}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close Expert Mode"><X aria-hidden="true" className="h-5 w-5" /></Button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {algorithms(settings).map(algorithm => {
            const Icon = algorithm.icon;
            return <details key={algorithm.id} open={algorithm.id === 'hybrid'} className="rounded-lg border border-border bg-card p-4">
              <summary className="cursor-pointer text-lg font-bold text-foreground">
                <span className="ml-2 inline-flex items-center gap-2"><Icon aria-hidden="true" className="h-5 w-5 text-primary" />{algorithm.name}</span>
              </summary>
              <div className="mt-4 space-y-4">
                <p className="text-sm leading-relaxed text-muted-foreground">{algorithm.summary}</p>
                <code className="block break-all text-xs text-primary">{algorithm.file}</code>
                <section aria-label={`${algorithm.name} implementation steps`}>
                  <h3 className="mb-2 font-bold">Implementation steps</h3>
                  <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">{algorithm.steps.map(step => <li key={step}>{step}</li>)}</ol>
                </section>
                <section aria-label={`${algorithm.name} calculations`}>
                  <h3 className="mb-2 font-bold">Calculations</h3>
                  <pre tabIndex={0} aria-label={`${algorithm.name} formulas`} className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 text-xs leading-relaxed"><code>{algorithm.calculations}</code></pre>
                  <p className="mt-2 text-sm leading-relaxed"><strong>Worked example: </strong>{algorithm.example}</p>
                </section>
                <section aria-label={`${algorithm.name} decisions`}><h3 className="mb-2 font-bold">Decision rules</h3><p className="text-sm leading-relaxed">{algorithm.decision}</p></section>
                <section aria-label={`${algorithm.name} live values`}><h3 className="mb-2 font-bold">Current camera values</h3><RuntimeValues algorithm={algorithm.id} runtime={runtime} attentionScore={attentionScore} audioDistressScore={audioDistressScore} /></section>
                <p className="rounded-md border border-border bg-background p-3 text-sm leading-relaxed text-muted-foreground"><strong>Interpretation: </strong>{algorithm.limitation}</p>
                <Button type="button" variant="outline" onClick={() => onSelectAlgorithm(algorithm.id)}><ChevronRight aria-hidden="true" className="h-4 w-4" />Open {algorithm.id === 'hybrid' ? 'multimodal' : algorithm.id} dashboard guide</Button>
              </div>
            </details>;
          })}
        </div>
      </section>
    </div>
  );
}
