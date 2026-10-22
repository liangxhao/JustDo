import { useCallback, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

type StopSession = () => boolean | void | Promise<boolean | void>;

/** Keep a pending stop attached to its originating session across navigation. */
export const useSessionStop = (sessionId: string | undefined, onStop?: StopSession) => {
  const sessionKey = sessionId ?? '__home__';
  const pending = useRef(new Map<string, Promise<boolean>>());
  const [, refresh] = useState(0);
  const isStopPending = useCallback(() => pending.current.has(sessionKey), [sessionKey]);
  const requestStop = useCallback((): Promise<boolean> => {
    const existing = pending.current.get(sessionKey);
    if (existing) return existing;
    if (!onStop) return Promise.resolve(false);

    const stopping = Promise.resolve()
      .then(onStop)
      .then(result => result !== false)
      .catch(() => false)
      .then(stopped => {
        if (!stopped) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkStopFailed'),
            }),
          );
        }
        return stopped;
      })
      .finally(() => {
        if (pending.current.get(sessionKey) === stopping) {
          pending.current.delete(sessionKey);
          refresh(version => version + 1);
        }
      });
    pending.current.set(sessionKey, stopping);
    refresh(version => version + 1);
    return stopping;
  }, [onStop, sessionKey]);

  return { isStopping: isStopPending(), isStopPending, requestStop };
};
