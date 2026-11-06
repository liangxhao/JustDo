import type React from 'react';
import { useContext, useEffect } from 'react';

import { isDomHTMLElement, isDomNode, OwnerDocumentContext } from '@/shared/dom/ownerDocument';

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
  trapFocus = true,
  active = true,
): void => {
  const contextDocument = useContext(OwnerDocumentContext);
  useEffect(() => {
    if (!active) return;
    const ownerDocument = contextDocument ?? document;
    const ownerWindow = ownerDocument.defaultView ?? window;
    const dialogElement = dialogRef.current;
    const previouslyFocused = isDomHTMLElement(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : null;
    const focusFrame = ownerWindow.requestAnimationFrame(() => {
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

      const currentIndex = focusable.indexOf(ownerDocument.activeElement as HTMLElement);
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

    if (trapFocus) {
      ownerDocument.addEventListener('keydown', handleKeyDown, true);
    }
    return () => {
      ownerWindow.cancelAnimationFrame(focusFrame);
      if (trapFocus) {
        ownerDocument.removeEventListener('keydown', handleKeyDown, true);
      }
      ownerWindow.requestAnimationFrame(() => {
        const activeElement = ownerDocument.activeElement;
        const shouldRestoreFocus =
          trapFocus ||
          activeElement === ownerDocument.body ||
          (isDomNode(activeElement) && Boolean(dialogElement?.contains(activeElement)));
        if (shouldRestoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
      });
    };
  }, [active, dialogRef, initialFocusRef, resetKey, trapFocus, contextDocument]);
};
