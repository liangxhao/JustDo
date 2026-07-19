import type {
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceSearchResult,
  MarketplaceSource,
} from '../../../shared/plugins/marketplace';
import type { MarketplaceErrorCode } from '../../../shared/plugins/marketplace';
import type { PreparedMarketplaceInstall } from '../installation';

export class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

export interface PluginMarketplaceProvider {
  readonly source: MarketplaceSource;
  search(query: MarketplaceQuery): Promise<MarketplaceSearchResult>;
  getDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null>;
  prepareInstall(request: MarketplaceInstallRequest): Promise<PreparedMarketplaceInstall>;
}
