import { OPENAI_REQUEST_USER_AGENT } from '../../../../shared/cowork/modelRequestHeaders';
import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import {
  getEffectiveCustomProviderDisplayName,
  isJustDoCustomProviderKey,
  normalizeOpenClawProviderId,
  OpenClawApi as OpenClawApiConst,
  OpenClawProviderId,
  ProviderName,
} from '../../../../shared/providers';
import {
  BUILTIN_MODEL_JWT_FIELD,
  isActiveBuiltinModelDevelopmentApiKey,
} from '../../../providers/builtinModelCredential';
import type { ProviderRawConfig } from '../../../providers/providerApiConfig';
import { isRecord } from '../configShape';
import { OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS } from '../policies/executionPolicyProjection';
import {
  buildBuiltinModelOpenClawHeaders,
  buildBuiltinModelSecretRef,
  type OpenClawBuiltinSecretRef,
} from './builtinSecretProjection';
import { managedProviderHeaderSecretRef, managedProviderSecretRef } from './providerSecretFile';

export const rewriteProviderAliasInModel = (
  model: unknown,
  providerAliases: ReadonlyMap<string, string>,
): unknown => {
  if (!isRecord(model) || typeof model.primary !== 'string') return model;
  const primary = model.primary.trim();
  const separator = primary.indexOf('/');
  if (separator <= 0 || separator === primary.length - 1) return model;
  const providerId = primary.slice(0, separator);
  const canonicalProviderId = providerAliases.get(providerId.toLowerCase());
  if (!canonicalProviderId) return model;
  return {
    ...model,
    primary: `${canonicalProviderId}/${primary.slice(separator + 1)}`,
  };
};

export const getModelProviderId = (model: unknown): string => {
  if (!isRecord(model) || typeof model.primary !== 'string') return '';
  const separator = model.primary.indexOf('/');
  return separator > 0 ? model.primary.slice(0, separator).toLowerCase() : '';
};

export const providerRouteIdentity = (provider: unknown): string => {
  if (!isRecord(provider)) return '';
  const { apiKey: _apiKey, ...route } = provider;
  if (isRecord(route.request) && route.request.allowPrivateNetwork === true) {
    // The managed network opt-in must not break unique route matching when a
    // saved provider is renamed. Other transport and explicit denial fields matter.
    const { request: _request, ...identity } = route;
    const { allowPrivateNetwork: _allowPrivateNetwork, ...request } = route.request;
    return JSON.stringify({
      ...identity,
      ...(Object.keys(request).length > 0 ? { request } : {}),
    });
  }
  return JSON.stringify(route);
};

export const buildManagedOpenClawModelCatalogConfig = (): Record<string, unknown> => ({
  catalogRefresh: {
    enabled: false,
  },
});

export const normalizeModelName = (modelId: string): string => {
  const trimmed = modelId.trim();
  if (!trimmed) return 'default-model';
  const slashIndex = trimmed.lastIndexOf('/');
  const name = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  // Ensure the result is never empty after stripping prefix
  return name.trim() || 'default-model';
};

export const resolveModelDisplayName = (modelId: string, userModelName?: string): string => {
  const userName = userModelName?.trim();
  if (userName) return userName;
  return normalizeModelName(modelId);
};

export type OpenClawProviderApi = 'openai-completions';

export type OpenClawProviderSelection = {
  providerId: string;
  legacyModelId: string;
  sessionModelId: string;
  primaryModel: string;
  providerConfig: {
    baseUrl: string;
    api: OpenClawProviderApi;
    apiKey: unknown;
    auth: 'api-key';
    timeoutSeconds: number;
    request: { allowPrivateNetwork: true };
    headers?: Record<string, unknown>;
    models: Array<{
      id: string;
      name: string;
      api: OpenClawProviderApi;
      input: string[];
      reasoning?: boolean;
      compat: {
        supportsUsageInStreaming: true;
      };
      cost?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
      contextWindow?: number;
      maxTokens?: number;
    }>;
  };
};

export const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) {
    return normalized.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return normalized;
};

export type ProviderDescriptor = {
  providerId: string;
  normalizeBaseUrl: (rawBaseUrl: string) => string;
  resolveApiKey?: (ctx: { apiKey: string; providerName: string }) => string;
  resolveSessionModelId?: (modelId: string) => string;
  /**
   * 动态计算 baseUrl，完全覆盖 normalizeBaseUrl 的结果。
   * 用于 baseUrl 由运行时环境决定（如代理端口）而非用户配置的场景。
   * 返回 null 表示降级使用 normalizeBaseUrl。
   */
  resolveRuntimeBaseUrl?: () => string | null;
  /**
   * 基于 modelId 动态计算 reasoning 标志。
   * 优先级高于 modelDefaults.reasoning。
   */
  resolveModelReasoning?: (modelId: string) => boolean | undefined;
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};

export const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {};

export const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.JustDo,
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

export const resolveDescriptor = (providerName: string): ProviderDescriptor => {
  if (providerName in PROVIDER_REGISTRY) {
    return PROVIDER_REGISTRY[providerName];
  }
  return {
    ...DEFAULT_DESCRIPTOR,
    providerId: providerName || OpenClawProviderId.JustDo,
  };
};

