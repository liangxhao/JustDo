import {
  type AuthActionResult,
  AuthErrorCode,
  type AuthState,
  INITIAL_AUTH_STATE,
} from '@shared/app/auth';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useAuth() {
  const [state, setState] = useState<AuthState>(INITIAL_AUTH_STATE);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);
  const [loading, setLoading] = useState(true);
  const active = useRef(false);
  const revision = useRef(-1);
  const apply = useCallback((next: AuthState) => {
    if (!active.current || next.revision < revision.current) return;
    revision.current = next.revision;
    setState(next);
    setErrorCode(next.errorCode);
    setLoading(false);
  }, []);

  useEffect(() => {
    active.current = true;
    const api = window.electron.auth;
    if (!api) {
      setLoading(false);
      setErrorCode(AuthErrorCode.Unavailable);
      return () => {
        active.current = false;
      };
    }
    // Subscribe first; revisions keep an older initial query from undoing a live update.
    const stop = api.onStateChanged(apply);
    void api
      .getState()
      .then(apply)
      .catch(() => {
        if (active.current && revision.current < 0) {
          setLoading(false);
          setErrorCode(AuthErrorCode.Unavailable);
        }
      });
    return () => {
      active.current = false;
      stop();
    };
  }, [apply]);

  const act = useCallback(
    async (
      action: () => Promise<AuthActionResult>,
    ): Promise<Pick<AuthActionResult, 'success' | 'errorCode'> | null> => {
      const startedRevision = revision.current;
      try {
        const result = await action();
        apply(result.state);
        if (
          active.current &&
          result.state.revision >= revision.current &&
          result.errorCode !== AuthErrorCode.SessionChanged
        ) {
          setErrorCode(result.errorCode ?? null);
          return result;
        }
        return null;
      } catch {
        if (!active.current || revision.current !== startedRevision) return null;
        setErrorCode(AuthErrorCode.Unavailable);
        return { success: false, errorCode: AuthErrorCode.Unavailable };
      }
    },
    [apply],
  );

  return {
    state,
    loading,
    errorCode,
    login: () => act(() => window.electron.auth.login()),
    logout: () => act(() => window.electron.auth.logout()),
    retrySync: () => act(() => window.electron.auth.retrySync()),
  };
}
