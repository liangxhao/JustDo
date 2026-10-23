import type { ApprovalRequest } from '../../../shared/security/approvals';
import { ApprovalKind, ExecApprovalDecision } from '../../../shared/security/approvals';
import type { GatewayClientLike } from '../../engine/gateway/types';

export interface ExternalApprovalBinding {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  runId: string;
  client: GatewayClientLike;
}

export type ExternalPermissionPresenter = (
  request: ApprovalRequest,
  signal: AbortSignal,
) => Promise<'allow-once' | 'deny'>;

interface Owner {
  binding: ExternalApprovalBinding;
  present: ExternalPermissionPresenter;
  controller: AbortController;
}

interface PendingApproval { controller: AbortController; resolved: boolean }

/** One presentation owner per externally executing native session. */
export class ExternalApprovalRouting {
  private readonly owners = new Map<string, Owner>();
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly getClient: () => GatewayClientLike | null) {}

  claim(
    binding: ExternalApprovalBinding,
    present: ExternalPermissionPresenter,
    signal?: AbortSignal,
  ): () => void {
    if (this.owners.has(binding.sessionKey)) throw new Error('The session already has an approval owner.');
    if (this.getClient() !== binding.client) throw new Error('The approval connection changed.');
    const owner: Owner = { binding, present, controller: new AbortController() };
    this.owners.set(binding.sessionKey, owner);
    // Cancellation withdraws permission immediately, but ownership stays until
    // exact execution settlement releases it. Later approvals must not fall
    // back to the desktop while native Stop is still unconfirmed.
    const abort = () => owner.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return () => {
      signal?.removeEventListener('abort', abort);
      if (this.owners.get(binding.sessionKey) !== owner) return;
      owner.controller.abort();
      this.owners.delete(binding.sessionKey);
    };
  }

  owns(request: ApprovalRequest): boolean {
    const key = request.request.sessionKey;
    const owner = typeof key === 'string' ? this.owners.get(key) : undefined;
    return Boolean(owner && this.matches(owner, request));
  }

  ownsRequest(kind: ApprovalKind, id: string): boolean {
    return this.pending.has(`${kind}:${id}`);
  }

  resolved(kind: ApprovalKind, id: string): void {
    const pending = this.pending.get(`${kind}:${id}`);
    if (pending) { pending.resolved = true; pending.controller.abort(); }
  }

  route(request: ApprovalRequest): boolean {
    const key = request.request.sessionKey;
    const owner = typeof key === 'string' ? this.owners.get(key) : undefined;
    if (!owner || !this.matches(owner, request)) return false;
    const identity = `${request.kind}:${request.id}`;
    if (this.pending.has(identity)) return true;
    const controller = new AbortController();
    const pending = { controller, resolved: false };
    this.pending.set(identity, pending);
    const abort = () => controller.abort();
    owner.controller.signal.addEventListener('abort', abort, { once: true });
    if (owner.controller.signal.aborted) abort();
    const remaining = Math.min(2_147_483_647, Math.max(0, request.expiresAtMs - Date.now()));
    const timer = setTimeout(abort, Number.isFinite(remaining) ? remaining : 0);
    void this.present(owner, request, pending).finally(() => {
      clearTimeout(timer);
      owner.controller.signal.removeEventListener('abort', abort);
      if (this.pending.get(identity) === pending) this.pending.delete(identity);
    });
    return true;
  }

  private async current(owner: Owner): Promise<boolean> {
    const binding = owner.binding;
    if (this.getClient() !== binding.client || owner.controller.signal.aborted) return false;
    const result = await binding.client.request<{ session?: Record<string, unknown> }>(
      'sessions.describe', { key: binding.sessionKey },
    );
    return this.getClient() === binding.client && !owner.controller.signal.aborted &&
      result.session?.key === binding.sessionKey && result.session.sessionId === binding.sessionId &&
      result.session.lifecycleRevision === binding.lifecycleRevision;
  }

  private matches(owner: Owner, request: ApprovalRequest): boolean {
    return request.request.runId === owner.binding.runId &&
      (request.kind !== ApprovalKind.Exec || request.request.sessionId == null ||
        request.request.sessionId === owner.binding.sessionId);
  }

  private async present(owner: Owner, request: ApprovalRequest, pending: PendingApproval): Promise<void> {
    const signal = pending.controller.signal;
    let decision: 'allow-once' | 'deny' = ExecApprovalDecision.Deny;
    let sent = false;
    try {
      if (!signal.aborted && request.expiresAtMs > Date.now() && await this.current(owner)) {
        decision = await owner.present(request, signal);
      }
      if (signal.aborted || request.expiresAtMs <= Date.now() || !await this.current(owner)) {
        decision = ExecApprovalDecision.Deny;
      }
      const allowed = request.request.allowedDecisions;
      if (decision !== ExecApprovalDecision.Deny && allowed && !allowed.includes(decision)) {
        decision = ExecApprovalDecision.Deny;
      }
      if (pending.resolved || this.getClient() !== owner.binding.client) return;
      // The asynchronous authority read can finish just before cancellation.
      // Recheck without an await between withdrawal and the decision send.
      if (signal.aborted || owner.controller.signal.aborted || request.expiresAtMs <= Date.now()) {
        decision = ExecApprovalDecision.Deny;
      }
      sent = true;
      await owner.binding.client.request(
        request.kind === ApprovalKind.Plugin ? 'plugin.approval.resolve' : 'exec.approval.resolve',
        { id: request.id, decision },
      );
    } catch {
      // An unavailable authority never grants permission. Native expiry/abort
      // remains authoritative; never replay a decision on a new connection.
      if (!sent && !pending.resolved && this.getClient() === owner.binding.client) {
        await owner.binding.client.request(
          request.kind === ApprovalKind.Plugin ? 'plugin.approval.resolve' : 'exec.approval.resolve',
          { id: request.id, decision: ExecApprovalDecision.Deny },
        ).catch(() => {});
      }
    }
  }
}
