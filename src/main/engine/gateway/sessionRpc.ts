import type { CoworkStore } from '../../data/coworkStore';
import type { GatewayClientLike } from './types';

export interface SessionRpcCallbacks {
  getGatewayClient(): GatewayClientLike | null;
  store: CoworkStore;
}

export class SessionRpc {
  constructor(private readonly callbacks: SessionRpcCallbacks) {}

  async patchModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.callbacks.getGatewayClient();
    if (!client) {
      return { ok: false, error: 'OpenClaw gateway client not connected' };
    }

    const session = this.callbacks.store.getSession(sessionId);
    const effectiveAgentId = agentId || session?.agentId || 'main';
    const sessionKey = `agent:${effectiveAgentId}:justdo:${sessionId}`;
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return { ok: false, error: 'Model reference is required' };
    }

    console.log(
      '[OpenClawRuntime] patchSessionModel: sessionId=%s, agentId=%s, key=%s, model=%s',
      sessionId,
      effectiveAgentId,
      sessionKey,
      normalizedModel,
    );

    try {
      await client.request('sessions.patch', { key: sessionKey, model: normalizedModel });
      return { ok: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenClawRuntime] patchSessionModel: failed:', errorMsg);
      return { ok: false, error: errorMsg };
    }
  }
}
