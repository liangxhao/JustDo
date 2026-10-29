import {
  buildCoworkSessionKey,
  DEFAULT_COWORK_AGENT_ID,
  parseCoworkSessionKey,
} from '../../shared/cowork/sessionKey';
import type { CoworkSession, CoworkStore } from '../data/coworkStore';

/** Resolve desktop ownership without treating a session-key suffix as authority. */
export const resolveBrowserDesktopSession = (
  store: Pick<CoworkStore, 'getSession' | 'getSessionByNativeKey'>,
  sessionKey: string,
): CoworkSession | null => {
  const key = parseCoworkSessionKey(sessionKey);
  if (!key?.agentId) return null;
  const session = store.getSessionByNativeKey(sessionKey) ?? store.getSession(key.sessionId);
  if (!session || key.agentId !== (session.agentId.trim() || DEFAULT_COWORK_AGENT_ID)) return null;
  const expectedKey = session.nativeSessionKey ?? buildCoworkSessionKey(session.id, session.agentId);
  return expectedKey === sessionKey ? session : null;
};
