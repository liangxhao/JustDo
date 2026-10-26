import { useEffect } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import { store } from '@/store';

/** Refresh persisted metadata without selecting a task after its view has changed. */
export function useSessionFocusRefresh(sessionId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !sessionId || sessionId.startsWith('temp-')) return;
    let disposed = false;
    let latestRequest = 0;
    const handleWindowFocus = () => {
      const request = ++latestRequest;
      const canSelect = () => !disposed && request === latestRequest &&
        store.getState().cowork.currentSession?.id === sessionId;
      void coworkService.loadSession(sessionId, { canSelect }).catch(error => {
        if (canSelect()) console.error('Failed to refresh focused session:', error, `sessionId=${sessionId}`);
      });
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      disposed = true;
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [sessionId, enabled]);
}
