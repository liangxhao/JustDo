import { ProviderName } from '../../shared/providers';
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

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

export function readBuiltinModelProviderFile(): BuiltinProviderFile | null {
  return {
    enabled: BUILTIN_MODEL_PROVIDER_CONFIG.enabled,
    apiKey: BUILTIN_MODEL_PROVIDER_CONFIG.apiKey.trim(),
    baseUrl: normalizeBaseUrl(BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl),
  };
}

const buildModelsUrl = (baseUrl: string): string => `${normalizeBaseUrl(baseUrl)}/models`;

const buildModelInfoUrl = (baseUrl: string): string => `${normalizeBaseUrl(baseUrl)}/model/info`;

const getNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const parseModelsResponse = (payload: unknown): string[] => {
  const record = toRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : [];
  return data
    .map(item => {
      const model = toRecord(item);
      return typeof model?.id === 'string' ? model.id.trim() : '';
    })
    .filter(Boolean);
};

type ProviderModelInfo = {
  model: ProviderModel;
  mode?: string;
};

const parseModelInfoResponse = (payload: unknown): Map<string, ProviderModelInfo> => {
  const record = toRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : [];
  const result = new Map<string, ProviderModelInfo>();

  for (const item of data) {
    const entry = toRecord(item);
    const modelName = typeof entry?.model_name === 'string' ? entry.model_name.trim() : '';
    const modelInfo = toRecord(entry?.model_info);
    const modelId =
      modelName ||
      (typeof modelInfo?.key === 'string' ? modelInfo.key.trim() : '') ||
      (typeof modelInfo?.id === 'string' ? modelInfo.id.trim() : '');

    if (!modelId) {
      continue;
    }

    const rawMode = modelInfo?.mode ?? entry?.mode;
    result.set(modelId, {
      model: {
        id: modelId,
        name: modelName || modelId,
        supportsImage: modelInfo?.supports_vision === true,
        contextLength: modelInfo ? getNumber(modelInfo, 'max_input_tokens') : undefined,
        maxTokens: modelInfo ? getNumber(modelInfo, 'max_output_tokens') : undefined,
      },
      mode: typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : undefined,
    });
  }

  return result;
};

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
  const modelsResponse = await fetch(buildModelsUrl(baseUrl), { headers, signal });
  if (!modelsResponse.ok) {
    throw new Error(`GET /models failed with ${modelsResponse.status}`);
  }
  const modelIds = parseModelsResponse(await modelsResponse.json());

  const infoResponse = await fetch(buildModelInfoUrl(baseUrl), { headers, signal });
  const infoById = infoResponse.ok
    ? parseModelInfoResponse(await infoResponse.json())
    : new Map<string, ProviderModelInfo>();

  const chatModels: ProviderModel[] = [];
  const embeddingModels: ProviderModel[] = [];
  for (const modelId of modelIds) {
    const modelInfo = infoById.get(modelId);
    const model = {
      id: modelId,
      name: modelInfo?.model.name || modelId,
      supportsImage: modelInfo?.model.supportsImage ?? false,
      ...(modelInfo?.model.contextLength ? { contextLength: modelInfo.model.contextLength } : {}),
      ...(modelInfo?.model.maxTokens ? { maxTokens: modelInfo.model.maxTokens } : {}),
    };
    if (modelInfo?.mode === 'embedding') {
      embeddingModels.push(model);
    } else {
      chatModels.push(model);
    }
  }

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
