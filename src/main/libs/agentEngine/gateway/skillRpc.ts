import type {
  ClawHubDetail,
  ClawHubSearchResult,
  GatewaySkillStatus,
  SkillInstallParams,
  SkillRpcResult,
  SkillUpdateParams,
} from '../types';
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

  async install(params: SkillInstallParams): Promise<SkillRpcResult> {
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

  async search(query?: string, limit?: number): Promise<ClawHubSearchResult[]> {
    await this.callbacks.ensureGatewayClientReady();
    const result = await this.callbacks
      .requireGatewayClient()
      .request<{ results?: ClawHubSearchResult[] }>('skills.search', {
        query,
        limit: limit || 20,
      });
    console.log(
      '[OpenClawRuntime] searchClawHubSkills: received',
      result.results?.length || 0,
      'results',
    );
    return result.results || [];
  }

  async getDetail(slug: string): Promise<ClawHubDetail | null> {
    await this.callbacks.ensureGatewayClientReady();
    const result = await this.callbacks
      .requireGatewayClient()
      .request<ClawHubDetail>('skills.detail', { slug });
    console.log('[OpenClawRuntime] getClawHubSkillDetail: slug=', slug, 'result=', result);
    return result;
  }
}
