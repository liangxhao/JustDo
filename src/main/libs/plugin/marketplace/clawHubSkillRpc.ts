import type { ClawHubSkillDetail, ClawHubSkillSearchResult } from './clawHubSkillTypes';

export interface ClawHubSkillGateway {
  requestGateway<T>(method: string, params?: unknown): Promise<T>;
}

export class ClawHubSkillRpc {
  constructor(private readonly gateway: ClawHubSkillGateway) {}

  async search(query?: string, limit?: number): Promise<ClawHubSkillSearchResult[]> {
    const result = await this.gateway.requestGateway<{ results?: ClawHubSkillSearchResult[] }>(
      'skills.search',
      {
        query,
        limit: limit || 20,
      },
    );
    console.log('[PluginMarketplace] search ClawHub skills: received', result.results?.length || 0);
    return result.results || [];
  }

  async getDetail(slug: string): Promise<ClawHubSkillDetail | null> {
    const result = await this.gateway.requestGateway<ClawHubSkillDetail>('skills.detail', { slug });
    console.log('[PluginMarketplace] get ClawHub skill detail: slug=', slug, 'result=', result);
    return result;
  }
}
