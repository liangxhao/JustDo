import { INERT_CUSTODY_HARNESS } from './custody.js';

export interface ParsedCoworkSessionKey {
  agentId: string | null;
  sessionId: string;
}

export const DEFAULT_COWORK_AGENT_ID = 'main';

const RAW_SESSION_PREFIX = 'justdo:';

export function buildCoworkSessionKey(
  sessionId: string,
  agentId = DEFAULT_COWORK_AGENT_ID,
): string {
  const normalizedSessionId = sessionId.trim();
  const normalizedAgentId = agentId.trim() || DEFAULT_COWORK_AGENT_ID;
  if (!normalizedSessionId || normalizedSessionId.includes(':')) {
    throw new Error('Session ID must be a non-empty session-key segment.');
  }
  return `agent:${normalizedAgentId}:justdo:${normalizedSessionId}`;
}

export function parseCoworkSessionKey(
  sessionKey: string | undefined | null,
): ParsedCoworkSessionKey | null {
  const raw = (sessionKey ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith(RAW_SESSION_PREFIX)) {
    const sessionId = raw.slice(RAW_SESSION_PREFIX.length).trim();
    return sessionId && !sessionId.includes(':') ? { agentId: null, sessionId } : null;
  }
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'agent' || parts[2] !== 'justdo') return null;
  const agentId = parts[1]?.trim();
  const sessionId = parts[3]?.trim();
  return agentId && sessionId ? { agentId, sessionId } : null;
}

export function isCoworkSessionKey(sessionKey: string | undefined | null): boolean {
  return parseCoworkSessionKey(sessionKey) !== null;
}
/** Reserved storage remains hidden even when a malformed suffix cannot be adopted. */
export function isCustodySessionKey(sessionKey: string | undefined | null): boolean {
  const parts = typeof sessionKey === 'string' ? sessionKey.split(':') : undefined;
  return !!parts && parts[0] === 'agent' && !!parts[1] &&
    parts[2] === 'harness' && parts[3] === INERT_CUSTODY_HARNESS && parts.length >= 5;
}
