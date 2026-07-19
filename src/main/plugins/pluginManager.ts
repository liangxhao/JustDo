import type {
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceSearchResult,
  MarketplaceSource,
} from '../../shared/plugins/marketplace';
import type { PluginMarketplaceService } from './marketplace';

/**
 * Application boundary for plugin management.
 *
 * Installed-plugin adapters (OpenClaw, local MCP storage, extension host) and
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

  installFromMarketplace(request: MarketplaceInstallRequest): Promise<void> {
    return this.marketplace.install(request);
  }

  getMarketplaceDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null> {
    return this.marketplace.getDetail(request);
  }
}
