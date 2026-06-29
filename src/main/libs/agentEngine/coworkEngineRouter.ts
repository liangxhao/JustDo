import { EventEmitter } from 'events';

import type { PermissionResult } from './types';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
} from './types';

type RouterDeps = {
  openclawRuntime: CoworkRuntime;
};

/**
 * Thin pass-through router. Delegates all calls to the OpenClaw runtime.
 * Previously supported multi-engine routing; now simplified since only
 * 'openclaw' exists as an engine.
 */
export class CoworkEngineRouter extends EventEmitter implements CoworkRuntime {
  private readonly runtime: CoworkRuntime;

  constructor(deps: RouterDeps) {
    super();
    this.runtime = deps.openclawRuntime;
    this.bindRuntimeEvents(this.runtime);
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(
    sessionId: string,
    prompt: string,
    options: CoworkStartOptions = {},
  ): Promise<void> {
    await this.runtime.startSession(sessionId, prompt, options);
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: CoworkContinueOptions = {},
  ): Promise<void> {
    await this.runtime.continueSession(sessionId, prompt, options);
  }

  stopSession(sessionId: string): void {
    this.runtime.stopSession(sessionId);
  }

  stopAllSessions(): void {
    this.runtime.stopAllSessions();
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    this.runtime.respondToPermission(requestId, result);
  }

  isSessionActive(sessionId: string): boolean {
    return this.runtime.isSessionActive(sessionId);
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.runtime.getSessionConfirmationMode(sessionId);
  }

  onSessionDeleted(sessionId: string, agentId?: string): void {
    this.runtime.onSessionDeleted?.(sessionId, agentId);
  }

  async generateTitle(userIntent: string | null, timeoutMs?: number): Promise<string> {
    if (this.runtime.generateTitle) {
      return this.runtime.generateTitle(userIntent, timeoutMs);
    }
    const fallback = 'New Session';
    const normalized = typeof userIntent === 'string' ? userIntent.trim() : '';
    if (!normalized) return fallback;
    const firstLine =
      normalized
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean) || '';
    return firstLine.slice(0, 50).trim() || fallback;
  }

  async patchSessionModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.runtime.patchSessionModel) {
      return this.runtime.patchSessionModel(sessionId, model, agentId);
    }
    return { ok: false, error: 'patchSessionModel not supported by current runtime' };
  }

  /** No-op: only 'openclaw' engine exists, engine switching is not applicable. */
  handleEngineConfigChanged(_nextEngine: string): void {}

  private bindRuntimeEvents(runtime: CoworkRuntime): void {
    runtime.on('message', (sessionId, message) => {
      this.emit('message', sessionId, message);
    });

    runtime.on('messageUpdate', (sessionId, messageId, content) => {
      this.emit('messageUpdate', sessionId, messageId, content);
    });

    runtime.on('thinkingUpdate', (sessionId, messageId, thinkingDelta) => {
      this.emit('thinkingUpdate', sessionId, messageId, thinkingDelta);
    });

    runtime.on(
      'messageMetadataUpdate',
      (
        sessionId,
        messageId,
        metadata,
        extra?: {
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        },
      ) => {
        this.emit('messageMetadataUpdate', sessionId, messageId, metadata, extra);
      },
    );

    runtime.on('messageDelete', (sessionId, messageId) => {
      this.emit('messageDelete', sessionId, messageId);
    });

    runtime.on('permissionRequest', (sessionId, request) => {
      this.emit('permissionRequest', sessionId, request);
    });

    runtime.on('complete', (sessionId, claudeSessionId, finalStatus) => {
      this.emit('complete', sessionId, claudeSessionId, finalStatus);
    });

    runtime.on('error', (sessionId, error) => {
      this.emit('error', sessionId, error);
    });

    runtime.on('sessionStopped', sessionId => {
      this.emit('sessionStopped', sessionId);
    });

  }
}
