import { EventEmitter } from 'events';
import type { PermissionResult } from './types';
import type {
  CoworkAgentEngine,
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
} from './types';
import { ENGINE_SWITCHED_CODE } from './types';

type RouterDeps = {
  getCurrentEngine: () => CoworkAgentEngine;
  openclawRuntime: CoworkRuntime;
};

export class CoworkEngineRouter extends EventEmitter implements CoworkRuntime {
  private readonly getCurrentEngine: () => CoworkAgentEngine;
  private readonly runtime: CoworkRuntime;
  private readonly sessionEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestSession = new Map<string, string>();
  private currentEngine: CoworkAgentEngine;

  constructor(deps: RouterDeps) {
    super();
    this.getCurrentEngine = deps.getCurrentEngine;
    this.runtime = deps.openclawRuntime;
    this.currentEngine = 'openclaw';

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
    const engine = this.safeResolveEngine();
    this.sessionEngine.set(sessionId, engine);
    try {
      await this.runtime.startSession(sessionId, prompt, options);
    } catch (error) {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: CoworkContinueOptions = {},
  ): Promise<void> {
    const engine = this.safeResolveEngine();
    this.sessionEngine.set(sessionId, engine);
    try {
      await this.runtime.continueSession(sessionId, prompt, options);
    } catch (error) {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  stopSession(sessionId: string): void {
    this.runtime.stopSession(sessionId);
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
  }

  stopAllSessions(): void {
    this.runtime.stopAllSessions();
    this.sessionEngine.clear();
    this.requestEngine.clear();
    this.requestSession.clear();
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const engine = this.requestEngine.get(requestId);
    if (engine) {
      this.runtime.respondToPermission(requestId, result);
      if (result.behavior === 'allow' || result.behavior === 'deny') {
        this.requestEngine.delete(requestId);
        this.requestSession.delete(requestId);
      }
      return;
    }

    this.runtime.respondToPermission(requestId, result);
  }

  isSessionActive(sessionId: string): boolean {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      return this.runtime.isSessionActive(sessionId);
    }
    return this.runtime.isSessionActive(sessionId);
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      return this.runtime.getSessionConfirmationMode(sessionId);
    }
    return this.runtime.getSessionConfirmationMode(sessionId);
  }

  onSessionDeleted(sessionId: string, agentId?: string): void {
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
    this.runtime.onSessionDeleted?.(sessionId, agentId);
  }

  handleEngineConfigChanged(nextEngine: CoworkAgentEngine): void {
    if (nextEngine === this.currentEngine) {
      return;
    }

    this.currentEngine = nextEngine;
    const activeSessionIds = Array.from(this.sessionEngine.keys()).filter(sessionId =>
      this.runtime.isSessionActive(sessionId),
    );
    this.stopAllSessions();

    activeSessionIds.forEach(sessionId => {
      this.emit('error', sessionId, ENGINE_SWITCHED_CODE);
    });
  }

  private bindRuntimeEvents(runtime: CoworkRuntime): void {
    runtime.on('message', (sessionId, message) => {
      this.sessionEngine.set(sessionId, 'openclaw');
      this.emit('message', sessionId, message);
    });

    runtime.on('messageUpdate', (sessionId, messageId, content) => {
      this.sessionEngine.set(sessionId, 'openclaw');
      this.emit('messageUpdate', sessionId, messageId, content);
    });

    runtime.on('thinkingUpdate', (sessionId, messageId, thinkingDelta) => {
      this.sessionEngine.set(sessionId, 'openclaw');
      this.emit('thinkingUpdate', sessionId, messageId, thinkingDelta);
    });

    runtime.on('messageMetadataUpdate', (sessionId, messageId, metadata) => {
      this.sessionEngine.set(sessionId, 'openclaw');
      this.emit('messageMetadataUpdate', sessionId, messageId, metadata);
    });

    runtime.on('permissionRequest', (sessionId, request) => {
      this.sessionEngine.set(sessionId, 'openclaw');
      this.requestEngine.set(request.requestId, 'openclaw');
      this.requestSession.set(request.requestId, sessionId);
      this.emit('permissionRequest', sessionId, request);
    });

    runtime.on('complete', (sessionId, claudeSessionId) => {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      this.emit('complete', sessionId, claudeSessionId);
    });

    runtime.on('error', (sessionId, error) => {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      this.emit('error', sessionId, error);
    });

    runtime.on('sessionStopped', sessionId => {
      this.emit('sessionStopped', sessionId);
    });
  }

  private clearRequestEngineBySession(sessionId: string): void {
    for (const [requestId, requestSessionId] of this.requestSession.entries()) {
      if (requestSessionId !== sessionId) continue;
      this.requestSession.delete(requestId);
      this.requestEngine.delete(requestId);
    }
  }

  private safeResolveEngine(): CoworkAgentEngine {
    const nextEngine = this.getCurrentEngine();
    if (nextEngine === 'openclaw') {
      this.currentEngine = nextEngine;
      return nextEngine;
    }
    this.currentEngine = 'openclaw';
    return 'openclaw';
  }

  /**
   * Generate a session title using the configured model via Gateway.
   * Delegates to the OpenClaw runtime which has Gateway access.
   */
  async generateTitle(userIntent: string | null, timeoutMs?: number): Promise<string> {
    console.log(
      '[Router] generateTitle: called, openclaw.hasMethod=',
      !!this.runtime.generateTitle,
    );
    // Try OpenClaw runtime (has Gateway access)
    if (this.runtime.generateTitle) {
      console.log('[Router] generateTitle: delegating to openclaw runtime...');
      const result = await this.runtime.generateTitle(userIntent, timeoutMs);
      console.log('[Router] generateTitle: openclaw result=', result);
      return result;
    }
    // Return fallback if runtime doesn't implement generateTitle
    console.log("[Router] generateTitle: runtime doesn't implement generateTitle, using fallback");
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

  /**
   * Patch the model for an active session via sessions.patch API.
   * Delegates to the OpenClaw runtime which has Gateway access.
   */
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
}
