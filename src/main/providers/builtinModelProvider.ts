import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../../config/builtinModels';
import { ProviderName } from '../../shared/providers';
import {
  buildProviderModelInfoUrl,
  buildProviderModelsUrl,
  combineProviderModelDiscovery,
  type DiscoveredProviderModel,
  normalizeModelProviderBaseUrl,
  parseProviderModelInfoResponse,
  parseProviderModelsResponse,
} from '../../shared/providers/modelDiscovery';
import { mainProcessFetch } from '../core/network/mainProcessFetch';
import { enqueueAppConfigUpdate } from '../data/appConfigUpdateQueue';
import type { SqliteStore } from '../data/sqliteStore';
import {
  BuiltinModelAuthDiagnosticEvent,
  BuiltinModelAuthDiagnosticReason,
  getBuiltinModelAuthErrorCode,
  writeBuiltinModelAuthDiagnostic,
} from './builtinModelAuthDiagnostics';
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

type DiscoveryDiagnostic = {
  phase: 'request' | 'response';
  optionalHttpStatus?: number;
  optionalFailure?: {
    reason: BuiltinModelAuthDiagnosticReason;
    errorCode: ReturnType<typeof getBuiltinModelAuthErrorCode>;
  };
};

class BuiltinModelDiscoveryHttpError extends Error {
  constructor(readonly httpStatus: number) {
    super(`GET /models failed with ${httpStatus}`);
  }
}

const discoveryFailureReason = (phase: DiscoveryDiagnostic['phase'], error: unknown) =>
  phase === 'request' ? BuiltinModelAuthDiagnosticReason.NetworkFailure
    : error instanceof SyntaxError ? BuiltinModelAuthDiagnosticReason.ResponseInvalidJson
      : BuiltinModelAuthDiagnosticReason.ResponseUnreadable;

async function fetchBuiltinModels(
  store: SqliteStore,
  baseUrl: string,
  credential: BuiltinModelCredential,
  signal: AbortSignal,
  diagnostic: DiscoveryDiagnostic,
): Promise<BuiltinModels> {
  const headers = buildBuiltinModelRequestHeaders(credential);
  const deadline = AbortSignal.timeout(15_000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  const modelsResponse = await mainProcessFetch(buildProviderModelsUrl(baseUrl), {
    headers,
    signal: requestSignal,
    redirect: 'error',
  });
  diagnostic.phase = 'response';
  if (!modelsResponse.ok) {
    throw new BuiltinModelDiscoveryHttpError(modelsResponse.status);
  }
  const listedModels = parseProviderModelsResponse(await modelsResponse.json());
  if (listedModels.length === 0) return { chatModels: [], embeddingModels: [] };

  diagnostic.phase = 'request';
  let infoById = new Map<string, DiscoveredProviderModel>();
  try {
    const infoResponse = await mainProcessFetch(buildProviderModelInfoUrl(baseUrl), {
      headers,
      signal: requestSignal,
      redirect: 'error',
    });
    diagnostic.phase = 'response';
    if (infoResponse.ok) infoById = parseProviderModelInfoResponse(await infoResponse.json());
    else diagnostic.optionalHttpStatus = infoResponse.status;
  } catch (error) {
    signal.throwIfAborted();
    diagnostic.optionalFailure = {
      reason: deadline.aborted ? BuiltinModelAuthDiagnosticReason.RequestTimeout : discoveryFailureReason(diagnostic.phase, error),
      errorCode: getBuiltinModelAuthErrorCode(error),
    };
  }
  if (infoById.size === 0) {
    const previous = store.get<AppConfig>('app_config')?.providers?.[ProviderName.BuiltinModels];
    if (previous?.baseUrl && normalizeModelProviderBaseUrl(previous.baseUrl) === baseUrl) {
      for (const model of previous.models ?? []) infoById.set(model.id, model);
      for (const model of previous.embeddingModels ?? []) infoById.set(model.id, { ...model, mode: 'embedding' });
    }
  }
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
  const startedAt = Date.now();
  const diagnostic: DiscoveryDiagnostic = { phase: 'request' };
  try {
    const fetchedModels = await fetchBuiltinModels(
      store,
      fileConfig.baseUrl,
      credential,
      syncState.controller!.signal,
      diagnostic,
    );
    if (!isCurrentBuiltinModelSync(store, syncState)) return;
    models = fetchedModels.chatModels;
    embeddingModels = fetchedModels.embeddingModels;
    catalogLoaded = true;
    if (diagnostic.optionalHttpStatus !== undefined) {
      writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.DiscoveryOptionalHttpRejected, {
        generation: syncState.generation, discoveryStage: 'model-info',
        httpStatus: diagnostic.optionalHttpStatus, reason: BuiltinModelAuthDiagnosticReason.HttpRejected,
      });
    }
    if (diagnostic.optionalFailure) {
      writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.DiscoveryOptionalFailed, {
        generation: syncState.generation, discoveryStage: 'model-info', ...diagnostic.optionalFailure,
      });
    }
    writeBuiltinModelAuthDiagnostic('info', BuiltinModelAuthDiagnosticEvent.DiscoverySucceeded, {
      generation: syncState.generation, elapsedMs: Date.now() - startedAt,
      chatModelCount: models.length, embeddingModelCount: embeddingModels.length,
    });
  } catch (error) {
    if (!isCurrentBuiltinModelSync(store, syncState)) return;
    writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.DiscoveryFailed, {
      generation: syncState.generation, elapsedMs: Date.now() - startedAt,
      discoveryStage: 'models', errorCode: getBuiltinModelAuthErrorCode(error),
      reason: error instanceof BuiltinModelDiscoveryHttpError ? BuiltinModelAuthDiagnosticReason.HttpRejected
        : discoveryFailureReason(diagnostic.phase, error),
      ...(error instanceof BuiltinModelDiscoveryHttpError ? { httpStatus: error.httpStatus } : {}),
    });
  }
  await persist(models, embeddingModels, catalogLoaded);
}
