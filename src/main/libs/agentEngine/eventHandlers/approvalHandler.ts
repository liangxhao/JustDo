/**
 * Exec approval event handler.
 *
 * Handles exec.approval.requested and exec.approval.resolved events from
 * the gateway. Manages pending approvals and permission request/response flow.
 */

import type { CoworkStore } from '../../../coworkStore';
import { t } from '../../../i18n';
import { getCommandDangerLevel, isDeleteCommand } from '../../commandSafety';
import type { PermissionRequest, PermissionResult } from '../types';

type ExecApprovalRequestedPayload = {
  id?: string;
  request?: {
    command?: string;
    cwd?: string | null;
    host?: string | null;
    security?: unknown;
    ask?: unknown;
    resolvedPath?: string | null;
    sessionKey?: string | null;
    agentId?: string | null;
  };
};

type ExecApprovalResolvedPayload = {
  id?: string;
};

export type PendingApprovalEntry = {
  requestId: string;
  sessionId: string;
  /** When true, use 'allow-always' decision so OpenClaw adds the command to its allowlist. */
  allowAlways?: boolean;
};

export interface ApprovalHandlerCallbacks {
  resolveSessionIdBySessionKey(sessionKey: string): string | undefined;
  rememberSessionKey(sessionId: string, sessionKey: string): void;
  isSessionInStopCooldown(sessionId: string): boolean;
  isSessionActive(sessionId: string): boolean;
  continueSession(sessionId: string, prompt: string): Promise<void>;
  emit(event: 'permissionRequest', sessionId: string, request: PermissionRequest): void;
  emit(event: 'error', sessionId: string, message: string): void;
  getGatewayClient(): { request(method: string, params: unknown): Promise<unknown> } | null;
  resolveChannelSession(sessionKey: string): string | null;
  get heartbeatSessionKeys(): Set<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

export class ApprovalHandler {
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();

  constructor(
    private readonly store: CoworkStore,
    private readonly callbacks: ApprovalHandlerCallbacks,
  ) {}

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' {
    return this.confirmationModeBySession.get(sessionId) ?? 'modal';
  }

  handleApprovalRequested(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalRequestedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    if (!typedPayload.request || !isRecord(typedPayload.request)) return;

    const request = typedPayload.request;
    const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
    let sessionId = sessionKey
      ? (this.callbacks.resolveSessionIdBySessionKey(sessionKey) ?? undefined)
      : undefined;

    // Try to resolve channel-originated sessions for approval requests
    if (!sessionId && sessionKey) {
      const channelSessionId = this.callbacks.resolveChannelSession(sessionKey);
      if (channelSessionId) {
        this.callbacks.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
      }
    }

    if (!sessionId) {
      return;
    }

    const command = typeof request.command === 'string' ? request.command : '';
    const isChannelSession = !this.callbacks.heartbeatSessionKeys.has(sessionKey);

    // Auto-approve: channel sessions always, local sessions for non-delete commands.
    if (isChannelSession || !isDeleteCommand(command)) {
      this.pendingApprovals.set(requestId, { requestId, sessionId, allowAlways: true });
      this.respondToPermission(requestId, { behavior: 'allow', updatedInput: {} });
    }
    // Suppress approval popups for sessions in stop cooldown
    if (this.callbacks.isSessionInStopCooldown(sessionId)) {
      return;
    }

    this.pendingApprovals.set(requestId, { requestId, sessionId });

    const { level: dangerLevel, reason: dangerReason } = getCommandDangerLevel(command);

    const permissionRequest: PermissionRequest = {
      requestId,
      toolName: 'Bash',
      toolInput: {
        command,
        dangerLevel,
        dangerReason,
        cwd: request.cwd ?? null,
        host: request.host ?? null,
        security: request.security ?? null,
        ask: request.ask ?? null,
        resolvedPath: request.resolvedPath ?? null,
        sessionKey: request.sessionKey ?? null,
        agentId: request.agentId ?? null,
      },
      toolUseId: requestId,
    };

    this.callbacks.emit('permissionRequest', sessionId, permissionRequest);
  }

  handleApprovalResolved(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalResolvedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    this.pendingApprovals.delete(requestId);
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    const decision =
      result.behavior !== 'allow' ? 'deny' : pending.allowAlways ? 'allow-always' : 'allow-once';
    const client = this.callbacks.getGatewayClient();
    if (!client) {
      this.pendingApprovals.delete(requestId);
      return;
    }

    const sessionId = pending.sessionId;
    // Only schedule continuation for user-initiated approvals (desktop modal),
    // not for auto-approved commands (allowAlways).
    const needsContinuation = !pending.allowAlways;

    void client
      .request('exec.approval.resolve', {
        id: requestId,
        decision,
      })
      .then(() => {
        if (!needsContinuation) return;
        // Continue the session so the model can see the command result.
        const prompt = decision !== 'deny' ? t('execApprovalApproved') : t('execApprovalDenied');
        const tryContinue = (retries: number) => {
          if (!this.store.getSession(sessionId)) return; // session deleted
          if (!this.callbacks.isSessionActive(sessionId)) {
            void this.callbacks.continueSession(sessionId, prompt).catch(error => {
              console.warn('[OpenClawRuntime] failed to continue session after approval:', error);
            });
            return;
          }
          // Session still active (user approved before run ended). Retry after delay.
          if (retries > 0) {
            setTimeout(() => tryContinue(retries - 1), 1000);
          }
        };
        tryContinue(10);
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.callbacks.emit('error', sessionId, `Failed to resolve OpenClaw approval: ${message}`);
      })
      .finally(() => {
        this.pendingApprovals.delete(requestId);
      });
  }

  clearPendingApprovalsBySession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(requestId);
      }
    }
  }
}
