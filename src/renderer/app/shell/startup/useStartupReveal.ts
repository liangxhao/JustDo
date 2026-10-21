import { useEffect, useState } from 'react';

import { STARTUP_REVEAL_DURATION_MS,startupEntryRemaining } from './startupMotion';

const RevealPhase = { Waiting: 'waiting', Revealing: 'revealing', Complete: 'complete' } as const;
type RevealPhase = (typeof RevealPhase)[keyof typeof RevealPhase];

/** The setup flow never enters this presentation, even after its marker is written. */
export function useStartupReveal(firstLaunch: boolean, loading: boolean) {
  const [phase, setPhase] = useState<RevealPhase>(RevealPhase.Waiting);
  useEffect(() => {
    if (firstLaunch || loading) {
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
    covered: loading || (!firstLaunch && phase !== RevealPhase.Complete),
    revealing: !firstLaunch && !loading && phase === RevealPhase.Revealing,
  };
}
