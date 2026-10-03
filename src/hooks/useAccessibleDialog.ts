import { useEffect, useRef } from 'react';

/** Keep keyboard focus inside a modal and restore its opener on dismissal. */
export function useAccessibleDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
    )).filter(node => !node.matches(':disabled') && !node.closest('[hidden], [aria-hidden="true"], [inert]')
      && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
    const focus = () => (controls()[0] ?? dialog).focus();
    focus();
    const onKey = (event: KeyboardEvent) => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'));
      const top = dialogs[dialogs.length - 1];
      if (top !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const nodes = controls();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const current = document.activeElement;
        if (!nodes.length) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (current === first || !dialog.contains(current))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
