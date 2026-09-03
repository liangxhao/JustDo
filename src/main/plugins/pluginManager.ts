import type {
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceSearchResult,
  MarketplaceSource,
} from '../../shared/plugins/marketplace';
import type { PluginInstallResult } from './installation';
import type { PluginMarketplaceService } from './marketplace';

/**
 * Application boundary for plugin management.
 *
 * Installed-plugin adapters (OpenClaw and local MCP storage) and
 * marketplace providers meet here so renderer code never depends on either.
 */
export class PluginManager {
  constructor(private readonly marketplace: PluginMarketplaceService) {}

  listMarketplaceSources(kind?: MarketplaceQuery['kind']): MarketplaceSource[] {
    return this.marketplace.listSources(kind);
  }

  searchMarketplace(query: MarketplaceQuery): Promise<MarketplaceSearchResult> {
    return this.marketplace.search(query);
  }

  installFromMarketplace(request: MarketplaceInstallRequest): Promise<PluginInstallResult> {
    return this.marketplace.install(request);
  }

  getMarketplaceDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null> {
    return this.marketplace.getDetail(request);
  }
}
