import { normalizeModelRef, readModelRef } from '../../../shared/openclaw/modelRef';
import type { CoworkStore } from '../../data/coworkStore';
import type { GatewayClientLike } from './types';

export type SessionModelApplyTarget = 'next-turn' | 'subsequent-calls';

export type SessionModelResult =
  | {
      ok: true;
      modelRef: string;
      appliesTo: SessionModelApplyTarget;
      source: 'gateway' | 'local-cache' | 'agent-default';
    }
  | {
      ok: false;
      error: string;
      modelRef?: string;
      source?: 'gateway' | 'local-cache' | 'agent-default';
    };

export interface SessionRpcCallbacks {
  getGatewayClient(): GatewayClientLike | null;
  store: CoworkStore;
}

export class SessionRpc {
  private readonly modelUpdateTails = new Map<string, Promise<void>>();

  constructor(private readonly callbacks: SessionRpcCallbacks) {}

  private sessionKey(sessionId: string, agentId?: string): string {
    const session = this.callbacks.store.getSession(sessionId);
    const effectiveAgentId = agentId || session?.agentId || 'main';
    return `agent:${effectiveAgentId}:justdo:${sessionId}`;
  }

  private async describeModel(
    client: GatewayClientLike,
    sessionId: string,
    agentId?: string,
  ): Promise<string | null> {
    const result = await client.request<{ session?: Record<string, unknown> | null }>(
      'sessions.describe',
      { key: this.sessionKey(sessionId, agentId) },
    );
    return readModelRef(result.session);
  }

  private enqueueModelUpdate(
    sessionId: string,
    task: () => Promise<SessionModelResult>,
    rejectBarrierOnFailure = true,
  ): Promise<SessionModelResult> {
    const previous = this.modelUpdateTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const tail = result.then(value => {
      if (rejectBarrierOnFailure && 'error' in value) throw new Error(value.error);
    });
    this.modelUpdateTails.set(sessionId, tail);
    void tail.catch(() => {});
    void tail.then(
      () => {
        if (this.modelUpdateTails.get(sessionId) === tail) this.modelUpdateTails.delete(sessionId);
      },
      () => {
        if (this.modelUpdateTails.get(sessionId) === tail) this.modelUpdateTails.delete(sessionId);
      },
    );
    return result;
  }

  async waitForModelUpdate(sessionId: string): Promise<void> {
    await (this.modelUpdateTails.get(sessionId) ?? Promise.resolve());
  }

  async getModel(sessionId: string, agentId?: string): Promise<SessionModelResult> {
    return this.enqueueModelUpdate(sessionId, async () => {
      const client = this.callbacks.getGatewayClient();
      if (client) {
        try {
          const modelRef = await this.describeModel(client, sessionId, agentId);
          if (modelRef) {
            this.callbacks.store.updateSession(sessionId, { modelRef });
            return { ok: true, modelRef, appliesTo: 'next-turn', source: 'gateway' };
          }
        } catch {
          // Fall through to the last confirmed local value.
        }
      }

      const session = this.callbacks.store.getSession(sessionId);
      const fallback =
        session?.modelRef || this.callbacks.store.getAgent(session?.agentId || 'main')?.model;
      const modelRef = normalizeModelRef(fallback);
      return modelRef
        ? {
            ok: true,
            modelRef,
            appliesTo: 'next-turn',
            source: session?.modelRef ? 'local-cache' : 'agent-default',
          }
        : { ok: false, error: 'Session model is not available' };
    }, false);
  }

  async patchModel(
    sessionId: string,
    model: string,
    agentId?: string,
    appliesTo: SessionModelApplyTarget = 'next-turn',
  ): Promise<SessionModelResult> {
    const normalizedModel = normalizeModelRef(model);
    if (!normalizedModel) {
      return { ok: false, error: 'Model reference is required' };
    }

    return this.enqueueModelUpdate(sessionId, async () => {
      const client = this.callbacks.getGatewayClient();
      if (!client) return { ok: false, error: 'OpenClaw gateway client not connected' };

      const session = this.callbacks.store.getSession(sessionId);
      if (!session) return { ok: false, error: 'Session not found' };
      const sessionKey = this.sessionKey(sessionId, agentId);

      console.log(
        '[OpenClawRuntime] patchSessionModel: sessionId=%s, key=%s, model=%s',
        sessionId,
        sessionKey,
        normalizedModel,
      );

      try {
        await client.request('sessions.patch', { key: sessionKey, model: normalizedModel });
        const confirmedModelRef = await this.describeModel(client, sessionId, agentId);
        if (!confirmedModelRef) {
          return { ok: false, error: 'Gateway did not return the current session model' };
        }
        this.callbacks.store.updateSession(sessionId, { modelRef: confirmedModelRef });
        return { ok: true, modelRef: confirmedModelRef, appliesTo, source: 'gateway' };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        let currentModelRef: string | undefined;
        try {
          currentModelRef = (await this.describeModel(client, sessionId, agentId)) ?? undefined;
          if (currentModelRef) this.callbacks.store.updateSession(sessionId, { modelRef: currentModelRef });
        } catch {
          // The patch failure is already actionable; do not hide it behind recovery errors.
        }
        console.warn('[OpenClawRuntime] patchSessionModel: failed:', errorMsg);
        return {
          ok: false,
          error: errorMsg,
          ...(currentModelRef ? { modelRef: currentModelRef, source: 'gateway' as const } : {}),
        };
      }
    });
  }
}
