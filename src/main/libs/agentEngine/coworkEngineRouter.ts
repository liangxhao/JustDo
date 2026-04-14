import { EventEmitter } from 'events';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
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
  claudeRuntime: CoworkRuntime;
};

export class CoworkEngineRouter extends EventEmitter implements CoworkRuntime {
  private readonly getCurrentEngine: () => CoworkAgentEngine;
  private readonly runtimeByEngine: Record<CoworkAgentEngine, CoworkRuntime>;
  private readonly sessionEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestEngine = new Map<string, CoworkAgentEngine>();
  private readonly requestSession = new Map<string, string>();
  private currentEngine: CoworkAgentEngine;

  constructor(deps: RouterDeps) {
    super();
    this.getCurrentEngine = deps.getCurrentEngine;
    this.runtimeByEngine = {
      openclaw: deps.openclawRuntime,
      yd_cowork: deps.claudeRuntime,
    };
    this.currentEngine = this.safeResolveEngine();

    this.bindRuntimeEvents('openclaw', deps.openclawRuntime);
    this.bindRuntimeEvents('yd_cowork', deps.claudeRuntime);
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
      await this.runtimeByEngine[engine].startSession(sessionId, prompt, options);
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
      await this.runtimeByEngine[engine].continueSession(sessionId, prompt, options);
    } catch (error) {
      this.sessionEngine.delete(sessionId);
      this.clearRequestEngineBySession(sessionId);
      throw error;
    }
  }

  stopSession(sessionId: string): void {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      this.runtimeByEngine[engine].stopSession(sessionId);
    } else {
      this.runtimeByEngine.openclaw.stopSession(sessionId);
      this.runtimeByEngine.yd_cowork.stopSession(sessionId);
    }
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
  }

  stopAllSessions(): void {
    this.runtimeByEngine.openclaw.stopAllSessions();
    this.runtimeByEngine.yd_cowork.stopAllSessions();
    this.sessionEngine.clear();
    this.requestEngine.clear();
    this.requestSession.clear();
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const engine = this.requestEngine.get(requestId);
    if (engine) {
      this.runtimeByEngine[engine].respondToPermission(requestId, result);
      if (result.behavior === 'allow' || result.behavior === 'deny') {
        this.requestEngine.delete(requestId);
        this.requestSession.delete(requestId);
      }
      return;
    }

    this.runtimeByEngine.openclaw.respondToPermission(requestId, result);
    this.runtimeByEngine.yd_cowork.respondToPermission(requestId, result);
  }

  isSessionActive(sessionId: string): boolean {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      return this.runtimeByEngine[engine].isSessionActive(sessionId);
    }
    return (
      this.runtimeByEngine.openclaw.isSessionActive(sessionId) ||
      this.runtimeByEngine.yd_cowork.isSessionActive(sessionId)
    );
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    const engine = this.sessionEngine.get(sessionId);
    if (engine) {
      return this.runtimeByEngine[engine].getSessionConfirmationMode(sessionId);
    }
    return (
      this.runtimeByEngine.openclaw.getSessionConfirmationMode(sessionId) ??
      this.runtimeByEngine.yd_cowork.getSessionConfirmationMode(sessionId)
    );
  }

  onSessionDeleted(sessionId: string): void {
    this.sessionEngine.delete(sessionId);
    this.clearRequestEngineBySession(sessionId);
    for (const runtime of Object.values(this.runtimeByEngine)) {
      runtime.onSessionDeleted?.(sessionId);
    }
  }

  handleEngineConfigChanged(nextEngine: CoworkAgentEngine): void {
    if (nextEngine === this.currentEngine) {
      return;
    }

    this.currentEngine = nextEngine;
    const activeSessionIds = Array.from(this.sessionEngine.keys()).filter(
      sessionId =>
        this.runtimeByEngine.openclaw.isSessionActive(sessionId) ||
        this.runtimeByEngine.yd_cowork.isSessionActive(sessionId),
    );
    this.stopAllSessions();

    activeSessionIds.forEach(sessionId => {
      this.emit('error', sessionId, ENGINE_SWITCHED_CODE);
    });
  }

  private bindRuntimeEvents(engine: CoworkAgentEngine, runtime: CoworkRuntime): void {
    runtime.on('message', (sessionId, message) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('message', sessionId, message);
    });

    runtime.on('messageUpdate', (sessionId, messageId, content) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('messageUpdate', sessionId, messageId, content);
    });

    runtime.on('thinkingUpdate', (sessionId, messageId, thinkingDelta) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('thinkingUpdate', sessionId, messageId, thinkingDelta);
    });

    runtime.on('messageMetadataUpdate', (sessionId, messageId, metadata) => {
      this.sessionEngine.set(sessionId, engine);
      this.emit('messageMetadataUpdate', sessionId, messageId, metadata);
    });

    runtime.on('permissionRequest', (sessionId, request) => {
      this.sessionEngine.set(sessionId, engine);
      this.requestEngine.set(request.requestId, engine);
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
    if (nextEngine === 'yd_cowork' || nextEngine === 'openclaw') {
      this.currentEngine = nextEngine;
      return nextEngine;
    }
    this.currentEngine = 'openclaw';
    return 'openclaw';
  }

  /**
   * Generate a session title using the configured model via Gateway.
   * Delegates to the OpenClaw runtime which has Gateway access.
   * Falls back to Claude runtime if OpenClaw doesn't implement it.
   */
  async generateTitle(userIntent: string | null, timeoutMs?: number): Promise<string> {
    console.log(
      '[Router] generateTitle: called, openclaw.hasMethod=',
      !!this.runtimeByEngine.openclaw.generateTitle,
      'yd_cowork.hasMethod=',
      !!this.runtimeByEngine.yd_cowork.generateTitle,
    );
    // Try OpenClaw runtime first (has Gateway access)
    if (this.runtimeByEngine.openclaw.generateTitle) {
      console.log('[Router] generateTitle: delegating to openclaw runtime...');
      const result = await this.runtimeByEngine.openclaw.generateTitle(userIntent, timeoutMs);
      console.log('[Router] generateTitle: openclaw result=', result);
      return result;
    }
    // Fallback to Claude runtime if available
    if (this.runtimeByEngine.yd_cowork.generateTitle) {
      console.log('[Router] generateTitle: delegating to yd_cowork runtime...');
      return this.runtimeByEngine.yd_cowork.generateTitle(userIntent, timeoutMs);
    }
    // Return fallback if neither runtime implements generateTitle
    console.log('[Router] generateTitle: no runtime implements generateTitle, using fallback');
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
}
