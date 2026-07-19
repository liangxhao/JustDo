import type {
  MarketplaceDetailRequest,
  MarketplaceInstallRequest,
  MarketplacePlugin,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceSearchResult,
  MarketplaceSource,
} from '../../../shared/plugins/marketplace';
import {
  MarketplaceErrorCode,
  MarketplaceInstallOperation,
  MarketplaceInstallState,
  PluginKind,
} from '../../../shared/plugins/marketplace';
import { MarketplaceError, type PluginMarketplaceProvider } from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const installStates = new Set<string>(Object.values(MarketplaceInstallState));
const pluginKinds = new Set<string>(Object.values(PluginKind));

export class PluginMarketplaceService {
  private readonly providers: Map<string, PluginMarketplaceProvider>;

  constructor(providers: PluginMarketplaceProvider[]) {
    this.providers = new Map();
    for (const provider of providers) {
      const source = provider.source;
      const sourceValid =
        typeof source?.id === 'string' &&
        source.id.length <= 256 &&
        Boolean(source.id.trim()) &&
        source.id === source.id.trim() &&
        typeof source.name === 'string' &&
        source.name.length <= 256 &&
        Boolean(source.name.trim()) &&
        Array.isArray(source.supportedKinds) &&
        source.supportedKinds.length > 0 &&
        source.supportedKinds.every(kind => pluginKinds.has(kind));
      if (!sourceValid) {
        throw new MarketplaceError(
          MarketplaceErrorCode.INVALID_REQUEST,
          'Marketplace source id is invalid',
        );
      }
      if (this.providers.has(provider.source.id)) {
        throw new MarketplaceError(
          MarketplaceErrorCode.INVALID_REQUEST,
          `Duplicate marketplace source: ${provider.source.id}`,
        );
      }
      this.providers.set(provider.source.id, provider);
    }
  }

  listSources(kind?: MarketplaceQuery['kind']): MarketplaceSource[] {
    return [...this.providers.values()]
      .filter(provider => !kind || provider.source.supportedKinds.includes(kind))
      .map(provider => ({
        id: provider.source.id,
        name: provider.source.name,
        supportedKinds: [...provider.source.supportedKinds],
      }));
  }

