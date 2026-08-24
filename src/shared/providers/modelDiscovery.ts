export const DEFAULT_MODEL_CONTEXT_LENGTH = 200_000;
export const DEFAULT_MODEL_MAX_TOKENS = 32_000;

export type DiscoveredProviderModel = {
  id: string;
  name: string;
  supportsImage?: boolean;
  contextLength?: number;
  maxTokens?: number;
  mode?: string;
};

export type ConfiguredProviderModel = {
  id: string;
  name: string;
  enabled?: boolean;
  capabilitiesConfirmed?: boolean;
  supportsImage?: boolean;
  contextLength?: number;
  maxTokens?: number;
};

export type ProviderModelDiscovery = {
  chatModels: DiscoveredProviderModel[];
  embeddingModels: DiscoveredProviderModel[];
};

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const getPositiveNumber = (
  record: Record<string, unknown> | null,
  key: string,
): number | undefined => {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
};

const getFirstPositiveNumber = (
  records: Array<Record<string, unknown> | null>,
  keys: string[],
): number | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = getPositiveNumber(record, key);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
};

const getOptionalBoolean = (
  record: Record<string, unknown> | null,
  key: string,
): boolean | undefined => {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
};

const getFirstOptionalBoolean = (
  records: Array<Record<string, unknown> | null>,
  keys: string[],
): boolean | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = getOptionalBoolean(record, key);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
};

const getStringArray = (record: Record<string, unknown> | null, key: string): string[] | null => {
  const value = record?.[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value.map(item => item.toLowerCase())
    : null;
};

const parseCapabilities = (
  value: unknown,
  fallbackId = '',
  fallbackName = fallbackId,
): DiscoveredProviderModel => {
  const record = toRecord(value);
  const modelInfo = toRecord(record?.model_info);
  const architecture = toRecord(record?.architecture);
  const topProvider = toRecord(record?.top_provider);
  const capabilities = toRecord(record?.capabilities);
  const records = [record, modelInfo, architecture, topProvider, capabilities];
  const idValue = record?.id ?? record?.model_name ?? modelInfo?.key ?? modelInfo?.id;
  const id = typeof idValue === 'string' && idValue.trim() ? idValue.trim() : fallbackId;
  const nameValue = record?.name ?? record?.display_name ?? record?.model_name;
  const name =
    typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : fallbackName || id;
  const inputModalities =
    getStringArray(record, 'input_modalities') ??
    getStringArray(architecture, 'input_modalities') ??
    getStringArray(capabilities, 'input_modalities');
  const capabilityNames = Array.isArray(record?.capabilities)
    ? record.capabilities.filter((item): item is string => typeof item === 'string')
    : [];
  const explicitImageSupport = getFirstOptionalBoolean(records, [
    'supports_vision',
    'supports_image',
    'vision',
  ]);
  const rawMode = modelInfo?.mode ?? record?.mode;
  const normalizedMode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : undefined;

  return {
    id,
    name,
    supportsImage:
      explicitImageSupport ??
      (inputModalities ? inputModalities.includes('image') : undefined) ??
      (capabilityNames.length > 0
        ? capabilityNames.some(item => item.toLowerCase() === 'vision')
        : undefined),
    contextLength: getFirstPositiveNumber(records, [
      'max_input_tokens',
      'context_length',
      'max_context_length',
      'max_model_len',
      'input_token_limit',
    ]),
    maxTokens: getFirstPositiveNumber(records, [
      'max_output_tokens',
      'max_completion_tokens',
      'output_token_limit',
    ]),
    mode: normalizedMode,
  };
};

const mergeCapabilities = (
  preferred: DiscoveredProviderModel,
  fallback?: DiscoveredProviderModel,
): DiscoveredProviderModel => ({
  ...preferred,
  ...(!preferred.name && fallback?.name ? { name: fallback.name } : {}),
  ...(preferred.supportsImage === undefined && fallback?.supportsImage !== undefined
    ? { supportsImage: fallback.supportsImage }
    : {}),
  ...(preferred.contextLength === undefined && fallback?.contextLength !== undefined
    ? { contextLength: fallback.contextLength }
    : {}),
  ...(preferred.maxTokens === undefined && fallback?.maxTokens !== undefined
    ? { maxTokens: fallback.maxTokens }
    : {}),
  ...(!preferred.mode && fallback?.mode ? { mode: fallback.mode } : {}),
});

export const normalizeModelProviderBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '');

