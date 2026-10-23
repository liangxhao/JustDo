import type {
  MarketplaceCategoriesResult,
  MarketplaceCategory,
  MarketplaceCategoryRequest,
  MarketplaceDetailRequest,
  MarketplaceInstalledPlugin,
  MarketplaceInstallRequest,
  MarketplacePlugin,
  MarketplacePluginDetail,
  MarketplaceQuery,
  MarketplaceResolveRequest,
  MarketplaceSearchResult,
  MarketplaceSource,
  MarketplaceUpdateCheckRequest,
  MarketplaceUpdateCheckResult,
} from '../../../shared/plugins/marketplace';
import {
  MarketplaceErrorCode,
  MarketplaceInstallOperation,
  MarketplaceInstallState,
  MarketplacePluginKind,
} from '../../../shared/plugins/marketplace';
import {
  type PluginOperationContext,
  PluginOperationStage,
  toPluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
import type { PluginInstallResult } from '../installation';
import { PluginInstallationService, PluginInstallOrigin } from '../installation';
import {
  type MarketplaceInstallRecordStore,
  MarketplaceInstallRegistry,
} from './marketplaceInstallRegistry';
import { MarketplaceError, type PluginMarketplaceProvider } from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const installStates = new Set<string>(Object.values(MarketplaceInstallState));
const pluginKinds = new Set<string>(Object.values(MarketplacePluginKind));
const MAX_CATEGORIES = 100;
const operationStages = new Set<string>(Object.values(PluginOperationStage));

export class PluginMarketplaceService {
  private readonly providers: Map<string, PluginMarketplaceProvider>;
  private readonly installTails = new Map<string, Promise<void>>();

  constructor(
    providers: PluginMarketplaceProvider[],
    private readonly installationService: PluginInstallationService = new PluginInstallationService(),
    private readonly installRegistry: MarketplaceInstallRegistry = (() => {
      let value: unknown;
      const store: MarketplaceInstallRecordStore = {
        get: <T>(): T | undefined => value as T | undefined,
        set: <T>(_key: string, next: T): void => {
          value = next;
        },
      };
      return new MarketplaceInstallRegistry(() => store);
    })(),
  ) {
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
        supportsDetail: typeof provider.getDetail === 'function',
        supportsCategories: typeof provider.listCategories === 'function',
        supportsUpdates: typeof provider.checkUpdates === 'function',
      }));
  }

  resolveInstalled(request: MarketplaceResolveRequest) {
    return this.installRegistry.resolve(request);
  }

  async listCategories(request: MarketplaceCategoryRequest): Promise<MarketplaceCategoriesResult> {
    const provider = this.requireProviderForKind(request.sourceId, request.kind);
    if (!provider.listCategories) return { categories: [] };
    const categories = await this.callProvider(
      () => provider.listCategories!(request),
      'list categories',
    );
    if (!Array.isArray(categories) || categories.length > MAX_CATEGORIES) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_RESPONSE,
        'Marketplace source returned invalid categories',
      );
    }
    const seen = new Set<string>();
    return {
      categories: categories.map(category => {
        const normalized = this.normalizeCategory(category);
        const key = normalized.id.toLowerCase();
        if (seen.has(key)) {
          throw new MarketplaceError(
            MarketplaceErrorCode.INVALID_RESPONSE,
            'Marketplace source returned duplicate categories',
          );
        }
        seen.add(key);
        return normalized;
      }),
    };
  }

  async search(query: MarketplaceQuery): Promise<MarketplaceSearchResult> {
    const { categoryId, ...queryWithoutCategory } = query;
    const normalized = {
      ...queryWithoutCategory,
      query: query.query?.trim() || undefined,
      ...(categoryId?.trim() ? { categoryId: categoryId.trim() } : {}),
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

  async checkUpdates(
    request: MarketplaceUpdateCheckRequest,
  ): Promise<MarketplaceUpdateCheckResult> {
    const runtimeInstalled = new Map(request.installed.map(item => [item.id.toLowerCase(), item]));
    const persisted = this.installRegistry
      .list(request.kind)
      .filter(record => runtimeInstalled.has(record.runtimeId.toLowerCase()));
    const providers = [...this.providers.values()].filter(
      provider =>
        provider.source.supportedKinds.includes(request.kind) &&
        typeof provider.checkUpdates === 'function',
    );
    const results = await Promise.all(
      providers.map(async provider => {
        const providerRecords = persisted.filter(record => record.sourceId === provider.source.id);
        const mappedRuntimeIds = new Set(
          providerRecords.map(record => record.runtimeId.toLowerCase()),
        );
        const installed: MarketplaceInstalledPlugin[] = providerRecords.map(record => ({
          id: record.marketplacePluginId,
          runtimeId: record.runtimeId,
          version:
            record.installedVersion ||
            runtimeInstalled.get(record.runtimeId.toLowerCase())?.version,
        }));
        if (providers.length === 1) {
          installed.push(
            ...request.installed.filter(item => !mappedRuntimeIds.has(item.id.toLowerCase())),
          );
        }
        return {
          provider,
          installed,
          updates:
            installed.length === 0
              ? []
              : await this.callProvider(
                  () => provider.checkUpdates!({ kind: request.kind, installed }),
                  'check updates',
                ),
        };
      }),
    );
    const seenInstalledIds = new Set<string>();
    const updates = results.flatMap(({ provider, installed, updates: providerUpdates }) => {
      if (!Array.isArray(providerUpdates) || providerUpdates.length > installed.length) {
        throw new MarketplaceError(
          MarketplaceErrorCode.INVALID_RESPONSE,
          'Marketplace source returned an invalid update response',
        );
      }
      return providerUpdates.map(item => {
        let normalized = this.normalizePlugin(item, request.kind, provider.source.id);
        const matched = installed.find(
          entry =>
            entry.id.toLowerCase() === normalized.id.toLowerCase() ||
            entry.id.toLowerCase() === normalized.runtimeId?.toLowerCase() ||
            (Boolean(entry.runtimeId) &&
              Boolean(normalized.runtimeId) &&
              entry.runtimeId?.toLowerCase() === normalized.runtimeId?.toLowerCase()),
        );
        const installedId = (
          normalized.runtimeId ||
          matched?.runtimeId ||
          normalized.id
        ).toLowerCase();
        if (
          normalized.installState !== MarketplaceInstallState.UPDATE_AVAILABLE ||
          !matched ||
          !runtimeInstalled.has(installedId) ||
          seenInstalledIds.has(installedId)
        ) {
          throw new MarketplaceError(
            MarketplaceErrorCode.INVALID_RESPONSE,
            'Marketplace source returned an invalid update candidate',
          );
        }
        if (!normalized.runtimeId && matched.runtimeId) {
          normalized = { ...normalized, runtimeId: matched.runtimeId };
        }
        seenInstalledIds.add(installedId);
        return normalized;
      });
    });
    return { updates };
  }

  async install(
    request: MarketplaceInstallRequest,
    onProgress?: (stage: PluginOperationStage) => void,
    context?: PluginOperationContext,
  ): Promise<PluginInstallResult> {
    const provider = this.requireProviderForKind(request.sourceId, request.kind);
    const pluginId = this.requirePluginId(request.pluginId);
    const normalizedRequest = {
      ...request,
      pluginId,
      version: request.version?.trim() || undefined,
      operation: request.operation ?? MarketplaceInstallOperation.INSTALL,
    };
    let currentStage: PluginOperationStage | undefined;
    let thrownFailureStage: PluginOperationStage | undefined;
    const reportProgress = (stage: string): void => {
      if (!operationStages.has(stage)) return;
      currentStage = stage as PluginOperationStage;
      try {
        onProgress?.(stage as PluginOperationStage);
      } catch {
        // Presentation observers cannot change the outcome of an installation.
      }
    };
    const installKey = `${request.sourceId}:${request.kind}:${pluginId.toLowerCase()}`;
    reportProgress(PluginOperationStage.QUEUED);
    try {
      return await this.runInstallExclusive(installKey, async () => {
        reportProgress(PluginOperationStage.PREPARING_PACKAGE);
        let preparing = true;
        const prepared = await this.callProvider(async () => {
          try {
            return onProgress
              ? await provider.prepareInstall(normalizedRequest, {
                  onProgress: stage => {
                    if (preparing) reportProgress(stage);
                  },
                })
              : await provider.prepareInstall(normalizedRequest);
          } finally {
            preparing = false;
          }
        }, 'prepare installation');
        let installSourceInUse = false;
        try {
          if (!prepared || prepared.payload?.kind !== request.kind) {
            throw new MarketplaceError(
              MarketplaceErrorCode.INVALID_RESPONSE,
              'Marketplace source returned an invalid installation payload',
            );
          }
          reportProgress(PluginOperationStage.INSTALLING);
          let installing = true;
          let result: PluginInstallResult;
          try {
            result = await this.installationService.install({
              operation: normalizedRequest.operation,
              origin: PluginInstallOrigin.MARKETPLACE,
              marketplacePluginId: pluginId,
              ...(context ? { operationContext: context } : {}),
              payload: prepared.payload,
              ...(onProgress
                ? {
                    onProgress: (progress: { stage: string }) => {
                      if (installing) reportProgress(progress.stage);
                    },
                  }
                : {}),
            });
          } finally {
            installing = false;
          }
          installSourceInUse = result.installSourceInUse === true;
          // Capture the failure before recording identity or cleaning the temporary source.
          const failedStage = result.success
            ? undefined
            : (toPluginOperationStage(result.failedStage ?? '') ?? currentStage);
          if ((result.success || result.installationCommitted) && result.pluginId) {
            reportProgress(PluginOperationStage.CONFIRMING);
            try {
              const previous = this.installRegistry
                .list(request.kind)
                .find(
                  record =>
                    record.sourceId === request.sourceId &&
                    record.marketplacePluginId.toLowerCase() === pluginId.toLowerCase(),
                );
              this.installRegistry.upsert({
                sourceId: request.sourceId,
                kind: request.kind,
                marketplacePluginId: pluginId,
                runtimeId: result.pluginId,
                installedVersion: normalizedRequest.version || previous?.installedVersion,
                installPath: result.installPath || previous?.installPath,
              });
            } catch {
              console.warn(
                '[PluginMarketplace] Failed to persist marketplace installation identity',
              );
            }
          }
          return failedStage ? { ...result, failedStage } : result;
        } catch (error) {
          thrownFailureStage = currentStage;
          throw error;
        } finally {
          try {
            if (installSourceInUse) {
              console.warn(
                '[PluginMarketplace] Retaining prepared source after an unconfirmed installation',
              );
            } else {
              if (prepared?.cleanup) reportProgress(PluginOperationStage.CLEANING_UP);
              await prepared?.cleanup?.();
            }
          } catch {
            console.warn('[PluginMarketplace] Failed to clean prepared installation payload');
          }
        }
      });
    } catch (error) {
      // Report the entered failure phase without exporting SDK text or temporary paths.
      throw error instanceof MarketplaceError
        ? new MarketplaceError(error.code, error.message, thrownFailureStage ?? currentStage)
        : new MarketplaceError(
            MarketplaceErrorCode.INTERNAL,
            'Marketplace installation failed',
            thrownFailureStage ?? currentStage,
          );
    }
  }

  forgetInstallation(kind: MarketplacePluginKind, runtimeId: string, installPath?: string): void {
    try {
      this.installRegistry.removeRuntime(kind, runtimeId, installPath);
    } catch {
      console.warn('[PluginMarketplace] Failed to remove marketplace installation identity');
    }
  }

  private async runInstallExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.installTails.get(key) ?? Promise.resolve();
    const result = previous.catch((): void => {}).then(operation);
    const tail = result.then(
      (): void => {},
      (): void => {},
    );
    this.installTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.installTails.get(key) === tail) this.installTails.delete(key);
    }
  }

  async getDetail(request: MarketplaceDetailRequest): Promise<MarketplacePluginDetail | null> {
    const provider = this.requireProviderForKind(request.sourceId, request.kind);
    const pluginId = this.requirePluginId(request.pluginId);
    if (!provider.getDetail) return null;
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
      [item?.runtimeId, 256],
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
      (item.category === undefined || this.isCategory(item.category)) &&
      (item.installState === undefined || installStates.has(item.installState));
    const downloadCountValid =
      item.downloadCount === undefined ||
      (Number.isSafeInteger(item.downloadCount) && item.downloadCount >= 0);
    if (!valid || !downloadCountValid) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_RESPONSE,
        'Marketplace source returned an invalid response',
      );
    }
    return {
      id: item.id.trim(),
      runtimeId: item.runtimeId?.trim() || undefined,
      kind: item.kind,
      name: item.name.trim(),
      description: item.description.trim(),
      version: item.version,
      author: item.author,
      downloadCount: item.downloadCount,
      tags: item.tags ? [...item.tags] : undefined,
      category: item.category ? this.normalizeCategory(item.category) : undefined,
      homepage: item.homepage,
      iconUrl: item.iconUrl,
      sourceId,
      installState: item.installState,
      installedVersion: item.installedVersion,
    };
  }

  private isCategory(value: unknown): value is MarketplaceCategory {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const category = value as Partial<MarketplaceCategory>;
    return (
      typeof category.id === 'string' &&
      Boolean(category.id.trim()) &&
      category.id.length <= 128 &&
      typeof category.name === 'string' &&
      Boolean(category.name.trim()) &&
      category.name.length <= 128
    );
  }

  private normalizeCategory(category: MarketplaceCategory): MarketplaceCategory {
    if (!this.isCategory(category)) {
      throw new MarketplaceError(
        MarketplaceErrorCode.INVALID_RESPONSE,
        'Marketplace source returned an invalid category',
      );
    }
    return { id: category.id.trim(), name: category.name.trim() };
  }
}
