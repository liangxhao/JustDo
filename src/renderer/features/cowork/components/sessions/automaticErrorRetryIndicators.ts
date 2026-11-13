import { isAutomaticErrorRetryActive } from '@shared/cowork/automaticErrorRetry';
import { useEffect, useState } from 'react';

const emptySessionIds: ReadonlySet<string> = new Set();

export function useAutomaticErrorRetryIndicators(): ReadonlySet<string> {
  const [sessionIds, setSessionIds] = useState(emptySessionIds);

  useEffect(() => {
    const api = window.electron?.cowork;
    if (!api?.getAutomaticErrorRetryActivity || !api.onAutomaticErrorRetryChanged) return;
    let disposed = false;
    let snapshotRevision = 0;
    // Keep terminal changes too, since a snapshot may have sampled an earlier phase.
    const changes = new Map<string, { revision: number; active: boolean }>();
    const remove = api.onAutomaticErrorRetryChanged(({ sessionId, revision, phase }) => {
      if (disposed || revision <= (changes.get(sessionId)?.revision ?? snapshotRevision)) return;
      const active = isAutomaticErrorRetryActive(phase);
      changes.set(sessionId, { revision, active });
      setSessionIds(current => {
        if (current.has(sessionId) === active) return current;
        const next = new Set(current);
        if (active) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    });

    void api.getAutomaticErrorRetryActivity().then(snapshot => {
      if (disposed || !snapshot) return;
      snapshotRevision = snapshot.revision;
      const next = new Set(snapshot.sessionIds);
      for (const [sessionId, change] of changes) {
        if (change.revision <= snapshotRevision) changes.delete(sessionId);
        else if (change.active) next.add(sessionId);
        else next.delete(sessionId);
      }
      setSessionIds(next);
    }).catch(() => {});

    return () => {
      disposed = true;
      remove();
    };
  }, []);

  return sessionIds;
}