export const buildOpenAIChatCompletionsUrl = (baseUrl: string): string => {
  const normalized = normalizeModelProviderBaseUrl(baseUrl);
  if (!normalized) {
    return '/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
};

export const buildProviderModelsUrl = (baseUrl: string): string =>
  `${normalizeModelProviderBaseUrl(baseUrl)}/models`;

export const buildProviderModelInfoUrl = (baseUrl: string): string =>
  `${normalizeModelProviderBaseUrl(baseUrl)}/model/info`;

export const parseProviderModelsResponse = (payload: unknown): DiscoveredProviderModel[] => {
  const record = toRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : [];
  const seen = new Set<string>();
  const models: DiscoveredProviderModel[] = [];

  for (const item of data) {
    const model = toRecord(item);
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    const rawName = model?.name ?? model?.display_name;
    models.push({
      id,
      name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id,
    });
  }

  return models;
};

export const parseProviderModelInfoResponse = (
  payload: unknown,
): Map<string, DiscoveredProviderModel> => {
  const record = toRecord(payload);
  const data = Array.isArray(record?.data) ? record.data : [];
  const result = new Map<string, DiscoveredProviderModel>();

  for (const item of data) {
    const entry = toRecord(item);
    const modelInfo = toRecord(entry?.model_info);
    const modelName = typeof entry?.model_name === 'string' ? entry.model_name.trim() : '';
    const modelId =
      modelName ||
      (typeof modelInfo?.key === 'string' ? modelInfo.key.trim() : '') ||
      (typeof modelInfo?.id === 'string' ? modelInfo.id.trim() : '');

    if (!modelId) {
      continue;
    }

    result.set(modelId, parseCapabilities(entry, modelId, modelName || modelId));
  }

  return result;
};

export const combineProviderModelDiscovery = (
  listedModels: DiscoveredProviderModel[],
  modelInfoById: ReadonlyMap<string, DiscoveredProviderModel>,
): ProviderModelDiscovery => {
  const chatModels: DiscoveredProviderModel[] = [];
  const embeddingModels: DiscoveredProviderModel[] = [];

  for (const listedModel of listedModels) {
    const model = mergeCapabilities(listedModel, modelInfoById.get(listedModel.id));

    if (model.mode === 'embedding') {
      embeddingModels.push(model);
    } else {
      chatModels.push(model);
    }
  }

  return { chatModels, embeddingModels };
};

export const mergeDiscoveredProviderModels = (
  existingModels: ConfiguredProviderModel[],
  discoveredModels: DiscoveredProviderModel[],
): ConfiguredProviderModel[] => {
  const discoveredById = new Map(discoveredModels.map(model => [model.id, model]));
  const existingIds = new Set(existingModels.map(model => model.id));
  const mergedExisting = existingModels
    .filter(model => discoveredById.get(model.id)?.mode !== 'embedding')
    .map(model => {
      const discovered = discoveredById.get(model.id);
      if (!discovered) {
        return model;
      }

      return {
        ...model,
        ...(discovered.supportsImage !== undefined
          ? { supportsImage: discovered.supportsImage }
          : {}),
        ...(discovered.contextLength !== undefined
          ? { contextLength: discovered.contextLength }
          : {}),
        ...(discovered.maxTokens !== undefined ? { maxTokens: discovered.maxTokens } : {}),
      };
    });
  const addedModels = discoveredModels
    .filter(model => model.mode !== 'embedding' && !existingIds.has(model.id))
    .map(model => ({
      id: model.id,
      name: model.name || model.id,
      enabled: true,
      capabilitiesConfirmed: false,
    }));

  return [...mergedExisting, ...addedModels];
};
