import { type MutableRefObject, useEffect } from 'react';

/** The composer, not the debounced Redux copy, owns in-progress user input. */
export function useAppendComposerDraft(options: {
  draftKey: string;
  isSideChat: boolean;
  latestValueRef: MutableRefObject<string>;
  setValue: (value: string) => void;
  persist: (value: string) => void;
  focus: () => void;
}): void {
  useEffect(() => {
    const append = (event: Event) => {
      const request = event as CustomEvent<{ sessionId: string; text: string }>;
      if (options.isSideChat || request.detail?.sessionId !== options.draftKey) return;
      request.preventDefault();
      const addition = request.detail.text;
      const current = options.latestValueRef.current;
      if (!addition || current.includes(addition)) return;
      const next = current ? `${current}\n\n${addition}` : addition;
      options.latestValueRef.current = next;
      options.setValue(next);
      options.persist(next);
      options.focus();
    };
    window.addEventListener('cowork:append-draft', append);
    return () => window.removeEventListener('cowork:append-draft', append);
  }, [options]);
}
