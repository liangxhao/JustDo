import { createAppServerApprovalPresenter } from '../clients/appServer/protocol/appServerApprovals';
import type { AppServerConnectionContext } from '../clients/appServer/protocol/appServerProtocol';
import type { GatewayClientLike } from '../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../engine/openclaw/openclawRuntimeAdapter';
import type { CoworkNativeAcceptedBinding, CoworkNativeSendBinding } from '../engine/types';
import type { ExternalApprovalSessionScope } from '../openclaw/permissions/externalApprovalSessionScope';

interface ApprovalOwnerOptions {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  expected: { sessionKey: string; nativeSessionId: string; clientGeneration: number | undefined };
  context: AppServerConnectionContext;
  signal: AbortSignal;
  scope?: ExternalApprovalSessionScope;
  threadId: string;
  turnId: string;
  isCurrent: () => boolean;
}

/** A sending browser peer owns permission presentation until exact settlement. */
export class ChromeAppServerApprovals {
  private readonly controller = new AbortController();
  private readonly runReady: Promise<string | undefined>;
  private resolveRun!: (runId: string | undefined) => void;
  private runtime?: OpenClawRuntimeAdapter;
  private client?: GatewayClientLike;
  private binding?: CoworkNativeSendBinding;
  private nativeRunId?: string;
  private releaseClaim?: () => void;
  private released = false;
  private readonly onWithdraw = () => this.withdraw();

  constructor(private readonly options: ApprovalOwnerOptions) {
    this.runReady = new Promise(resolve => { this.resolveRun = resolve; });
    options.signal.addEventListener('abort', this.onWithdraw, { once: true });
    if (options.signal.aborted) this.withdraw();
  }

  prepare(binding: CoworkNativeSendBinding): void {
    const runtime = this.options.getRuntime();
    const client = runtime?.getGatewayClient();
    const expected = this.options.expected;
    if (this.binding || this.released || this.controller.signal.aborted || this.options.context.isClosed() ||
      !this.options.isCurrent() || !runtime || !client || runtime.getGatewayClientGeneration() !== binding.clientGeneration ||
      binding.sessionKey !== expected.sessionKey || binding.nativeSessionId !== expected.nativeSessionId ||
      binding.clientGeneration !== expected.clientGeneration)
      throw Object.assign(new Error('Chrome approval ownership changed before sending.'), { requestSent: false });
    this.runtime = runtime;
    this.client = client;
    this.binding = binding;
    this.releaseClaim = runtime.claimExternalApprovalOwner({
      sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
      lifecycleRevision: binding.lifecycleRevision, client, runIdReady: this.runReady,
      clientGeneration: binding.clientGeneration, isCurrent: () => this.current(), approvalScope: this.options.scope,
    }, createAppServerApprovalPresenter(
      this.options.context, this.options.threadId, this.options.turnId, this.controller.signal,
      () => this.cancel(), { nativeRunId: () => this.nativeRunId, allowSession: Boolean(this.options.scope) },
    ), this.controller.signal);
  }

  accepted(binding: CoworkNativeAcceptedBinding): void {
    if (!this.current() || binding.clientTurnId !== this.options.turnId ||
      binding.sessionKey !== this.binding?.sessionKey || binding.nativeSessionId !== this.binding.nativeSessionId ||
      binding.lifecycleRevision !== this.binding.lifecycleRevision || binding.clientGeneration !== this.binding.clientGeneration ||
      !binding.nativeRunId || binding.nativeRunId.trim() !== binding.nativeRunId) {
      this.withdraw();
      return;
    }
    this.nativeRunId = binding.nativeRunId;
    this.resolveRun(binding.nativeRunId);
  }

  /** Withdraw interaction without transferring ownership or stopping execution. */
  withdraw(): void {
    if (this.binding) this.options.scope?.clearSession(this.binding.sessionKey);
    this.controller.abort();
    this.resolveRun(undefined);
  }

  /** Only known-unsent input or verified whole-run settlement may release. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.options.signal.removeEventListener('abort', this.onWithdraw);
    this.controller.abort();
    this.resolveRun(undefined);
    this.releaseClaim?.();
  }

  private current(): boolean {
    return !this.controller.signal.aborted && this.identityCurrent();
  }

  private identityCurrent(): boolean {
    return !this.released && !this.options.signal.aborted && !this.options.context.isClosed() &&
      this.options.isCurrent() && this.options.getRuntime() === this.runtime &&
      this.runtime?.getGatewayClient() === this.client &&
      this.runtime?.getGatewayClientGeneration() === this.binding?.clientGeneration;
  }

  private async cancel(): Promise<void> {
    const binding = this.binding;
    const nativeRunId = this.nativeRunId;
    const client = this.client;
    const admitted = this.current();
    this.withdraw();
    if (!admitted || !binding || !nativeRunId || !client) return;
    const result = await client.request<{ session?: Record<string, unknown> }>(
      'sessions.describe', { key: binding.sessionKey },
    );
    if (!this.identityCurrent() || result.session?.key !== binding.sessionKey ||
      result.session.sessionId !== binding.nativeSessionId || result.session.lifecycleRevision !== binding.lifecycleRevision) return;
    // This exact owner sent this run. An abort ACK never releases its lease.
    await client.request('sessions.abort', { key: binding.sessionKey, runId: nativeRunId });
  }
}
