import { ProviderName } from '../../../shared/providers';
import type { SqliteStore } from '../../data/sqliteStore';
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

const parseModelInfoResponse = (payload: unknown): Map<string, ProviderModel> => {
  const record = toRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : [];
  const result = new Map<string, ProviderModel>();

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

    result.set(modelId, {
      id: modelId,
      name: modelName || modelId,
      supportsImage: modelInfo?.supports_vision === true,
      contextLength: modelInfo ? getNumber(modelInfo, 'max_input_tokens') : undefined,
      maxTokens: modelInfo ? getNumber(modelInfo, 'max_output_tokens') : undefined,
    });
  }

  return result;
};

async function fetchBuiltinModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const modelsResponse = await fetch(buildModelsUrl(baseUrl), { headers });
  if (!modelsResponse.ok) {
    throw new Error(`GET /models failed with ${modelsResponse.status}`);
  }
  const modelIds = parseModelsResponse(await modelsResponse.json());

  const infoResponse = await fetch(buildModelInfoUrl(baseUrl), { headers });
  const infoById = infoResponse.ok
    ? parseModelInfoResponse(await infoResponse.json())
    : new Map<string, ProviderModel>();

  return modelIds.map(modelId => {
    const modelInfo = infoById.get(modelId);
    return {
      id: modelId,
      name: modelInfo?.name || modelId,
      supportsImage: modelInfo?.supportsImage ?? false,
      ...(modelInfo?.contextLength ? { contextLength: modelInfo.contextLength } : {}),
      ...(modelInfo?.maxTokens ? { maxTokens: modelInfo.maxTokens } : {}),
    };
  });
}

export async function syncBuiltinModelProvider(store: SqliteStore): Promise<void> {
  const fileConfig = readBuiltinModelProviderFile();
  const appConfig = store.get<AppConfig>('app_config') || {};
  const providers = { ...(appConfig.providers ?? {}) };
  const existingProvider = providers[ProviderName.BuiltinModels];

  if (!fileConfig?.enabled || !fileConfig.baseUrl) {
    delete providers[ProviderName.BuiltinModels];
    store.set('app_config', { ...appConfig, providers });
    return;
  }

  let models = existingProvider?.models ?? [];
  try {
    models = await fetchBuiltinModels(fileConfig.baseUrl, fileConfig.apiKey ?? '');
    console.log(`[BuiltinModelProvider] Synced ${models.length} model(s)`);
  } catch (error) {
    console.warn('[BuiltinModelProvider] Failed to refresh models, keeping cached list:', error);
  }

  providers[ProviderName.BuiltinModels] = {
    enabled: true,
    apiKey: fileConfig.apiKey ?? '',
    baseUrl: fileConfig.baseUrl,
    apiFormat: 'openai',
    readonly: true,
    models,
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
