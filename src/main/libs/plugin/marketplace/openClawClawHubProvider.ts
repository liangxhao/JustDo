import {
  type MarketplaceDetailRequest,
  type MarketplaceInstallRequest,
  type MarketplacePlugin,
  type MarketplacePluginDetail,
  type MarketplaceQuery,
  MarketplaceSourceId,
  PluginKind,
} from '../../../../shared/pluginMarketplace';
import type { OpenClawRuntimeAdapter } from '../../agentEngine/openclawRuntimeAdapter';
import type { PluginMarketplaceProvider } from './types';

export type OpenClawRuntimeAdapterResolver = () => OpenClawRuntimeAdapter | null;

export class OpenClawClawHubProvider implements PluginMarketplaceProvider {
  readonly source = {
    id: MarketplaceSourceId.CLAWHUB,
    name: 'ClawHub',
    supportedKinds: [PluginKind.SKILL],
  };

  constructor(private readonly resolveAdapter: OpenClawRuntimeAdapterResolver) {}

  async search(query: MarketplaceQuery): Promise<MarketplacePlugin[]> {
    if (query.kind !== PluginKind.SKILL) return [];
    const skills = await this.requireAdapter().searchClawHubSkills(query.query, query.limit);
    return skills.map(skill => ({
      id: skill.slug,
      kind: PluginKind.SKILL,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      tags: skill.tags,
      homepage: skill.homepage,
      sourceId: this.source.id,
    }));
  }

  async getDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null> {
    this.requireSkill(request.kind);
    const skill = await this.requireAdapter().getClawHubSkillDetail(request.pluginId);
    if (!skill) return null;
    return {
      id: skill.slug,
      kind: PluginKind.SKILL,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      tags: skill.tags,
      homepage: skill.homepage,
      sourceId: this.source.id,
      readme: skill.readme,
      requirements: skill.install?.requires,
    };
  }

  async install(request: MarketplaceInstallRequest): Promise<void> {
    this.requireSkill(request.kind);
    const result = await this.requireAdapter().installSkill({
      source: 'clawhub',
      slug: request.pluginId,
      version: request.version,
      force: request.force,
    });
    if (!result.ok) {
      throw new Error(result.error || 'Failed to install skill');
    }
  }

  private requireSkill(kind: string): void {
    if (kind !== PluginKind.SKILL) {
      throw new Error(`${kind} installation is not available from ClawHub yet`);
    }
  }

  private requireAdapter(): OpenClawRuntimeAdapter {
    const adapter = this.resolveAdapter();
    if (!adapter) {
      throw new Error('Gateway not connected');
    }
    return adapter;
  }
}
