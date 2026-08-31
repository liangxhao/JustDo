import { EventEmitter } from 'events';

import type {
  CoworkContinueOptions,
  CoworkGenerateTitleOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  CoworkStopOptions,
} from '../types';

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

  async stopSession(sessionId: string, options?: CoworkStopOptions): Promise<void> {
    await this.runtime.stopSession(sessionId, options);
  }

  async stopAllSessions(): Promise<void> {
    await this.runtime.stopAllSessions();
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

  async generateTitle(
    userIntent: string | null,
    options?: CoworkGenerateTitleOptions,
  ): Promise<string> {
    if (this.runtime.generateTitle) {
      return this.runtime.generateTitle(userIntent, options);
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
  ): ReturnType<NonNullable<CoworkRuntime['patchSessionModel']>> {
    if (this.runtime.patchSessionModel) {
      return this.runtime.patchSessionModel(sessionId, model, agentId);
    }
    return { ok: false, error: 'patchSessionModel not supported by current runtime' };
  }

  async getSessionModel(
    sessionId: string,
    agentId?: string,
  ): ReturnType<NonNullable<CoworkRuntime['getSessionModel']>> {
    if (this.runtime.getSessionModel) return this.runtime.getSessionModel(sessionId, agentId);
    return Promise.resolve({
      ok: false,
      error: 'getSessionModel not supported by current runtime',
    });
  }

  async getSessionRuntimeStatus(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<{
    known: boolean;
    mainRunning: boolean;
    subagentRunning: boolean;
    running: boolean;
    rootRunId?: string;
  }> {
    if (this.runtime.getSessionRuntimeStatus) {
      return this.runtime.getSessionRuntimeStatus(sessionId, options);
    }
    return { known: false, mainRunning: false, subagentRunning: false, running: false };
  }

  async getSessionRuntimeStatuses(
    sessionIds: string[],
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<
    Record<
      string,
      {
        known: boolean;
        mainRunning: boolean;
        subagentRunning: boolean;
        running: boolean;
        rootRunId?: string;
      }
    >
  > {
    if (this.runtime.getSessionRuntimeStatuses) {
      return this.runtime.getSessionRuntimeStatuses(sessionIds, options);
    }
    const entries = await Promise.all(
      sessionIds.map(
        async sessionId =>
          [sessionId, await this.getSessionRuntimeStatus(sessionId, options)] as const,
      ),
    );
    return Object.fromEntries(entries);
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
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            total?: number;
          };
        },
      ) => {
        this.emit('messageMetadataUpdate', sessionId, messageId, metadata, extra);
      },
    );

    runtime.on('messageDelete', (sessionId, messageId) => {
      this.emit('messageDelete', sessionId, messageId);
    });

    runtime.on('complete', (sessionId, finalStatus) => {
      this.emit('complete', sessionId, finalStatus);
    });

    runtime.on('error', (sessionId, error) => {
      this.emit('error', sessionId, error);
    });

    runtime.on('sessionStopped', sessionId => {
      this.emit('sessionStopped', sessionId);
    });

    runtime.on('cronChanged', payload => {
      this.emit('cronChanged', payload);
    });
  }
}
