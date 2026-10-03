import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, describeAccessibleElement, setVoiceGuide } from '@/lib/voiceGuide';
import { speak, stopSpeaking } from '@/lib/speech';

vi.mock('@/lib/speech', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));

describe('talking accessibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVoiceGuide(false);
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });
  afterEach(() => {
    setVoiceGuide(false);
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads the accessible name, role and range value using referenced labels', () => {
    document.body.innerHTML = '<span id="name">Text size</span><input type="range" aria-label="Fallback" aria-labelledby="name" aria-valuetext="125 percent text size" disabled>';
    expect(describeAccessibleElement(document.querySelector('input')!)).toBe('Text size, slider, unavailable, 125 percent text size');
  });

  it('keeps passwords out of narration and reads wrapping labels and switch state', () => {
    document.body.innerHTML = '<label>Password<input type="password" value="private-value"></label><button role="switch" aria-label="High contrast" aria-checked="true"></button>';
    expect(describeAccessibleElement(document.querySelector('input')!)).toBe('Password, protected text field');
    expect(describeAccessibleElement(document.querySelector('button')!)).toBe('High contrast, switch, checked');
  });

  it('reads focus and updated values, and removes delayed listeners when disabled', () => {
    document.body.innerHTML = '<label for="range">Text size</label><input id="range" type="range" min="85" max="160" value="100">';
    setVoiceGuide(true);
    vi.mocked(speak).mockClear();
    const range = document.querySelector('input')!;
    range.focus();
    expect(speak).toHaveBeenLastCalledWith('Text size, slider, value 100, minimum 85, maximum 160', { interrupt: true });
    range.value = '120';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(120);
    expect(speak).toHaveBeenLastCalledWith('Text size, slider, value 120, minimum 85, maximum 160', { interrupt: true });
    range.value = '130';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    setVoiceGuide(false);
    vi.mocked(speak).mockClear();
    vi.advanceTimersByTime(200);
    range.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(speak).not.toHaveBeenCalled();
  });

  it('supports device screen readers without duplicate synthesized speech', () => {
    document.body.innerHTML = '<button aria-label="Start monitoring">Start</button>';
    setVoiceGuide(true, false);
    document.querySelector('button')!.focus();
    announce('Smoke detected in the kitchen', true);
    vi.advanceTimersByTime(30);
    expect(speak).not.toHaveBeenCalled();
    expect(stopSpeaking).toHaveBeenCalled();
    const region = document.getElementById('msds-accessibility-announcements');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveTextContent('Smoke detected in the kitchen');
  });

  it('explores headings with Alt arrows within the current modal and keeps ordinary arrows native', () => {
    document.body.innerHTML = '<button id="outside">Outside</button><section role="dialog" aria-modal="true"><h2>Settings</h2><button disabled>Disabled</button><button id="next">Next</button><button hidden>Hidden</button></section>';
    setVoiceGuide(true);
    const first = new KeyboardEvent('keydown', { key: 'Home', altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(first);
    expect(document.activeElement).toBe(document.querySelector('h2'));
    expect(first.defaultPrevented).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(document.getElementById('next'));
    const normalArrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    document.dispatchEvent(normalArrow);
    expect(normalArrow.defaultPrevented).toBe(false);
    setVoiceGuide(false);
    expect(document.querySelector('h2')).not.toHaveAttribute('tabindex');
  });

  it('reads touch exploration while preserving taps and scroll gestures', () => {
    document.body.innerHTML = '<button id="first">Start monitoring</button><button id="second">Recording folder</button>';
    const first = document.getElementById('first')!;
    const second = document.getElementById('second')!;
    const activate = vi.fn();
    first.addEventListener('click', activate);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => second) });
    setVoiceGuide(true);
    vi.mocked(speak).mockClear();
    const touchEvent = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerType: 'touch', clientX: x, clientY: 0 });
      first.dispatchEvent(event);
      return event;
    };
    expect(touchEvent('pointerdown', 0).defaultPrevented).toBe(false);
    expect(speak).toHaveBeenLastCalledWith('Start monitoring, button', { interrupt: true });
    expect(touchEvent('pointermove', 30).defaultPrevented).toBe(false);
    expect(speak).toHaveBeenLastCalledWith('Recording folder, button', { interrupt: true });
    touchEvent('pointerup', 30);
    first.click();
    expect(activate).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(second);
  });
});
