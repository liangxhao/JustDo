import type { ExecApprovalRequest } from '../../../shared/security/approvals';

const MAX_GRANTS_PER_SESSION = 256;
const MAX_GRANT_SESSIONS = 1_024;

const exactOptionalString = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
};

const exactStringArray = (value: unknown, sort = false): string[] | null => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return sort ? [...value].sort() : [...value];
};

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
};

const resolveSessionKey = (request: ExecApprovalRequest): string | null =>
  typeof request.request?.sessionKey === 'string' && request.request.sessionKey.trim()
    ? request.request.sessionKey.trim()
    : null;

export const buildSessionExecApprovalFingerprint = (
  request: ExecApprovalRequest,
): string | null => {
  const payload = request.request;
  if (!payload || !resolveSessionKey(request)) return null;
  const sessionId = exactOptionalString(payload.sessionId);
  if (!sessionId || sessionId !== sessionId.trim()) return null;

  const command = exactOptionalString(payload.command);
  const commandArgv = exactStringArray(payload.commandArgv);
  const envKeys = exactStringArray(payload.envKeys, true);
  if (command === undefined || commandArgv === null || envKeys === null) return null;
  if ((!command || command.length === 0) && commandArgv.length === 0) return null;

  // Gateway-host approvals expose environment keys but not their values. Reusing
  // such a request would conflate different execution environments.
  if (envKeys.length > 0 && !payload.systemRunBinding) return null;

  const exactFields = [
    payload.cwd,
    payload.host,
    payload.agentId,
    payload.security,
    payload.ask,
    payload.resolvedPath,
    payload.turnSourceChannel,
    payload.turnSourceTo,
    payload.turnSourceAccountId,
  ].map(exactOptionalString);
  if (exactFields.some(value => value === undefined)) return null;
  const [
    cwd,
    host,
    agentId,
    security,
    ask,
    resolvedPath,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
  ] = exactFields;

  return JSON.stringify({
    sessionId,
    command,
    commandArgv,
    cwd,
    host,
    agentId,
    envKeys,
    security,
    ask,
    resolvedPath,
    systemRunBinding: canonicalize(payload.systemRunBinding ?? null),
    systemRunPlan: canonicalize(payload.systemRunPlan ?? null),
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId: payload.turnSourceThreadId ?? null,
  });
};

export class SessionExecApprovalGrants {
  private readonly fingerprintsBySession = new Map<string, Set<string>>();
  private readonly pendingBySession = new Map<string, Set<object>>();
  private readonly reads = new Set<{ cleared: Set<string>; overflow: boolean }>();

  /** Cover the initial list await, before its exact source key is known. */
  captureRequest(): { isCurrent(request: ExecApprovalRequest): boolean; release(): void } | null {
    if (this.reads.size >= MAX_GRANTS_PER_SESSION) return null;
    const read = { cleared: new Set<string>(), overflow: false };
    this.reads.add(read);
    return {
      isCurrent: request => {
        const key = resolveSessionKey(request);
        return Boolean(key && this.reads.has(read) && !read.overflow && !read.cleared.has(key));
      },
      release: () => {
        this.reads.delete(read);
      },
    };
  }

  /** A reset/stop must invalidate an in-flight Native allow-once response. */
  prepareGrant(request: ExecApprovalRequest): { commit(): boolean; release(): void } | null {
    const sessionKey = resolveSessionKey(request);
    const fingerprint = buildSessionExecApprovalFingerprint(request);
    if (!sessionKey || !fingerprint) return null;
    if (!this.pendingBySession.has(sessionKey) && this.pendingBySession.size >= MAX_GRANT_SESSIONS)
      return null;
    const pending = this.pendingBySession.get(sessionKey) ?? new Set<object>();
    if (pending.size >= MAX_GRANTS_PER_SESSION) return null;
    const ticket = {};
    pending.add(ticket);
    this.pendingBySession.set(sessionKey, pending);
    const release = () => {
      pending.delete(ticket);
      if (!pending.size && this.pendingBySession.get(sessionKey) === pending)
        this.pendingBySession.delete(sessionKey);
    };
    return {
      commit: () => {
        if (this.pendingBySession.get(sessionKey) !== pending || !pending.has(ticket)) return false;
        // Use the identity captured before the await, never a mutable request.
        const granted = this.addFingerprint(sessionKey, fingerprint);
        release();
        return granted;
      },
      release,
    };
  }

  grant(request: ExecApprovalRequest): boolean {
    const sessionKey = resolveSessionKey(request);
    const fingerprint = buildSessionExecApprovalFingerprint(request);
    if (!sessionKey || !fingerprint) return false;
    return this.addFingerprint(sessionKey, fingerprint);
  }

  private addFingerprint(sessionKey: string, fingerprint: string): boolean {
    if (
      !this.fingerprintsBySession.has(sessionKey) &&
      this.fingerprintsBySession.size >= MAX_GRANT_SESSIONS
    )
      return false;

    const fingerprints = this.fingerprintsBySession.get(sessionKey) ?? new Set<string>();
    fingerprints.delete(fingerprint);
    while (fingerprints.size >= MAX_GRANTS_PER_SESSION) {
      const oldest = fingerprints.values().next().value;
      if (typeof oldest !== 'string') break;
      fingerprints.delete(oldest);
    }
    fingerprints.add(fingerprint);
    this.fingerprintsBySession.set(sessionKey, fingerprints);
    return true;
  }

  matches(request: ExecApprovalRequest): boolean {
    const sessionKey = resolveSessionKey(request);
    const fingerprint = buildSessionExecApprovalFingerprint(request);
    return Boolean(
      sessionKey && fingerprint && this.fingerprintsBySession.get(sessionKey)?.has(fingerprint),
    );
  }

  clearSession(sessionKey: string): void {
    const normalized = sessionKey.trim();
    if (normalized) {
      for (const read of this.reads) {
        if (read.cleared.size >= MAX_GRANT_SESSIONS) {
          read.overflow = true;
          read.cleared.clear();
        } else if (!read.overflow) read.cleared.add(normalized);
      }
      this.fingerprintsBySession.delete(normalized);
      this.pendingBySession.delete(normalized);
    }
  }
}
