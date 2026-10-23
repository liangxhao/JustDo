import type {
  MarketplaceCategoriesResult,
  MarketplaceCategoryRequest,
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceResolveRequest,
  MarketplaceSearchResult,
  MarketplaceSource,
  MarketplaceUpdateCheckRequest,
  MarketplaceUpdateCheckResult,
} from '../../shared/plugins/marketplace';
import type {
  PluginOperationContext,
  PluginOperationStage,
} from '../../shared/plugins/pluginOperation';
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

  resolveMarketplaceInstalled(request: MarketplaceResolveRequest) {
    return this.marketplace.resolveInstalled(request);
  }

  listMarketplaceSources(kind?: MarketplaceQuery['kind']): MarketplaceSource[] {
    return this.marketplace.listSources(kind);
  }

  listMarketplaceCategories(
    request: MarketplaceCategoryRequest,
  ): Promise<MarketplaceCategoriesResult> {
    return this.marketplace.listCategories(request);
  }

  searchMarketplace(query: MarketplaceQuery): Promise<MarketplaceSearchResult> {
    return this.marketplace.search(query);
  }

  checkMarketplaceUpdates(
    request: MarketplaceUpdateCheckRequest,
  ): Promise<MarketplaceUpdateCheckResult> {
    return this.marketplace.checkUpdates(request);
  }

  installFromMarketplace(
    request: MarketplaceInstallRequest,
    onProgress?: (stage: PluginOperationStage) => void,
    context?: PluginOperationContext,
  ): Promise<PluginInstallResult> {
    return context
      ? this.marketplace.install(request, onProgress, context)
      : this.marketplace.install(request, onProgress);
  }

  forgetMarketplaceInstallation(
    kind: MarketplaceQuery['kind'],
    runtimeId: string,
    installPath?: string,
  ): void {
    this.marketplace.forgetInstallation(kind, runtimeId, installPath);
  }

  getMarketplaceDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null> {
    return this.marketplace.getDetail(request);
  }
}
