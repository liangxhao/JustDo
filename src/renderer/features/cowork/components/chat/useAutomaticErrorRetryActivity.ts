import {
  type AutomaticErrorRetryPresentation,
  isAutomaticErrorRetryActive,
} from '@shared/cowork/automaticErrorRetry';
import { useEffect, useState } from 'react';

/** Product activity only: this never changes native execution or Goal state. */
export function useAutomaticErrorRetryActivity(sessionId?: string): boolean {
  const [value, setValue] = useState<AutomaticErrorRetryPresentation | null>(null);
  useEffect(() => {
    const api = window.electron?.cowork;
    if (!sessionId || !api?.getAutomaticErrorRetry || !api.onAutomaticErrorRetryChanged) return;
    let active = true;
    let revision = -1;
    setValue(null);
    const accept = (next: AutomaticErrorRetryPresentation | null | undefined) => {
      if (!active || !next || next.sessionId !== sessionId || next.revision <= revision) return;
      revision = next.revision;
      setValue(next);
    };
    const remove = api.onAutomaticErrorRetryChanged(accept);
    void api.getAutomaticErrorRetry(sessionId).then(result => {
      if (result.success) accept(result.presentation);
    }).catch(() => {});
    return () => { active = false; remove(); };
  }, [sessionId]);
  return Boolean(value && value.sessionId === sessionId && isAutomaticErrorRetryActive(value.phase));
}
