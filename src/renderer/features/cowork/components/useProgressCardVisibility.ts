import { type ProgressCard, progressCardIsComplete } from '@shared/openclaw/progressCard';
import { useCallback, useEffect, useRef, useState } from 'react';

export const PROGRESS_CARD_COMPLETION_DISPLAY_MS = 4_000;

interface ProgressCardSnapshot {
  sessionKey: string;
  revision: number;
  complete: boolean;
}

export function useProgressCardVisibility(card: ProgressCard | null) {
  const [visible, setVisible] = useState(false);
  const previousRef = useRef<ProgressCardSnapshot | null>(null);
  const autoHideTimerRef = useRef<number | null>(null);

  const clearAutoHide = useCallback(() => {
    if (autoHideTimerRef.current === null) return;
    window.clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = null;
  }, []);

  const show = useCallback(() => {
    clearAutoHide();
    setVisible(true);
  }, [clearAutoHide]);

  const hide = useCallback(() => {
    clearAutoHide();
    setVisible(false);
  }, [clearAutoHide]);

  const sessionKey = card?.sessionKey ?? null;
  const revision = card?.revision ?? null;
  const complete = card ? progressCardIsComplete(card) : false;

  useEffect(() => {
    clearAutoHide();

    if (!card) {
      previousRef.current = null;
      setVisible(false);
      return;
    }

    const next: ProgressCardSnapshot = {
      sessionKey: card.sessionKey,
      revision: card.revision,
      complete,
    };
    const previous = previousRef.current;
    previousRef.current = next;

    if (!previous || previous.sessionKey !== next.sessionKey) {
      // A completed card restored with the session stays out of the way until
      // the user explicitly opens it from the header.
      setVisible(!next.complete);
      return;
    }

    if (!next.complete) {
      // Preserve a manual hide across ordinary revisions, but show a new plan
      // when it replaces the previous completed one.
      if (previous.complete) setVisible(true);
      return;
    }

    if (!previous.complete) {
      setVisible(true);
      autoHideTimerRef.current = window.setTimeout(() => {
        autoHideTimerRef.current = null;
        setVisible(false);
      }, PROGRESS_CARD_COMPLETION_DISPLAY_MS);
    }
  }, [card, clearAutoHide, complete, revision, sessionKey]);

  useEffect(() => clearAutoHide, [clearAutoHide]);

  return { visible, show, hide };
}
