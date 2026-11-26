import { builtinModelRouteKey } from '../../../plugins/extensions/runtime-services/contracts/model-auth';
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

const beginBuiltinModelSync = (store: SqliteStore, controller: AbortController | null): BuiltinModelSyncState => {
  const previousState = syncStateByStore.get(store);
  previousState?.controller?.abort();

  const nextState = {
    generation: (previousState?.generation ?? 0) + 1,
    controller,
  };
  syncStateByStore.set(store, nextState);
  return nextState;
};

const isCurrentBuiltinModelSync = (store: SqliteStore, state: BuiltinModelSyncState): boolean =>
  syncStateByStore.get(store)?.generation === state.generation;

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

class BuiltinModelDiscoveryShapeError extends Error {}

const discoveryFailureReason = (phase: DiscoveryDiagnostic['phase'], error: unknown) =>
  phase === 'request' ? BuiltinModelAuthDiagnosticReason.NetworkFailure
    : error instanceof BuiltinModelDiscoveryShapeError ? BuiltinModelAuthDiagnosticReason.ResponseInvalidShape
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
  const payload: unknown = await modelsResponse.json();
  const data = (payload as { data?: unknown } | null)?.data;
  if (
    !Array.isArray(data) ||
    data.some((entry: { id?: unknown } | null) => typeof entry?.id !== 'string' || !entry.id.trim())
  ) {
    throw new BuiltinModelDiscoveryShapeError('Invalid model list.');
  }
  if (data.length === 0) return { chatModels: [], embeddingModels: [] };
  const listedModels = parseProviderModelsResponse(payload);

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

/** Returns whether required discovery failed and no cached catalog is available. */
export async function syncBuiltinModelProvider(
  store: SqliteStore,
  options: SyncBuiltinModelProviderOptions,
): Promise<boolean> {
  const baseUrl = normalizeModelProviderBaseUrl(BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl);
  const route = builtinModelRouteKey(baseUrl);
  const credential = getActiveBuiltinModelCredential();
  const accessEnabled = options?.access === BuiltinModelAccess.Enabled && BUILTIN_MODEL_PROVIDER_CONFIG.enabled;
  const discovery = accessEnabled && route && credential
    ? { credential, controller: new AbortController() }
    : null;
  const syncState = beginBuiltinModelSync(store, discovery?.controller ?? null);
  const persist = async (
    models: ProviderModel[],
    embeddingModels: ProviderModel[],
    catalogLoaded = false,
  ) =>
    enqueueAppConfigUpdate(async () => {
      if (!isCurrentBuiltinModelSync(store, syncState)) return false;
      const appConfig = store.get<AppConfig>('app_config') || {};
      const providers = { ...(appConfig.providers ?? {}) };
      const builtinIsDefault = appConfig.model?.defaultModelProvider === ProviderName.BuiltinModels;
      const sanitizedApi = appConfig.api
        ? {
            ...appConfig.api,
            ...(builtinIsDefault ? { key: '' } : {}),
          }
        : undefined;

      if (!discovery) {
        delete providers[ProviderName.BuiltinModels];
        store.set('app_config', {
          ...appConfig,
          ...(sanitizedApi ? { api: sanitizedApi } : {}),
          providers,
        });
        return false;
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
        baseUrl,
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
          key: builtinIsDefault ? '' : appConfig.api?.key || '',
          baseUrl: appConfig.api?.baseUrl || baseUrl,
        },
        model: nextModel,
        providers,
      });
      return !catalogLoaded && models.length === 0 && embeddingModels.length === 0;
    });

  if (!discovery) {
    if (accessEnabled && credential && baseUrl && !route) {
      writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.DiscoveryFailed, {
        generation: syncState.generation, discoveryStage: 'models', reason: BuiltinModelAuthDiagnosticReason.UrlInvalid,
      });
    }
    return persist([], []);
  }

  let models: ProviderModel[] = [];
  let embeddingModels: ProviderModel[] = [];
  let catalogLoaded = false;
  const startedAt = Date.now();
  const diagnostic: DiscoveryDiagnostic = { phase: 'request' };
  try {
    const fetchedModels = await fetchBuiltinModels(
      store,
      baseUrl,
      discovery.credential,
      discovery.controller.signal,
      diagnostic,
    );
    if (!isCurrentBuiltinModelSync(store, syncState)) return false;
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
    if (!isCurrentBuiltinModelSync(store, syncState)) return false;
    writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.DiscoveryFailed, {
      generation: syncState.generation, elapsedMs: Date.now() - startedAt,
      discoveryStage: 'models', errorCode: getBuiltinModelAuthErrorCode(error),
      reason: error instanceof BuiltinModelDiscoveryHttpError ? BuiltinModelAuthDiagnosticReason.HttpRejected
        : discoveryFailureReason(diagnostic.phase, error),
      ...(error instanceof BuiltinModelDiscoveryHttpError ? { httpStatus: error.httpStatus } : {}),
    });
  }
  return persist(models, embeddingModels, catalogLoaded);
}
