import { useCallback, useEffect, useRef, useState } from 'react';

/** One automatic reveal per chat; dismissal and Tab navigation never rearm it. */
export function useSessionSummaryVisibility(sessionId: string | null, meaningful: boolean) {
  const seen = useRef(new Set<string>());
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  useEffect(() => {
    setOpenSessionId(current => (current === sessionId ? current : null));
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId || !meaningful || seen.current.has(sessionId)) return;
    seen.current.add(sessionId);
    setOpenSessionId(sessionId);
  }, [sessionId, meaningful]);
  const close = useCallback(() => {
    if (sessionId) seen.current.add(sessionId);
    setOpenSessionId(null);
  }, [sessionId]);
  const toggle = useCallback(() => {
    if (!sessionId) return;
    seen.current.add(sessionId);
    setOpenSessionId(current => (current === sessionId ? null : sessionId));
  }, [sessionId]);
  const promote = useCallback((fromSessionId: string, toSessionId: string) => {
    if (seen.current.has(fromSessionId)) seen.current.add(toSessionId);
    seen.current.delete(fromSessionId);
    setOpenSessionId(current => (current === fromSessionId ? toSessionId : current));
  }, []);
  return { visible: !!sessionId && openSessionId === sessionId, close, toggle, promote };
}
