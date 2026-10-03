import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveCameraFeed from '@/components/multicam/LiveCameraFeed';
import CameraTile from '@/components/multicam/CameraTile';
import TranscriptionBox from '@/components/multicam/TranscriptionBox';
import DashboardCameraCard from '@/components/dashboard/DashboardCameraCard';
import FusedDetectionView from '@/components/dashboard/FusedDetectionView';
import { SlotPipelineView } from '@/components/dashboard/CameraSlotSelector';
import { DEFAULT_SETTINGS, type CameraRuntime } from '@/types/multicam';
import { makeSlot, slotCamera } from '@/hooks/useCameraSlots';

const mocks = vi.hoisted(() => ({ runtime: null as CameraRuntime | null }));
vi.mock('@/lib/cameraSessions', () => ({
  useCameraSession: () => ({ video: null, home: null, runtime: mocks.runtime, preview: null, previewTimestamp: null, reconnect: null }),
}));
vi.mock('@/hooks/useCameraPipeline', () => ({
  useCameraPipeline: () => ({ videoRef: { current: null }, runtime: mocks.runtime, reconnect: vi.fn() }),
}));
vi.mock('@/hooks/useCctvTalk', () => ({
  useCctvTalk: () => ({ talking: false, error: null, startTalk: vi.fn(), stopTalk: vi.fn() }),
}));

const slot = { ...makeSlot(1), ip: '192.168.1.2', connected: true };
const audioFeatures = { decibel: -60, speechDetected: false, pitchEstimate: 0, waveform: [], audioEvent: 'none' as const };

beforeEach(() => {
  mocks.runtime = {
    cameraId: 'slot-1', status: 'online', error: null, fps: 8, latencyMs: 10,
    saliencyScore: 0, attentionScore: 0, objects: [], humanCount: 0,
    fire: { detected: false, confidence: 0 }, smoke: { detected: false, confidence: 0 },
    faceDistress: { detected: false, label: '', confidence: 0 },
    audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' },
    transcript: 'Kumusta, magandang umaga.', interimTranscript: 'Unfinished guess',
    audioListening: true, audio: null, audioMessage: 'Listening for speech.', audioTone: 'ok',
    audioBackendReachable: true, lastDetectionAt: null, detections: 0, alerts: 0,
  };
});
afterEach(cleanup);

describe('finalized camera transcription display', () => {
  const views = [
    ['live camera', () => <LiveCameraFeed camera={slotCamera(slot)} settings={DEFAULT_SETTINGS} onConnect={vi.fn()} />],
    ['camera tile', () => <CameraTile camera={slotCamera(slot)} settings={DEFAULT_SETTINGS} onEvent={vi.fn()} />],
    ['dashboard card', () => <MemoryRouter><DashboardCameraCard slot={slot} monitoring eventCount={0} onConnect={vi.fn()} onToggleAi={vi.fn()} /></MemoryRouter>],
    ['slot pipeline', () => <SlotPipelineView slot={slot} monitoring visible />],
    ['fused camera', () => <FusedDetectionView sourceCanvas={null} objects={[]} audioFeatures={audioFeatures} attentionScore={0} saliencyScore={0} active={false} transcript={mocks.runtime!.transcript} interimTranscript={mocks.runtime!.interimTranscript!} speechListening onToggleSpeech={vi.fn()} />],
  ] as const;

  it.each(views)('keeps final speech below the %s video and hides draft guesses', (_name, cameraView) => {
    const view = render(cameraView());
    const words = screen.getByRole('region', { name: 'Transcription for Camera 1' });
    expect(words).toHaveTextContent('Kumusta, magandang umaga.');
    expect(screen.queryByText('Unfinished guess')).not.toBeInTheDocument();
    const media = view.container.querySelector('.aspect-video')!;
    const videoPanel = ['VIDEO', 'CANVAS'].includes(media.tagName) ? media.parentElement! : media;
    expect(videoPanel.contains(words)).toBe(false);
    expect(words.parentElement).toHaveClass('h-24', 'overflow-hidden');
    expect(words).toHaveClass('overflow-y-auto');
  });

  it('clears old words and replaces the next utterance, restoring the scroll position', () => {
    const view = render(<TranscriptionBox cameraName="Camera 1" transcript={'Repeated speech. '.repeat(200)} listening />);
    const words = screen.getByRole('region', { name: 'Transcription for Camera 1' });
    words.scrollTop = 300;
    view.rerender(<TranscriptionBox cameraName="Camera 1" transcript="" listening />);
    expect(words).not.toHaveTextContent('Repeated speech.');
    expect(words).toHaveTextContent('Listening… no speech yet');
    view.rerender(<TranscriptionBox cameraName="Camera 1" transcript="A new sentence." listening />);
    expect(words).toHaveTextContent('A new sentence.');
    expect(words).not.toHaveTextContent('Repeated speech.');
    expect(words.scrollTop).toBe(0);
    expect(screen.getByRole('status')).toHaveTextContent('A new sentence.');
  });

  it('retains connection errors alongside a final transcript and announces them accessibly', () => {
    render(<TranscriptionBox cameraName="Camera 1" transcript="Original words." message="Camera audio disconnected." tone="error" />);
    const words = screen.getByRole('region', { name: 'Transcription for Camera 1' });
    expect(words).toHaveTextContent('Original words.');
    expect(words).toHaveTextContent('Camera audio disconnected.');
    expect(screen.getByRole('status')).toHaveTextContent('Original words. Camera audio disconnected.');
  });

  it('honors an explicitly cleared dashboard transcript instead of restoring stale session words', () => {
    render(<MemoryRouter><DashboardCameraCard slot={slot} monitoring eventCount={0} onConnect={vi.fn()} onToggleAi={vi.fn()} transcript="" /></MemoryRouter>);
    const words = screen.getByRole('region', { name: 'Transcription for Camera 1' });
    expect(words).not.toHaveTextContent('Kumusta, magandang umaga.');
    expect(words).toHaveTextContent('Listening for speech.');
  });
});
