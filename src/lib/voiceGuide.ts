/** Keyboard, pointer and touch narration with native screen-reader announcements. */
import { speak, stopSpeaking } from './speech';

let enabled = false;
let voiceOutput = true;
let lastSpoken = '';
let lastAt = 0;
let hoverTimer: number | null = null;
let changeTimer: number | null = null;
let liveTimer: number | null = null;
let explored: Element | null = null;
let touchOrigin: { x: number; y: number } | null = null;
const temporaryFocus = new Map<HTMLElement, string | null>();

const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="tab"], [role="menuitem"], [role="option"], [tabindex], h1, h2, h3, h4, h5, h6, [data-speak]';
const LIVE_REGION_ID = 'msds-accessibility-announcements';

export function isVoiceGuideEnabled() { return enabled; }

function textOf(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[aria-hidden="true"], [hidden], script, style').forEach(child => child.remove());
  return clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function referencedText(el: Element, attribute: string): string {
  return (el.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id))
    .filter((node): node is HTMLElement => !!node)
    .map(textOf).join(' ').trim();
}

function labelOf(el: Element): string {
  const explicit = referencedText(el, 'aria-labelledby') || el.getAttribute('aria-label');
  if (explicit) return explicit;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const labels = Array.from(el.labels ?? []).map(textOf).join(' ').trim();
    if (labels) return labels;
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) {
      return el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : 'Button');
    }
    return el.getAttribute('title') || el.getAttribute('placeholder') || el.name || 'Unlabelled control';
  }
  return el.getAttribute('data-speak') || el.getAttribute('title') || textOf(el)
    || el.querySelector('img[alt]')?.getAttribute('alt') || '';
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'range') return 'slider';
    if (el.type === 'checkbox' || el.type === 'radio') return el.type;
    if (['button', 'submit', 'reset'].includes(el.type)) return 'button';
    if (el.type === 'password') return 'protected text field';
    return 'text field';
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'dropdown';
  if (tag === 'textarea') return 'multiline text field';
  if (/^h[1-6]$/.test(tag)) return `heading level ${tag[1]}`;
  return '';
}

/** Spoken name, role, state and value. Password contents are never narrated. */
export function describeAccessibleElement(el: Element): string {
  const label = labelOf(el).slice(0, 220);
  if (!label) return '';
  const parts = [label, roleOf(el)].filter(Boolean);
  const pressed = el.getAttribute('aria-pressed');
  if (pressed !== null) parts.push(pressed === 'mixed' ? 'mixed' : pressed === 'true' ? 'on' : 'off');
  const checked = el.getAttribute('aria-checked');
  if (checked !== null) parts.push(checked === 'mixed' ? 'partially checked' : checked === 'true' ? 'checked' : 'not checked');
  else if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
    parts.push(el.indeterminate ? 'partially checked' : el.checked ? 'checked' : 'not checked');
  }
  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) parts.push(expanded === 'true' ? 'expanded' : 'collapsed');
  else if (el.tagName === 'SUMMARY') parts.push(el.parentElement?.hasAttribute('open') ? 'expanded' : 'collapsed');
  if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
  if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') parts.push('unavailable');
  if (el.getAttribute('aria-busy') === 'true') parts.push('busy');
  if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') parts.push('required');
  if (el.getAttribute('aria-invalid') === 'true') parts.push('invalid value');

  const valueText = el.getAttribute('aria-valuetext');
  const valueNow = el.getAttribute('aria-valuenow');
  if (valueText) parts.push(valueText);
  else if (el instanceof HTMLSelectElement) parts.push(Array.from(el.selectedOptions).map(option => option.text).join(', '));
  else if (el instanceof HTMLInputElement && el.type === 'range') parts.push(`value ${el.value}, minimum ${el.min || '0'}, maximum ${el.max || '100'}`);
  else if (valueNow !== null) parts.push(`value ${valueNow}`);
  else if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'password'].includes(el.type))) {
    parts.push(el.value ? `value ${el.value.slice(0, 180)}` : 'empty');
  }
  const description = referencedText(el, 'aria-describedby');
  if (description) parts.push(description.slice(0, 220));
  return parts.join(', ');
}

function say(text: string, interrupt = true) {
  if (!voiceOutput || !text) return;
  const now = Date.now();
  if (text === lastSpoken && now - lastAt < 900) return;
  lastSpoken = text;
  lastAt = now;
  speak(text, { interrupt });
}

function liveRegion(): HTMLElement {
  const existing = document.getElementById(LIVE_REGION_ID);
  if (existing) return existing;
  const region = document.createElement('div');
  region.id = LIVE_REGION_ID;
  region.className = 'sr-only';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  document.body.appendChild(region);
  return region;
}

/** Safety/status announcements also reach TalkBack and VoiceOver through ARIA. */
export function announce(text: string, interrupt = false) {
  if (!enabled || !text.trim()) return;
  const region = liveRegion();
  region.setAttribute('aria-live', interrupt ? 'assertive' : 'polite');
  region.textContent = '';
  if (liveTimer !== null) window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => { region.textContent = text; liveTimer = null; }, 30);
  say(text, interrupt);
}