  async search(query: MarketplaceQuery): Promise<MarketplaceSearchResult> {
    const normalized = {
      ...query,
      query: query.query?.trim() || undefined,
      limit: Math.floor(Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)),
    };
    const providers = query.sourceId
      ? [this.requireProviderForKind(query.sourceId, query.kind)]
      : [...this.providers.values()].filter(provider =>
          provider.source.supportedKinds.includes(query.kind),
        );
    if (query.cursor && providers.length !== 1) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_REQUEST,
        'Marketplace pagination requires exactly one source',
      );
    }
    const results = await Promise.all(
      providers.map(async provider => ({
        provider,
        result: await this.callProvider(() => provider.search(normalized), 'search'),
      })),
    );
    const seenPluginIds = new Set<string>();
    for (const { result } of results) {
      const resultValid =
        result !== null &&
        typeof result === 'object' &&
        Array.isArray(result.items) &&
        (result.nextCursor === undefined ||
          (typeof result.nextCursor === 'string' && result.nextCursor.length <= 4_096));
      if (!resultValid) {
        throw new MarketplaceError(
          MarketplaceErrorCode.INVALID_RESPONSE,
          'Marketplace source returned an invalid response',
        );
      }
    }
    return {
      items: results.flatMap(({ provider, result }) =>
        result.items.map(item => {
          const normalizedItem = this.normalizePlugin(item, query.kind, provider.source.id);
          const pluginKey = `${normalizedItem.kind}:${normalizedItem.id.toLowerCase()}`;
          if (seenPluginIds.has(pluginKey)) {
            throw new MarketplaceError(
              MarketplaceErrorCode.INVALID_RESPONSE,
              'Marketplace sources returned duplicate plugin ids',
            );
          }
          seenPluginIds.add(pluginKey);
          return normalizedItem;
        }),
      ),
      nextCursor: results.length === 1 ? results[0].result.nextCursor : undefined,
    };
  }

  async install(request: MarketplaceInstallRequest): Promise<void> {
    const provider = this.requireProviderForKind(request.sourceId, request.kind);
    const pluginId = this.requirePluginId(request.pluginId);
    await this.callProvider(
      () =>
        provider.install({
          ...request,
          pluginId,
          version: request.version?.trim() || undefined,
          operation: request.operation ?? MarketplaceInstallOperation.INSTALL,
        }),
      'install',
    );
  }

  async getDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null> {
    const provider = this.requireProviderForKind(request.sourceId, request.kind);
    const pluginId = this.requirePluginId(request.pluginId);
    const detail = await this.callProvider(
      () => provider.getDetail({ ...request, pluginId }),
      'load details',
    );
    if (!detail) return null;
    const normalized = this.normalizePlugin(detail, request.kind, provider.source.id);
    const readmeValid =
      detail.readme === undefined ||
      (typeof detail.readme === 'string' && detail.readme.length <= 1_000_000);
    const requirementsValid =
      detail.requirements === undefined ||
      (detail.requirements !== null &&
        typeof detail.requirements === 'object' &&
        (detail.requirements.bins === undefined ||
          (Array.isArray(detail.requirements.bins) &&
            detail.requirements.bins.length <= 100 &&
            detail.requirements.bins.every(
              item => typeof item === 'string' && item.length <= 256,
            ))) &&
        (detail.requirements.env === undefined ||
          (Array.isArray(detail.requirements.env) &&
            detail.requirements.env.length <= 100 &&
            detail.requirements.env.every(
              item => typeof item === 'string' && item.length <= 256,
            ))));
    if (!readmeValid || !requirementsValid) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_RESPONSE,
        'Marketplace source returned an invalid response',
      );
    }
    return {
      ...normalized,
      readme: detail.readme,
      requirements: detail.requirements
        ? {
            bins: detail.requirements.bins ? [...detail.requirements.bins] : undefined,
            env: detail.requirements.env ? [...detail.requirements.env] : undefined,
          }
        : undefined,
    };
  }

  private requirePluginId(pluginId: string): string {
    const normalized = pluginId.trim();
    if (!normalized) {
      throw new MarketplaceError(MarketplaceErrorCode.INVALID_REQUEST, 'Plugin id is required');
    }
    return normalized;
  }

  private requireProvider(sourceId: string): PluginMarketplaceProvider {
    const provider = this.providers.get(sourceId);
    if (!provider) {
      throw new MarketplaceError(
        MarketplaceErrorCode.SOURCE_NOT_FOUND,
        'Unknown marketplace source',
      );
    }
    return provider;
  }

  private requireProviderForKind(
    sourceId: string,
    kind: MarketplaceInstallRequest['kind'],
  ): PluginMarketplaceProvider {
    const provider = this.requireProvider(sourceId);
    if (!provider.source.supportedKinds.includes(kind)) {
      throw new MarketplaceError(
        MarketplaceErrorCode.UNSUPPORTED_KIND,
        `Marketplace source does not support ${kind}`,
      );
    }
    return provider;
  }

  private async callProvider<T>(operation: () => Promise<T>, label: string): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new MarketplaceError(
        MarketplaceErrorCode.PROVIDER_FAILURE,
        `Marketplace provider failed to ${label}`,
      );
    }
  }

  private normalizePlugin(
    item: MarketplacePlugin,
    expectedKind: MarketplaceQuery['kind'],
    sourceId: string,
  ): MarketplacePlugin {
    const requiredText: Array<[unknown, number]> = [
      [item?.id, 256],
      [item?.name, 256],
      [item?.description, 4_000],
    ];
    const optionalText: Array<[unknown, number]> = [
      [item?.version, 128],
      [item?.author, 256],
      [item?.homepage, 2_048],
      [item?.iconUrl, 2_048],
      [item?.installedVersion, 128],
    ];
    const valid =
      item?.kind === expectedKind &&
      requiredText.every(
        ([value, maxLength]) =>
          typeof value === 'string' && Boolean(value.trim()) && value.length <= maxLength,
      ) &&
      optionalText.every(
        ([value, maxLength]) =>
          value === undefined || (typeof value === 'string' && value.length <= maxLength),
      ) &&
      (item.tags === undefined ||
        (Array.isArray(item.tags) &&
          item.tags.length <= 50 &&
          item.tags.every(tag => typeof tag === 'string' && tag.length <= 100))) &&
      (item.installState === undefined || installStates.has(item.installState));
    if (!valid) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_RESPONSE,
        'Marketplace source returned an invalid response',
      );
    }
    return {
      id: item.id.trim(),
      kind: item.kind,
      name: item.name.trim(),
      description: item.description.trim(),
      version: item.version,
      author: item.author,
      tags: item.tags ? [...item.tags] : undefined,
      homepage: item.homepage,
      iconUrl: item.iconUrl,
      sourceId,
      installState: item.installState,
      installedVersion: item.installedVersion,
    };
  }
}
