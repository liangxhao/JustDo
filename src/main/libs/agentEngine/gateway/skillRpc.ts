import type { GatewaySkillStatus, SkillRpcResult, SkillUpdateParams } from '../types';
import type { GatewayClientLike } from './types';

export interface SkillRpcCallbacks {
  ensureGatewayClientReady(): Promise<void>;
  requireGatewayClient(): GatewayClientLike;
}

export class SkillRpc {
  constructor(private readonly callbacks: SkillRpcCallbacks) {}

  async getStatus(agentId?: string): Promise<GatewaySkillStatus> {
    await this.callbacks.ensureGatewayClientReady();
    return this.callbacks.requireGatewayClient().request('skills.status', { agentId });
  }

  async install(params: unknown): Promise<SkillRpcResult> {
    await this.callbacks.ensureGatewayClientReady();
    console.log('[OpenClawRuntime] installSkill: params=', params);
    const result = await this.callbacks
      .requireGatewayClient()
      .request<SkillRpcResult>('skills.install', params);
    console.log('[OpenClawRuntime] installSkill: result=', result);
    return result;
  }

  async updateConfig(params: SkillUpdateParams): Promise<SkillRpcResult> {
    await this.callbacks.ensureGatewayClientReady();
    console.log(
      '[OpenClawRuntime] updateSkillConfig: skillKey=',
      params.skillKey,
      'enabled=',
      params.enabled,
    );
    const result = await this.callbacks
      .requireGatewayClient()
      .request<SkillRpcResult>('skills.update', params);
    console.log('[OpenClawRuntime] updateSkillConfig: result=', result);
    return result;
  }
}