export const buildProviderSelection = (options: {
  apiKey: string;
  baseURL: string;
  modelId: string;
  apiType: 'openai' | undefined;
  providerName?: string;
  supportsImage?: boolean;
  modelName?: string;
  displayName?: string;
  contextLength?: number; // 用户配置的上下文窗口长度
  maxTokens?: number; // 用户配置的最大输出 token 数量
  headers?: Record<string, string>;
}): OpenClawProviderSelection => {
  const providerName = options.providerName ?? '';
  const descriptor = resolveDescriptor(providerName);
  const effectiveProviderId = isJustDoCustomProviderKey(providerName)
    ? normalizeOpenClawProviderId(
        getEffectiveCustomProviderDisplayName(providerName, options.displayName),
      )
    : normalizeOpenClawProviderId(descriptor.providerId);

  let baseUrl =
    descriptor.resolveRuntimeBaseUrl?.() ?? descriptor.normalizeBaseUrl(options.baseURL);
  const api = OpenClawApiConst.OpenAICompletions as OpenClawProviderApi;
  const apiKey =
    providerName === ProviderName.BuiltinModels
      ? buildBuiltinModelSecretRef(BUILTIN_MODEL_JWT_FIELD)
      : descriptor.resolveApiKey
        ? descriptor.resolveApiKey({ apiKey: options.apiKey, providerName })
        : managedProviderSecretRef(effectiveProviderId);
  const sessionModelId = descriptor.resolveSessionModelId
    ? descriptor.resolveSessionModelId(options.modelId)
    : options.modelId;

  const providerModelName = resolveModelDisplayName(sessionModelId, options.modelName);
  const modelInput: string[] = options.supportsImage ? ['text', 'image'] : ['text'];

  // reasoning：descriptor 动态计算 > modelDefaults 静态值
  const reasoning = descriptor.resolveModelReasoning
    ? descriptor.resolveModelReasoning(options.modelId)
    : descriptor.modelDefaults?.reasoning;

  // Fallback defaults when the user hasn't explicitly set these values in Settings.
  // Without defaults, OpenClaw and providers fall back to their own internal
  // defaults (e.g. 8192 for max_completion_tokens) which can conflict with
  // thinking model budgets.
  const effectiveContextWindow =
    options.contextLength ?? descriptor.modelDefaults?.contextWindow ?? 200_000;
  const effectiveMaxTokens = options.maxTokens ?? descriptor.modelDefaults?.maxTokens ?? 32_000;
  const customHeaderNames =
    providerName === ProviderName.BuiltinModels ? [] : Object.keys(options.headers ?? {});

  return {
    providerId: effectiveProviderId,
    legacyModelId: options.modelId,
    sessionModelId,
    primaryModel: `${effectiveProviderId}/${sessionModelId}`,
    providerConfig: {
      baseUrl,
      api,
      apiKey,
      auth: 'api-key' as const,
      ...(providerName === ProviderName.BuiltinModels && !isActiveBuiltinModelDevelopmentApiKey()
        ? { headers: buildBuiltinModelOpenClawHeaders() }
        : {}),
      timeoutSeconds: OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS,
      // Managed language model services may use enterprise/private
      // endpoints or a proxy's fake DNS. This is a provider transport opt-in only.
      request: { allowPrivateNetwork: true },
      ...(customHeaderNames.length > 0
        ? {
            headers: Object.fromEntries(
              customHeaderNames.map(headerName => [
                headerName,
                managedProviderHeaderSecretRef(effectiveProviderId, headerName),
              ]),
            ),
          }
        : {}),
      models: [
        {
          id: sessionModelId,
          name: providerModelName,
          api,
          input: modelInput,
          compat: {
            supportsUsageInStreaming: true,
          },
          ...(reasoning !== undefined ? { reasoning } : { reasoning: true }),
          ...(descriptor.modelDefaults?.cost ? { cost: descriptor.modelDefaults.cost } : {}),
          ...(effectiveContextWindow ? { contextWindow: effectiveContextWindow } : {}),
          ...(effectiveMaxTokens ? { maxTokens: effectiveMaxTokens } : {}),
        },
      ],
    },
  };
};

export type ManagedMemorySearchConfig =
  | {
      enabled: true;
      provider: string;
      model: string;
      remote: {
        baseUrl: string;
        apiKey: string | OpenClawBuiltinSecretRef;
        headers: Record<string, string | OpenClawBuiltinSecretRef>;
      };
    }
  | { enabled: false };

export const buildBuiltinMemorySearchConfig = (
  providers: ProviderRawConfig[],
): ManagedMemorySearchConfig => {
  const provider = providers.find(
    candidate => candidate.providerName === ProviderName.BuiltinModels,
  );
  const model = provider?.embeddingModels
    .filter(candidate => candidate.id.trim())
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
  if (!provider || !model) {
    return { enabled: false };
  }

  const selection = buildProviderSelection({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    modelId: model.id,
    apiType: provider.apiType,
    providerName: provider.providerName,
    modelName: model.name,
    displayName: provider.displayName,
  });
  return {
    enabled: true,
    provider: OpenClawExtensionId.RUNTIME_SERVICES,
    model: selection.sessionModelId,
    remote: {
      baseUrl: selection.providerConfig.baseUrl,
      apiKey: buildBuiltinModelSecretRef(BUILTIN_MODEL_JWT_FIELD),
      headers: {
        'User-Agent': OPENAI_REQUEST_USER_AGENT,
      },
    },
  };
};

export const withMemorySearch = (
  config: Record<string, unknown>,
  search: ManagedMemorySearchConfig,
): Record<string, unknown> => {
  const memory = isRecord(config.memory) ? config.memory : {};
  return {
    ...config,
    memory: {
      ...memory,
      search,
    },
  };
};
