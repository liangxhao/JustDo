import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../../config/builtinModels';
import { ProviderName } from '../../shared/providers';
import {
  buildProviderModelInfoUrl,
  buildProviderModelsUrl,
  combineProviderModelDiscovery,
  normalizeModelProviderBaseUrl,
  parseProviderModelInfoResponse,
  parseProviderModelsResponse,
} from '../../shared/providers/modelDiscovery';
import { mainProcessFetch } from '../core/network/mainProcessFetch';
import { enqueueAppConfigUpdate } from '../data/appConfigUpdateQueue';
import type { SqliteStore } from '../data/sqliteStore';
import {
  buildBuiltinModelRequestHeaders,
  type BuiltinModelCredential,
  getActiveBuiltinModelCredential,
} from './builtinModelCredential';

type ProviderModel = {
  id: string;
  name: string;
  enabled?: boolean;
  supportsImage?: boolean;
  contextLength?: number;
  maxTokens?: number;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'openai';
  displayName?: string;
  models?: ProviderModel[];
  embeddingModels?: ProviderModel[];
  readonly?: boolean;
};

type AppConfig = {
  api?: {
    key?: string;
    baseUrl?: string;
  };
  model?: {
    availableModels?: ProviderModel[];
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, ProviderConfig>;
};

type BuiltinProviderFile = {
  enabled?: boolean;
  baseUrl?: string;
};

export const BuiltinModelAccess = {
  Enabled: 'enabled',
  Disabled: 'disabled',
} as const;

export type BuiltinModelAccess = (typeof BuiltinModelAccess)[keyof typeof BuiltinModelAccess];

type SyncBuiltinModelProviderOptions = {
  access: BuiltinModelAccess;
};

type BuiltinModelSyncState = {
  generation: number;
  controller: AbortController | null;
};

const syncStateByStore = new WeakMap<SqliteStore, BuiltinModelSyncState>();

const beginBuiltinModelSync = (store: SqliteStore, shouldFetch: boolean): BuiltinModelSyncState => {
  const previousState = syncStateByStore.get(store);
  previousState?.controller?.abort();

  const nextState = {
    generation: (previousState?.generation ?? 0) + 1,
    controller: shouldFetch ? new AbortController() : null,
  };
  syncStateByStore.set(store, nextState);
  return nextState;
};

const isCurrentBuiltinModelSync = (store: SqliteStore, state: BuiltinModelSyncState): boolean =>
  syncStateByStore.get(store)?.generation === state.generation;

export function readBuiltinModelProviderFile(): BuiltinProviderFile | null {
  return {
    enabled: BUILTIN_MODEL_PROVIDER_CONFIG.enabled,
    baseUrl: normalizeModelProviderBaseUrl(BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl),
  };
}

type BuiltinModels = {
  chatModels: ProviderModel[];
  embeddingModels: ProviderModel[];
};

const compareModelIds = (left: ProviderModel, right: ProviderModel): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

async function fetchBuiltinModels(
  baseUrl: string,
  credential: BuiltinModelCredential,
  signal: AbortSignal,
): Promise<BuiltinModels> {
  const headers = buildBuiltinModelRequestHeaders(credential);
  signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const modelsResponse = await mainProcessFetch(buildProviderModelsUrl(baseUrl), {
    headers,
    signal,
    redirect: 'error',
  });
  if (!modelsResponse.ok) {
    throw new Error(`GET /models failed with ${modelsResponse.status}`);
  }
  const listedModels = parseProviderModelsResponse(await modelsResponse.json());

  const infoResponse = await mainProcessFetch(buildProviderModelInfoUrl(baseUrl), {
    headers,
    signal,
    redirect: 'error',
  });
  const infoById = infoResponse.ok
    ? parseProviderModelInfoResponse(await infoResponse.json())
    : new Map();
  const discovery = combineProviderModelDiscovery(listedModels, infoById);
  const toProviderModel = (model: (typeof discovery.chatModels)[number]): ProviderModel => ({
    id: model.id,
    name: model.name,
    supportsImage: model.supportsImage ?? false,
    ...(model.contextLength ? { contextLength: model.contextLength } : {}),
    ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
  });
  const chatModels = discovery.chatModels.map(toProviderModel);
  const embeddingModels = discovery.embeddingModels.map(toProviderModel);

  return {
    chatModels,
    embeddingModels: embeddingModels.sort(compareModelIds),
  };
}

export async function syncBuiltinModelProvider(
  store: SqliteStore,
  options: SyncBuiltinModelProviderOptions,
): Promise<void> {
  const fileConfig = readBuiltinModelProviderFile();
  const credential = getActiveBuiltinModelCredential();
  const shouldEnable =
    options?.access === BuiltinModelAccess.Enabled &&
    fileConfig?.enabled === true &&
    Boolean(fileConfig.baseUrl) &&
    credential !== null;
  const syncState = beginBuiltinModelSync(store, shouldEnable);
  const persist = async (
    models: ProviderModel[],
    embeddingModels: ProviderModel[],
    catalogLoaded = false,
  ) =>
    enqueueAppConfigUpdate(async () => {
      if (!isCurrentBuiltinModelSync(store, syncState)) return;
      const appConfig = store.get<AppConfig>('app_config') || {};
      const providers = { ...(appConfig.providers ?? {}) };
      const previousBuiltinApiKey = providers[ProviderName.BuiltinModels]?.apiKey?.trim() || '';
      const shouldClearLegacyApiKey =
        appConfig.model?.defaultModelProvider === ProviderName.BuiltinModels ||
        (Boolean(previousBuiltinApiKey) && appConfig.api?.key === previousBuiltinApiKey);
      const sanitizedApi = appConfig.api
        ? {
            ...appConfig.api,
            ...(shouldClearLegacyApiKey ? { key: '' } : {}),
          }
        : undefined;

      if (!shouldEnable || !fileConfig?.baseUrl || !credential) {
        delete providers[ProviderName.BuiltinModels];
        store.set('app_config', {
          ...appConfig,
          ...(sanitizedApi ? { api: sanitizedApi } : {}),
          providers,
        });
        return;
      }

      const previousModels = providers[ProviderName.BuiltinModels]?.models ?? [];
      if (!catalogLoaded) {
        // A failed request does not establish that any model was retired. Read
        // the latest cache inside the queue so concurrent user edits survive.
        models = previousModels;
        embeddingModels = providers[ProviderName.BuiltinModels]?.embeddingModels ?? [];
      }
      const previousEnabledById = new Map(
        previousModels.map(model => [model.id, model.enabled !== false]),
      );
      models = models.map(model => ({
        ...model,
        enabled: previousEnabledById.get(model.id) ?? true,
      }));

      providers[ProviderName.BuiltinModels] = {
        enabled: true,
        apiKey: '',
        baseUrl: fileConfig.baseUrl,
        apiFormat: 'openai',
        readonly: true,
        models,
        embeddingModels,
      };

      const nextModel = { ...(appConfig.model ?? {}) };
      const selectedBuiltinUnavailable =
        nextModel.defaultModelProvider === ProviderName.BuiltinModels &&
        !models.some(model => model.id === nextModel.defaultModel && model.enabled !== false);
      // Only a successful catalog response establishes that a model was removed.
      // Keep the user's preference during transport/auth failures and when no replacement exists.
      if (catalogLoaded && (!nextModel.defaultModel || selectedBuiltinUnavailable)) {
        for (const [providerKey, provider] of Object.entries(providers)) {
          if (!provider.enabled || !provider.baseUrl?.trim()) continue;
          if (providerKey !== ProviderName.BuiltinModels && !provider.apiKey?.trim()) continue;
          const replacement = provider.models?.find(
            model => model.id.trim() && model.enabled !== false,
          );
          if (!replacement) continue;
          nextModel.defaultModel = replacement.id;
          nextModel.defaultModelProvider = providerKey;
          break;
        }
      }

      store.set('app_config', {
        ...appConfig,
        api: {
          ...appConfig.api,
          key: shouldClearLegacyApiKey ? '' : appConfig.api?.key || '',
          baseUrl: appConfig.api?.baseUrl || fileConfig.baseUrl,
        },
        model: nextModel,
        providers,
      });
    });

  if (!shouldEnable || !fileConfig?.baseUrl || !credential) {
    await persist([], []);
    return;
  }

  let models: ProviderModel[] = [];
  let embeddingModels: ProviderModel[] = [];
  let catalogLoaded = false;
  try {
    const fetchedModels = await fetchBuiltinModels(
      fileConfig.baseUrl,
      credential,
      syncState.controller!.signal,
    );
    if (!isCurrentBuiltinModelSync(store, syncState)) return;
    models = fetchedModels.chatModels;
    embeddingModels = fetchedModels.embeddingModels;
    catalogLoaded = true;
    console.log(
      `[BuiltinModelProvider] Synced ${models.length} chat model(s) and ${embeddingModels.length} embedding model(s)`,
    );
  } catch (error) {
    if (!isCurrentBuiltinModelSync(store, syncState)) return;
    console.warn('[BuiltinModelProvider] Failed to refresh models, retaining cached list:', error);
  }
  await persist(models, embeddingModels, catalogLoaded);
}
