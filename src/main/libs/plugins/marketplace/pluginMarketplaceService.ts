import type {
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePlugin,
  MarketplacePluginDetail,
  MarketplaceQuery,
} from '../../../../shared/pluginMarketplace';
import type { PluginMarketplaceProvider } from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class PluginMarketplaceService {
  private readonly providers: Map<string, PluginMarketplaceProvider>;

  constructor(providers: PluginMarketplaceProvider[]) {
    this.providers = new Map(providers.map(provider => [provider.source.id, provider]));
  }

  async search(query: MarketplaceQuery): Promise<MarketplacePlugin[]> {
    const normalized = {
      ...query,
      query: query.query?.trim() || undefined,
      limit: Math.min(Math.max(query.limit || DEFAULT_LIMIT, 1), MAX_LIMIT),
    };
    const results = await Promise.all(
      [...this.providers.values()]
        .filter(provider => provider.source.supportedKinds.includes(query.kind))
        .map(provider => provider.search(normalized)),
    );
    return results.flat();
  }

  async install(request: MarketplaceInstallRequest): Promise<void> {
    const provider = this.requireProviderForKind(request.sourceId, request.kind);
    await provider.install({
      ...request,
      pluginId: this.requirePluginId(request.pluginId),
      version: request.version?.trim() || undefined,
    });
  }

  async getDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null> {
    const provider = this.requireProviderForKind(request.sourceId, request.kind);
    return provider.getDetail({
      ...request,
      pluginId: this.requirePluginId(request.pluginId),
    });
  }

  private requirePluginId(pluginId: string): string {
    const normalized = pluginId.trim();
    if (!normalized) {
      throw new Error('Plugin id is required');
    }
    return normalized;
  }

  private requireProvider(sourceId: string): PluginMarketplaceProvider {
    const provider = this.providers.get(sourceId);
    if (!provider) {
      throw new Error(`Unknown marketplace source: ${sourceId}`);
    }
    return provider;
  }

  private requireProviderForKind(
    sourceId: string,
    kind: MarketplaceInstallRequest['kind'],
  ): PluginMarketplaceProvider {
    const provider = this.requireProvider(sourceId);
    if (!provider.source.supportedKinds.includes(kind)) {
      throw new Error(`Marketplace source does not support ${kind}`);
    }
    return provider;
  }
}
