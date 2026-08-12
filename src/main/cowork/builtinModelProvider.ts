import { ProviderName } from '../../shared/providers';
import {
  buildProviderModelInfoUrl,
  buildProviderModelsUrl,
  combineProviderModelDiscovery,
  normalizeModelProviderBaseUrl,
  parseProviderModelInfoResponse,
  parseProviderModelsResponse,
} from '../../shared/providers/modelDiscovery';
import type { SqliteStore } from '../data/sqliteStore';
import { BUILTIN_MODEL_PROVIDER_CONFIG } from './builtinModelProviderConfig';

type ProviderModel = {
  id: string;
  name: string;
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
  apiKey?: string;
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
    apiKey: BUILTIN_MODEL_PROVIDER_CONFIG.apiKey.trim(),
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
  apiKey: string,
  signal: AbortSignal,
): Promise<BuiltinModels> {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const modelsResponse = await fetch(buildProviderModelsUrl(baseUrl), { headers, signal });
  if (!modelsResponse.ok) {
    throw new Error(`GET /models failed with ${modelsResponse.status}`);
  }
  const listedModels = parseProviderModelsResponse(await modelsResponse.json());

  const infoResponse = await fetch(buildProviderModelInfoUrl(baseUrl), { headers, signal });
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
  const shouldEnable =
    options?.access === BuiltinModelAccess.Enabled &&
    fileConfig?.enabled === true &&
    Boolean(fileConfig.baseUrl);
  const syncState = beginBuiltinModelSync(store, shouldEnable);
  const appConfig = store.get<AppConfig>('app_config') || {};
  const providers = { ...(appConfig.providers ?? {}) };

  if (!shouldEnable || !fileConfig?.baseUrl) {
    delete providers[ProviderName.BuiltinModels];
    store.set('app_config', { ...appConfig, providers });
    return;
  }

  let models: ProviderModel[] = [];
  let embeddingModels: ProviderModel[] = [];
  try {
    const fetchedModels = await fetchBuiltinModels(
      fileConfig.baseUrl,
      fileConfig.apiKey ?? '',
      syncState.controller!.signal,
    );
    if (!isCurrentBuiltinModelSync(store, syncState)) {
      return;
    }
    models = fetchedModels.chatModels;
    embeddingModels = fetchedModels.embeddingModels;
    console.log(
      `[BuiltinModelProvider] Synced ${models.length} chat model(s) and ${embeddingModels.length} embedding model(s)`,
    );
  } catch (error) {
    if (!isCurrentBuiltinModelSync(store, syncState)) {
      return;
    }
    console.warn('[BuiltinModelProvider] Failed to refresh models, clearing cached list:', error);
  }

  providers[ProviderName.BuiltinModels] = {
    enabled: true,
    apiKey: fileConfig.apiKey ?? '',
    baseUrl: fileConfig.baseUrl,
    apiFormat: 'openai',
    readonly: true,
    models,
    embeddingModels,
  };

  const nextModel = { ...(appConfig.model ?? {}) };
  if (!nextModel.defaultModel && models[0]?.id) {
    nextModel.defaultModel = models[0].id;
    nextModel.defaultModelProvider = ProviderName.BuiltinModels;
  }

  store.set('app_config', {
    ...appConfig,
    api: {
      ...appConfig.api,
      key: appConfig.api?.key || fileConfig.apiKey || '',
      baseUrl: appConfig.api?.baseUrl || fileConfig.baseUrl,
    },
    model: nextModel,
    providers,
  });
}
