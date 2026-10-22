import { useEffect, useState } from 'react';

import { STARTUP_REVEAL_DURATION_MS, startupEntryRemaining } from './startupMotion';

const RevealPhase = { Waiting: 'waiting', Revealing: 'revealing', Complete: 'complete' } as const;
type RevealPhase = (typeof RevealPhase)[keyof typeof RevealPhase];

/** All three routes share motion; actual readiness and errors alone own dismissal. */
export function useStartupReveal(firstLaunch: boolean, loading: boolean) {
  const [phase, setPhase] = useState<RevealPhase>(RevealPhase.Waiting);
  useEffect(() => {
    if (loading) {
      setPhase(RevealPhase.Waiting);
      return;
    }
    let finishTimer: number | undefined;
    const begin = () => {
      setPhase(RevealPhase.Revealing);
      finishTimer = window.setTimeout(
        () => setPhase(RevealPhase.Complete),
        STARTUP_REVEAL_DURATION_MS,
      );
    };
    const entryTimer = window.setTimeout(begin, startupEntryRemaining());
    return () => {
      window.clearTimeout(entryTimer);
      window.clearTimeout(finishTimer);
    };
  }, [firstLaunch, loading]);
  return {
    covered: loading || phase !== RevealPhase.Complete,
    revealing: !loading && phase === RevealPhase.Revealing,
  };
}