function nearest(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest(INTERACTIVE) : null;
}

function onFocusIn(event: FocusEvent) {
  const el = nearest(event.target);
  if (hoverTimer !== null) window.clearTimeout(hoverTimer);
  if (el) say(describeAccessibleElement(el));
}

function onPointerOver(event: PointerEvent) {
  if (event.pointerType === 'touch') return;
  const el = nearest(event.target);
  if (hoverTimer !== null) window.clearTimeout(hoverTimer);
  if (el) hoverTimer = window.setTimeout(() => { say(describeAccessibleElement(el)); hoverTimer = null; }, 180);
}

function onPointerOut() {
  if (hoverTimer !== null) window.clearTimeout(hoverTimer);
  hoverTimer = null;
}

function onPointerDown(event: PointerEvent) {
  if (event.pointerType !== 'touch') return;
  touchOrigin = { x: event.clientX, y: event.clientY };
  explored = nearest(event.target);
  if (explored) say(describeAccessibleElement(explored));
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType !== 'touch' || !touchOrigin) return;
  if (Math.hypot(event.clientX - touchOrigin.x, event.clientY - touchOrigin.y) < 8) return;
  const el = nearest(document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target);
  if (!el || el === explored) return;
  explored = el;
  say(describeAccessibleElement(el));
  // Do not cancel touch events: taps, scrolling and device screen-reader gestures stay native.
}

function onPointerEnd() { touchOrigin = null; explored = null; }

function navigable(): HTMLElement[] {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));
  const visible = (el: HTMLElement) => !el.closest('[hidden], [aria-hidden="true"], [inert]')
    && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const visibleDialogs = dialogs.filter(visible);
  const scope = visibleDialogs[visibleDialogs.length - 1] ?? document.body;
  return Array.from(scope.querySelectorAll<HTMLElement>(INTERACTIVE)).filter(el => visible(el)
    && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true');
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') { stopSpeaking(); onPointerOut(); return; }
  // Extra traversal never replaces Tab, ordinary arrow keys or TalkBack gestures.
  if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const nodes = navigable();
  if (!nodes.length) return;
  event.preventDefault();
  const current = nodes.indexOf(document.activeElement as HTMLElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
    : (current + (event.key === 'ArrowLeft' ? -1 : 1) + nodes.length) % nodes.length;
  const next = nodes[index];
  if (!next.matches('button, a[href], input, select, textarea, summary, [tabindex]')) {
    temporaryFocus.set(next, next.getAttribute('tabindex'));
    next.setAttribute('tabindex', '-1');
  }
  next.focus({ preventScroll: true });
  next.scrollIntoView?.({ block: 'nearest' });
}

function onChange(event: Event) {
  const el = nearest(event.target);
  if (!el || (event.type === 'input' && el instanceof HTMLInputElement && el.type !== 'range')) return;
  if (event.type === 'input' && el instanceof HTMLTextAreaElement) return;
  if (changeTimer !== null) window.clearTimeout(changeTimer);
  changeTimer = window.setTimeout(() => { say(describeAccessibleElement(el)); changeTimer = null; }, 120);
}

function onClick(event: MouseEvent) {
  const el = nearest(event.target);
  if (!el?.matches('[aria-pressed], [aria-checked], [aria-expanded], summary')) return;
  if (changeTimer !== null) window.clearTimeout(changeTimer);
  changeTimer = window.setTimeout(() => { say(describeAccessibleElement(el)); changeTimer = null; }, 30);
}

export function setVoiceGuide(on: boolean, useBuiltInVoice = true) {
  const outputChanged = voiceOutput !== useBuiltInVoice;
  voiceOutput = useBuiltInVoice;
  if (outputChanged) stopSpeaking();
  if (on === enabled) return;
  enabled = on;
  const listeners = [
    ['focusin', onFocusIn], ['pointerover', onPointerOver], ['pointerout', onPointerOut],
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerEnd],
    ['pointercancel', onPointerEnd], ['keydown', onKeyDown], ['input', onChange], ['change', onChange], ['click', onClick],
  ] as const;
  for (const [name, listener] of listeners) {
    if (on) document.addEventListener(name, listener as EventListener, true);
    else document.removeEventListener(name, listener as EventListener, true);
  }
  document.documentElement.classList.toggle('voice-guide', on);
  if (on) {
    liveRegion();
    announce('Talking mode is on. Use Tab to move through controls. Alt plus Right or Left Arrow also reads headings and controls. On a touch screen, touch a control to hear it or drag over controls to explore. Tap to activate. Escape stops speech.', true);
  } else {
    onPointerOut();
    onPointerEnd();
    if (changeTimer !== null) window.clearTimeout(changeTimer);
    if (liveTimer !== null) window.clearTimeout(liveTimer);
    changeTimer = null;
    liveTimer = null;
    temporaryFocus.forEach((value, node) => value === null ? node.removeAttribute('tabindex') : node.setAttribute('tabindex', value));
    temporaryFocus.clear();
    document.getElementById(LIVE_REGION_ID)?.remove();
    lastSpoken = '';
    say('Talking mode is off.');
  }
}
