import {
  type MarketplaceDetailRequest,
  type MarketplaceInstallRequest,
  type MarketplacePlugin,
  type MarketplacePluginDetail,
  type MarketplaceQuery,
  MarketplaceSourceId,
  PluginKind,
} from '../../../../shared/pluginMarketplace';
import type { OpenClawSkillService } from '../../openclaw/skills/openclawSkillService';
import { ClawHubSkillRpc } from './clawHubSkillRpc';
import type { PluginMarketplaceProvider } from './types';

export class OpenClawClawHubProvider implements PluginMarketplaceProvider {
  readonly source = {
    id: MarketplaceSourceId.DEFAULT,
    name: 'ClawHub',
    supportedKinds: [PluginKind.SKILL],
  };

  constructor(private readonly skillService: OpenClawSkillService) {}

  async search(query: MarketplaceQuery): Promise<MarketplacePlugin[]> {
    if (query.kind !== PluginKind.SKILL) return [];
    const skills = await this.createSkillRpc().search(query.query, query.limit);
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
    const skill = await this.createSkillRpc().getDetail(request.pluginId);
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
    const result = await this.skillService.install({
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

  private createSkillRpc(): ClawHubSkillRpc {
    return new ClawHubSkillRpc(this.skillService);
  }
}
