import { useState } from 'react';
import { Accessibility, Contrast, Minus, Plus, RotateCcw, Volume2, X } from 'lucide-react';
import { DEFAULT_SCALE, MAX_SCALE, MIN_SCALE, useAccessibility } from '@/hooks/useAccessibility';
import { speak } from '@/lib/speech';
import { useAccessibleDialog } from '@/hooks/useAccessibleDialog';

export default function AccessibilityPanel() {
  const [open, setOpen] = useState(false);
  const { fontScale, setFontScale, highContrast, setHighContrast, voiceGuide, setVoiceGuide, nativeScreenReader, setNativeScreenReader, reset } =
    useAccessibility();
  const dialogRef = useAccessibleDialog(open, () => setOpen(false));

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-2 rounded-lg hover:bg-muted transition-colors"
        title="Accessibility — text size & high contrast"
        aria-label="Open accessibility settings"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Accessibility className="w-5 h-5 text-muted-foreground" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[120] bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            ref={node => { dialogRef.current = node; }}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto bg-card border-2 border-border rounded-xl shadow-xl p-5 space-y-5"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="accessibility-settings-title"
            tabIndex={-1}
          >
            <div className="flex items-center justify-between">
              <h2 id="accessibility-settings-title" className="text-2xl font-bold flex items-center gap-2">
                <Accessibility className="w-6 h-6 text-primary" /> Accessibility
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="p-2 rounded-lg hover:bg-muted"
                aria-label="Close accessibility settings"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Font size */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label htmlFor="font-scale" className="text-lg font-bold">Text size</label>
                <span className="text-lg font-bold text-primary tabular-nums">{fontScale}%</span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setFontScale(fontScale - 5)}
                  className="p-3 rounded-lg border-2 border-border hover:border-primary"
                  aria-label="Decrease text size"
                  disabled={fontScale <= MIN_SCALE}
                >
                  <Minus className="w-5 h-5" />
                </button>
                <input
                  id="font-scale"
                  type="range"
                  min={MIN_SCALE}
                  max={MAX_SCALE}
                  step={5}
                  value={fontScale}
                  aria-valuetext={`${fontScale} percent text size`}
                  onChange={e => setFontScale(Number(e.target.value))}
                  className="flex-1 h-3 accent-primary cursor-pointer"
                />
                <button
                  onClick={() => setFontScale(fontScale + 5)}
                  className="p-3 rounded-lg border-2 border-border hover:border-primary"
                  aria-label="Increase text size"
                  disabled={fontScale >= MAX_SCALE}
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              {/* Live preview — unaffected by the global scale so it shows the difference */}
              <div className="rounded-lg border-2 border-border bg-background p-4">
                <p className="text-sm font-bold text-muted-foreground uppercase mb-2">Preview</p>
                <p style={{ fontSize: `${(16 * fontScale) / 100}px`, lineHeight: 1.5 }} className="font-semibold">
                  Motion detected in the living room at 10:47 AM.
                </p>
                <p
                  style={{ fontSize: `${(13 * fontScale) / 100}px` }}
                  className="text-muted-foreground font-semibold mt-1"
                >
                  Smaller labels look like this.
                </p>
              </div>

              <button
                onClick={reset}
                className="text-base font-semibold text-primary flex items-center gap-1.5 hover:underline"
              >
                <RotateCcw className="w-4 h-4" /> Reset to {DEFAULT_SCALE}%
              </button>
            </div>

            {/* High contrast */}
            <div className="space-y-2 border-t-2 border-border pt-4">
              <button
                onClick={() => setHighContrast(!highContrast)}
                className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-lg border-2 transition-colors ${
                  highContrast
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border hover:border-primary'
                }`}
                aria-pressed={highContrast}
              >
                <span className="flex items-center gap-2 text-lg font-bold">
                  <Contrast className="w-5 h-5" /> High-contrast theme
                </span>
                <span className="text-base font-bold">{highContrast ? 'ON' : 'OFF'}</span>
              </button>
              <p className="text-base text-muted-foreground font-semibold">
                Boosts contrast on buttons, alerts and the camera bounding-box overlays.
              </p>
            </div>

            {/* Talking accessibility — screen-reader style voice for blind users */}
            <div className="space-y-2 border-t-2 border-border pt-4">
              <button
                onClick={() => setVoiceGuide(!voiceGuide)}
                className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-lg border-2 transition-colors ${
                  voiceGuide
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border hover:border-primary'
                }`}
                aria-pressed={voiceGuide}
                aria-describedby="talking-mode-help"
              >
                <span className="flex items-center gap-2 text-lg font-bold">
                  <Volume2 className="w-5 h-5" /> Talking mode
                </span>
                <span className="text-base font-bold">{voiceGuide ? 'ON' : 'OFF'}</span>
              </button>
              <p id="talking-mode-help" className="text-base text-muted-foreground font-semibold">
                Hear names, roles, values and states as you focus controls with Tab or explore with a mouse or touch.
                Use Alt + Left/Right Arrow to explore headings and controls, and Enter or Space to activate.
                Touch and drag to hear controls; tap to activate. Escape stops the voice.
              </p>
              <label className="flex items-start gap-3 rounded-lg border-2 border-border p-3 text-base font-semibold">
                <input
                  type="checkbox"
                  checked={nativeScreenReader}
                  onChange={event => setNativeScreenReader(event.target.checked)}
                  aria-describedby="device-screen-reader-help"
                  className="mt-1 h-5 w-5 accent-primary"
                />
                Use my device screen reader (TalkBack / VoiceOver)
              </label>
              <p id="device-screen-reader-help" className="text-sm text-muted-foreground">
                Enable TalkBack or VoiceOver in your device accessibility settings. This option silences the app voice
                while keeping accessible controls and live alert announcements available, so two voices do not overlap.
                Use your screen reader&apos;s normal swipe, explore-by-touch and double-tap gestures.
              </p>
              <button
                onClick={() =>
                  speak(
                    'This is the MSDS voice. I will read the screen out loud so you can use the system without seeing it.',
                  )
                }
                className="text-base font-semibold text-primary flex items-center gap-1.5 hover:underline"
              >
                <Volume2 className="w-4 h-4" /> Hear the voice
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
