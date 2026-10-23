import type {
  MarketplaceCategory,
  MarketplaceCategoryRequest,
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePlugin,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceSearchResult,
  MarketplaceSource,
  MarketplaceUpdateCheckRequest,
} from '../../../shared/plugins/marketplace';
import type { MarketplaceErrorCode } from '../../../shared/plugins/marketplace';
import type { PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import type { PreparedMarketplaceInstall } from '../installation';

export class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
    readonly failedStage?: PluginOperationStage,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

export interface MarketplacePreparationContext {
  /** Report only work actually entered; omit progress when the SDK cannot expose it. */
  onProgress?: (stage: PluginOperationStage) => void;
}

export interface PluginMarketplaceProvider {
  readonly source: MarketplaceSource;
  search(query: MarketplaceQuery): Promise<MarketplaceSearchResult>;
  /** Optional because some enterprise catalogs expose only keyword search. */
  listCategories?(request: MarketplaceCategoryRequest): Promise<MarketplaceCategory[]>;
  /** Optional bulk status resolver; adapters may implement it using keyword search. */
  checkUpdates?(request: MarketplaceUpdateCheckRequest): Promise<MarketplacePlugin[]>;
  /** Optional because a minimal enterprise SDK may only expose search and download. */
  getDetail?(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null>;
  prepareInstall(
    request: MarketplaceInstallRequest,
    context?: MarketplacePreparationContext,
  ): Promise<PreparedMarketplaceInstall>;
}
