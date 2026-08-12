import type React from 'react';
import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export const useDialogFocusTrap = (
  dialogRef: React.RefObject<HTMLDivElement | null>,
  initialFocusRef: React.RefObject<HTMLElement | null>,
  resetKey: string,
): void => {
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const fallback = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (initialFocusRef.current ?? fallback ?? dialogRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(element => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusable.length - 1
          : currentIndex - 1
        : currentIndex < 0 || currentIndex === focusable.length - 1
          ? 0
          : currentIndex + 1;
      event.preventDefault();
      event.stopPropagation();
      focusable[nextIndex]?.focus();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.requestAnimationFrame(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      });
    };
  }, [dialogRef, initialFocusRef, resetKey]);
};
