import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ExpertMode from '@/components/dashboard/ExpertMode';
import AccessibilityPanel from '@/components/dashboard/AccessibilityPanel';
import type { CameraRuntime } from '@/types/multicam';
import { DEFAULT_SETTINGS } from '@/types/multicam';
import { setVoiceGuide } from '@/lib/voiceGuide';

vi.mock('@/lib/speech', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));

describe('expert and accessibility dialogs', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); setVoiceGuide(false); });

  it('shows the implemented formula, live calculation and selected thresholds', () => {
    const runtime = {
      cameraId: 'kitchen', status: 'online', fps: 30, latencyMs: 8,
      saliencyScore: 40, attentionScore: 54, objects: [{ label: 'person', confidence: 0.8, bbox: [0, 0, 20, 40] }],
      audioDistress: { detected: true, confidence: 0.5, keyword: 'help', transcript: 'help' },
      fire: { detected: false, confidence: 0 }, smoke: { detected: false, confidence: 0 },
      faceDistress: { detected: false, label: 'neutral', confidence: 0.1 },
    } as CameraRuntime;
    const select = vi.fn();
    render(<ExpertMode open onClose={() => {}} onSelectAlgorithm={select} runtime={runtime} settings={{ ...DEFAULT_SETTINGS, fireThreshold: 0.8 }} />);
    expect(screen.getByText('0.5 × 40 + 0.3 × 80.0 + 0.2 × 50.0 = 54')).toBeInTheDocument();
    expect(screen.getByText('54/100')).toBeInTheDocument();
    expect(screen.getByText(/camera alert additionally requires confidence ≥ 80.0%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open multimodal dashboard guide' }));
    expect(select).toHaveBeenCalledWith('hybrid');
  });

  it('reports the local microphone calculation separately from CCTV audio', () => {
    const runtime = {
      cameraId: 'local', status: 'online', fps: 30, latencyMs: 8,
      saliencyScore: 40, attentionScore: 54, objects: [{ label: 'person', confidence: 0.8, bbox: [0, 0, 20, 40] }],
      audioDistress: { detected: false, confidence: 0, keyword: '', transcript: '' },
      fire: { detected: false, confidence: 0 }, smoke: { detected: false, confidence: 0 },
      faceDistress: { detected: false, label: '', confidence: 0 },
    } as CameraRuntime;
    render(<ExpertMode open onClose={() => {}} onSelectAlgorithm={() => {}} runtime={runtime} audioDistressScore={50} attentionScore={55} />);
    expect(screen.getByText('0.4 × 40 + 0.3 × 80.0 + 0.3 × 50.0 = 55')).toBeInTheDocument();
    expect(screen.getByText('55/100')).toBeInTheDocument();
  });

  it('traps dialog focus, supports Escape and restores the opener', () => {
    render(<AccessibilityPanel />);
    const opener = screen.getByRole('button', { name: 'Open accessibility settings' });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole('button', { name: 'Close accessibility settings' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Hear the voice' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('persists the native reader choice and gives the slider a spoken percentage', () => {
    render(<AccessibilityPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Open accessibility settings' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use my device screen reader (TalkBack / VoiceOver)' }));
    expect(localStorage.getItem('safewatch-native-screen-reader')).toBe('true');
    fireEvent.change(screen.getByRole('slider', { name: 'Text size' }), { target: { value: '125' } });
    expect(screen.getByRole('slider', { name: 'Text size' })).toHaveAttribute('aria-valuetext', '125 percent text size');
  });
});
