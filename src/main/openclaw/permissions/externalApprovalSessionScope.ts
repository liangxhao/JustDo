import { ApprovalKind, type ApprovalRequest, ExecApprovalDecision } from '../../../shared/security/approvals';
import type { ExternalApprovalBinding } from './externalApprovalRouting';
import { buildSessionExecApprovalFingerprint, SessionExecApprovalGrants } from './sessionExecApprovalGrants';

const MAX_SESSIONS = 256;
type Identity = Pick<ExternalApprovalBinding, 'sessionKey' | 'sessionId' | 'lifecycleRevision' | 'client' | 'clientGeneration'>;

/** Connection-local grants reuse only exact native command/environment fingerprints. */
export class ExternalApprovalSessionScope {
  private readonly identities = new Map<string, Identity>();
  private readonly grants = new SessionExecApprovalGrants();
  private closed = false;
  private readonly onClose = () => this.close();

  constructor(private readonly signal?: AbortSignal) {
    signal?.addEventListener('abort', this.onClose, { once: true });
    if (signal?.aborted) this.close();
  }

  canGrant(binding: ExternalApprovalBinding, request: ApprovalRequest): boolean {
    return !this.closed && !this.signal?.aborted && request.kind === ApprovalKind.Exec &&
      request.request.sessionKey === binding.sessionKey &&
      (request.request.sessionId == null || request.request.sessionId === binding.sessionId) &&
      Number.isSafeInteger(binding.clientGeneration) && (binding.clientGeneration ?? 0) > 0 &&
      binding.isCurrent?.() === true &&
      (request.request.allowedDecisions == null || Array.isArray(request.request.allowedDecisions) &&
        request.request.allowedDecisions.includes(ExecApprovalDecision.AllowOnce)) &&
      buildSessionExecApprovalFingerprint(request) !== null;
  }

  matches(binding: ExternalApprovalBinding, request: ApprovalRequest): boolean {
    const identity = this.identities.get(binding.sessionKey);
    if (!this.sameIdentity(identity, binding) || !this.canGrant(binding, request)) {
      this.clearSession(binding.sessionKey);
      return false;
    }
    return request.kind === ApprovalKind.Exec && this.grants.matches(request);
  }

  grant(binding: ExternalApprovalBinding, request: ApprovalRequest): boolean {
    if (!this.canGrant(binding, request) || request.kind !== ApprovalKind.Exec) return false;
    const identity = this.identities.get(binding.sessionKey);
    if (identity && !this.sameIdentity(identity, binding)) this.clearSession(binding.sessionKey);
    while (!this.identities.has(binding.sessionKey) && this.identities.size >= MAX_SESSIONS)
      this.clearSession(this.identities.keys().next().value!);
    this.identities.set(binding.sessionKey, {
      sessionKey: binding.sessionKey, sessionId: binding.sessionId, lifecycleRevision: binding.lifecycleRevision,
      client: binding.client, clientGeneration: binding.clientGeneration,
    });
    return this.grants.grant(request);
  }

  clearSession(sessionKey: string): void {
    this.identities.delete(sessionKey);
    this.grants.clearSession(sessionKey);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onClose);
    for (const key of this.identities.keys()) this.grants.clearSession(key);
    this.identities.clear();
  }

  private sameIdentity(identity: Identity | undefined, binding: ExternalApprovalBinding): boolean {
    return Boolean(identity && identity.sessionKey === binding.sessionKey && identity.sessionId === binding.sessionId &&
      identity.lifecycleRevision === binding.lifecycleRevision && identity.client === binding.client &&
      identity.clientGeneration === binding.clientGeneration);
  }
}
