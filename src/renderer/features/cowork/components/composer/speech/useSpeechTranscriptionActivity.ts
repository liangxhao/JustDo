import { useCallback, useEffect, useRef, useState } from 'react';

export interface SpeechTranscriptionActivity {
  busy: boolean;
  isBusy: () => boolean;
  changed: (busy: boolean, owner: object) => void;
}

/** The composer owns admission across replaceable toolbar layouts and drafts. */
export function useSpeechTranscriptionActivity(): SpeechTranscriptionActivity {
  const owners = useRef(new Set<object>());
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const isBusy = useCallback(() => owners.current.size > 0, []);
  const changed = useCallback((active: boolean, owner: object) => {
    if (active) owners.current.add(owner);
    else owners.current.delete(owner);
    if (mounted.current) setBusy(owners.current.size > 0);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return { busy, isBusy, changed };
}
