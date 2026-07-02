import type { OpenClawRuntimeAdapter } from '../agentEngine/openclawRuntimeAdapter';
import type {
  MarketplaceInstallOptions,
  MarketplaceInstallResult,
  MarketplaceSearchOptions,
  MarketplaceSkillDetail,
  MarketplaceSkillSummary,
  SkillMarketplaceProvider,
} from './types';
import { SkillMarketplaceProviderKind } from './types';

export type OpenClawRuntimeAdapterResolver = () => OpenClawRuntimeAdapter | null;

export class OpenClawGatewayMarketplaceProvider implements SkillMarketplaceProvider {
  readonly kind = SkillMarketplaceProviderKind.OPENCLAW_GATEWAY;

  constructor(private readonly resolveAdapter: OpenClawRuntimeAdapterResolver) {}

  async search(options: MarketplaceSearchOptions): Promise<MarketplaceSkillSummary[]> {
    return this.requireAdapter().searchClawHubSkills(options.query, options.limit);
  }

  async getDetail(slug: string): Promise<MarketplaceSkillDetail | null> {
    return this.requireAdapter().getClawHubSkillDetail(slug);
  }

  async install(options: MarketplaceInstallOptions): Promise<MarketplaceInstallResult> {
    const result = await this.requireAdapter().installSkill({
      source: 'clawhub',
      slug: options.slug,
      version: options.version,
      force: options.force,
    });
    return { success: result.ok, error: result.error };
  }

  private requireAdapter(): OpenClawRuntimeAdapter {
    const adapter = this.resolveAdapter();
    if (!adapter) {
      throw new Error('Gateway not connected');
    }
    return adapter;
  }
}
