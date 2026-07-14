import type {
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePlugin,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceSource,
} from '../../../shared/plugins/marketplace';

export interface PluginMarketplaceProvider {
  readonly source: MarketplaceSource;
  search(query: MarketplaceQuery): Promise<MarketplacePlugin[]>;
  getDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null>;
  install(request: MarketplaceInstallRequest): Promise<void>;
}
