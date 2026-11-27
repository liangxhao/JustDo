import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent, session, type WebContents } from 'electron';

import { builtinModelRouteKey } from '../../../../plugins/extensions/runtime-services/contracts/model-auth';
import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../../../config/builtinModels';
import {
  type ApiFetchOptions,
  type ApiResponse,
  buildModelConnectionTestRequestBody,
  BuiltinModelProbeOutcome,
  type BuiltinModelProbeResult,
  MODEL_CONNECTION_TEST_MAX_TOKENS,
  MODEL_CONNECTION_TEST_REQUEST_PURPOSE,
  NetworkFetchPurpose,
  NetworkIpc,
  type OutboundHeaderPolicyView,
} from '../../../shared/network/network';
import {
  MODEL_PROVIDER_HEADER_LIMITS,
  normalizeModelProviderHeaders,
} from '../../../shared/providers/modelProviderHeaders';
import { buildOpenAIJsonRequestHeaders } from '../../../shared/providers/modelRequestHeaders';
import {
  applyMainProcessOutboundHeaderPolicy,
  MainProcessOutboundHeaderSource,
} from '../../core/network/mainProcessFetch';
import { onOutboundHeaderPolicyChanged } from '../../core/network/outboundHeaderPolicyConfig';
import { getOutboundHeaderPolicyView } from '../../core/network/outboundHeaderProxy';
import { getBuiltinModelAuthErrorCode } from '../../providers/builtinModelAuthDiagnostics';
import {
  buildBuiltinModelRequestHeaders,
  getActiveBuiltinModelCredentialBinding,
  getBuiltinModelCredentialSessionOwnerId,
} from '../../providers/builtinModelCredential';
import { describeBuiltinModelAuthIssue } from '../../providers/builtinModelTokenExchange';

interface PendingFetch {
  controller: AbortController;
  sender: WebContents;
  handleSenderDestroyed: () => void;
}

const pendingFetches = new Map<string, PendingFetch>();
let unsubscribeOutboundHeaderPolicy: (() => void) | undefined;
const getPendingFetchKey = (event: IpcMainInvokeEvent, requestId: string): string =>
  `${event.sender.id}:${requestId}`;
const cancelPendingFetch = (key: string): void => {
  const pending = pendingFetches.get(key);
  if (!pending) {
    return;
  }
  pendingFetches.delete(key);
  if (!pending.sender.isDestroyed()) {
    pending.sender.removeListener('destroyed', pending.handleSenderDestroyed);
  }
  pending.controller.abort();
};

const withPendingFetch = async <T>(
  event: IpcMainInvokeEvent,
  requestId: string | undefined,
  fetch: (signal?: AbortSignal) => Promise<T>,
): Promise<T> => {
  if (!requestId) return fetch();
  const key = getPendingFetchKey(event, requestId);
  const controller = new AbortController();
  const handleSenderDestroyed = () => controller.abort();
  cancelPendingFetch(key);
  pendingFetches.set(key, { controller, sender: event.sender, handleSenderDestroyed });
  event.sender.once('destroyed', handleSenderDestroyed);
  try {
    return await fetch(controller.signal);
  } finally {
    if (pendingFetches.get(key)?.controller === controller) {
      pendingFetches.delete(key);
      if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', handleSenderDestroyed);
    }
  }
};

const waitForProbeCredential = async (
  renew: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (!signal) return renew();
  if (signal.aborted) return;
  const cancelled = Promise.withResolvers<void>();
  const onAbort = () => cancelled.resolve();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([renew(), cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

const MODEL_PROBE_MAX_BODY_BYTES = 16 * 1024;
const MODEL_PROBE_GENERATED_HEADER_ALLOWANCE = 4;
const MODEL_PROBE_MAX_ID_LENGTH = 512;
const MAX_REQUEST_ID_LENGTH = 128;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key));

const isModelProbeId = (id: unknown): id is string =>
  typeof id === 'string' && id.trim() !== '' && id.length <= MODEL_PROBE_MAX_ID_LENGTH;

const validateModelProbe = (options: ApiFetchOptions): { body?: string } => {
  if (!options.purpose) throw new Error('Invalid model probe request.');
  let pathname: string;
  try {
    pathname = new URL(options.url).pathname.toLowerCase().replace(/\/+$/, '');
  } catch {
    throw new Error('Invalid model probe request.');
  }
  const method = options.method.toUpperCase();
  try {
    normalizeModelProviderHeaders(
      options.headers,
      MODEL_PROVIDER_HEADER_LIMITS.count + MODEL_PROBE_GENERATED_HEADER_ALLOWANCE,
    );
  } catch {
    throw new Error('Invalid model probe request headers.');
  }
  switch (options.purpose) {
    case NetworkFetchPurpose.ModelDiscovery: {
      if (method !== 'GET' || !pathname.endsWith('/models') || options.body !== undefined) {
        throw new Error('Invalid model discovery request.');
      }
      return {};
    }
    case NetworkFetchPurpose.ModelConnectionTest: {
      if (
        method !== 'POST' ||
        !pathname.endsWith('/chat/completions') ||
        typeof options.body !== 'string' ||
        Buffer.byteLength(options.body, 'utf8') > MODEL_PROBE_MAX_BODY_BYTES
      ) {
        throw new Error('Invalid model connection test request.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(options.body);
      } catch {
        throw new Error('Invalid model connection test request.');
      }
      if (
        !isRecord(parsed) ||
        !hasOnlyKeys(parsed, ['model', 'messages', 'max_tokens', 'metadata']) ||
        !isModelProbeId(parsed.model) ||
        !Number.isInteger(parsed.max_tokens) ||
        (parsed.max_tokens as number) < 1 ||
        (parsed.max_tokens as number) > MODEL_CONNECTION_TEST_MAX_TOKENS ||
        !Array.isArray(parsed.messages) ||
        parsed.messages.length !== 1 ||
        !isRecord(parsed.messages[0]) ||
        !hasOnlyKeys(parsed.messages[0], ['role', 'content']) ||
        parsed.messages[0].role !== 'user' ||
        parsed.messages[0].content !== 'Hi'
      ) {
        throw new Error('Invalid model connection test request.');
      }
      if (
        parsed.metadata !== undefined &&
        (!isRecord(parsed.metadata) ||
          !hasOnlyKeys(parsed.metadata, ['request_purpose']) ||
          parsed.metadata.request_purpose !== MODEL_CONNECTION_TEST_REQUEST_PURPOSE)
      ) {
        throw new Error('Invalid model connection test request.');
      }
      return {
        body: buildModelConnectionTestRequestBody(parsed.model, parsed.max_tokens as number, Boolean(parsed.metadata)),
      };
    }
    case NetworkFetchPurpose.NonLanguageModelDiscovery: {
      if (
        method !== 'GET' ||
        options.body !== undefined ||
        !['/models', '/openapi.json', '/audio/voices', '/voices', '/api/voices'].some(suffix =>
          pathname.endsWith(suffix),
        )
      ) {
        throw new Error('Invalid non-language model discovery request.');
      }
      return {};
    }
    default:
      throw new Error('Invalid model probe request.');
  }
};

const redactJsonStrings = (value: unknown, redact: (text: string) => string): unknown => {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactJsonStrings(item, redact));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJsonStrings(item, redact)]));
  }
  return value;
};

const fetchApiResponse = async (
  options: Pick<ApiFetchOptions, 'url' | 'method' | 'headers' | 'body'>,
  signal?: AbortSignal,
  redact?: (value: string) => string,
): Promise<ApiResponse> => {
  const response = await session.defaultSession.fetch(options.url, {
    method: options.method,
    headers: options.headers,
    redirect: 'error',
    body: options.body,
    signal,
  });
  const contentType = response.headers.get('content-type') || '';
  const metadata = {
    status: response.status,
    statusText: redact?.(response.statusText) ?? response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  };
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return {
      ...metadata,
      ok: false,
      data: null,
      error: error instanceof Error ? redact?.(error.message) ?? error.message : 'Unknown error',
    };
  }
  let data: unknown = redact?.(text) ?? text;
  if (/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
    try {
      const parsed: unknown = JSON.parse(text);
      data = redact ? null : parsed;
      if (redact) data = redactJsonStrings(parsed, redact);
    } catch {
      // Keep malformed response text. Omit a parsed body if redaction failed.
    }
  }
  return { ...metadata, ok: response.ok, data };
};

export const registerNetworkHandlers = ({ getMainWindow, hasBuiltinModel, renewBuiltinModelCredential }: {
  getMainWindow: () => BrowserWindow | null;
  hasBuiltinModel: (modelId: string) => boolean;
  renewBuiltinModelCredential: () => Promise<void>;
}): void => {
  ipcMain.removeAllListeners('network:status-change');
  ipcMain.on('network:status-change', (_event, status: 'online' | 'offline') => {
    console.log(`[Main] Network status changed: ${status}`);
  });

  const isMainFrame = (event: IpcMainInvokeEvent): boolean => {
    const window = getMainWindow();
    return Boolean(window && !window.isDestroyed() && !event.sender.isDestroyed() &&
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  };

  ipcMain.handle(NetworkIpc.GetOutboundHeaderPolicy, (event): OutboundHeaderPolicyView => {
    if (!isMainFrame(event)) {
      throw new Error('Outbound header policy requires the main application frame.');
    }

    return getOutboundHeaderPolicyView();
  });
  unsubscribeOutboundHeaderPolicy?.();
  unsubscribeOutboundHeaderPolicy = onOutboundHeaderPolicyChanged(() => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const frame = window.webContents.mainFrame;
    if (frame && !frame.detached) frame.send(NetworkIpc.OutboundHeaderPolicyChanged);
  });

  ipcMain.handle(NetworkIpc.CancelFetch, (event, requestId: string) => {
    cancelPendingFetch(getPendingFetchKey(event, requestId));
  });

  ipcMain.handle(NetworkIpc.TestBuiltinModel, async (event, request: unknown): Promise<BuiltinModelProbeResult> => {
    if (!isMainFrame(event)) throw new Error('Model connection test requires the main application frame.');
    if (!isRecord(request) || !hasOnlyKeys(request, ['modelId', 'requestId']) ||
      !isModelProbeId(request.modelId) || typeof request.requestId !== 'string' ||
      !request.requestId.trim() || request.requestId.length > MAX_REQUEST_ID_LENGTH) {
      throw new Error('Invalid model connection test request.');
    }
    const { modelId, requestId } = request;
    const interrupted = { outcome: BuiltinModelProbeOutcome.Interrupted } as const;
    try {
      const route = BUILTIN_MODEL_PROVIDER_CONFIG.enabled && builtinModelRouteKey(BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl);
      if (!route || !hasBuiltinModel(modelId)) return interrupted;
      const authSessionId = getBuiltinModelCredentialSessionOwnerId();
      // A persisted catalog by itself does not authorize a replacement login.
      if (!authSessionId) return interrupted;
      const url = `${route.replace(/\/+$/, '')}/chat/completions`;
      const body = buildModelConnectionTestRequestBody(modelId, MODEL_CONNECTION_TEST_MAX_TOKENS, true);
      const generatedHeaders = buildOpenAIJsonRequestHeaders(body, undefined, { includeContentLength: false });
      return await withPendingFetch(event, requestId, async signal => {
        const isCurrent = () => !signal?.aborted && isMainFrame(event);
        if (!getActiveBuiltinModelCredentialBinding()) {
          try {
            await waitForProbeCredential(renewBuiltinModelCredential, signal);
          } catch (error) {
            const owner = getBuiltinModelCredentialSessionOwnerId();
            if (!isCurrent() || (owner && owner !== authSessionId)) return interrupted;
            // Exchange can succeed while native snapshot publication needs a
            // retry. The direct model probe only needs the current in-memory JWT.
            if (!getActiveBuiltinModelCredentialBinding()) {
              const issue = describeBuiltinModelAuthIssue(error);
              if (issue) return { outcome: BuiltinModelProbeOutcome.AuthenticationRejected, issue };
              throw error;
            }
          }
        }
        if (!isCurrent() || !hasBuiltinModel(modelId)) return interrupted;
        const policyHeaders = applyMainProcessOutboundHeaderPolicy(url, generatedHeaders, MainProcessOutboundHeaderSource.ModelProbe);
        const binding = getActiveBuiltinModelCredentialBinding();
        if (!isCurrent() || binding?.authSessionId !== authSessionId) return interrupted;
        const accessToken = binding.credential.accessToken;
        const redact = (value: string) => value.replaceAll(accessToken, '[redacted]');
        const auth = buildBuiltinModelRequestHeaders(binding.credential);
        const authNames = new Set(Object.keys(auth).map(name => name.toLowerCase()));
        const headers = Object.fromEntries(Object.entries(policyHeaders).filter(([name]) => !authNames.has(name.toLowerCase())));
        let response: Omit<ApiResponse, 'headers'>;
        try {
          const fetched = await fetchApiResponse({ url, method: 'POST', headers: { ...headers, ...auth }, body }, signal, redact);
          const { ok, status, statusText, data, error } = fetched;
          response = { ok, status, statusText, data, ...(error && { error }) };
        } catch (error) {
          const message = error instanceof Error ? redact(error.message) : 'Network error';
          response = { ok: false, status: 0, statusText: message, data: null, error: message };
        }
        if (!isCurrent() || getBuiltinModelCredentialSessionOwnerId() !== authSessionId ||
          !hasBuiltinModel(modelId)) return interrupted;
        return { outcome: BuiltinModelProbeOutcome.Completed, response };
      });
    } catch (error) {
      console.warn(`[BuiltinModelProbe] Probe preparation failed. code=${getBuiltinModelAuthErrorCode(error)}`);
      return interrupted;
    }
  });

  ipcMain.handle(NetworkIpc.Fetch, (event, options: ApiFetchOptions) =>
    withPendingFetch(event, options.requestId, async (signal): Promise<ApiResponse> => {
      try {
        const validatedProbe = options.purpose ? validateModelProbe(options) : null;
        const headers = options.purpose
          ? applyMainProcessOutboundHeaderPolicy(
              options.url,
              options.headers,
              MainProcessOutboundHeaderSource.ModelProbe,
            )
          : options.headers;
        return await fetchApiResponse({ ...options, headers, body: validatedProbe?.body ?? options.body }, signal);
      } catch (error) {
        if (!signal?.aborted) {
          let origin = 'invalid-url';
          try {
            origin = new URL(options.url).origin;
          } catch {
            // Keep malformed or credential-bearing URLs out of logs.
          }
          console.error(
            `[api:fetch] method=${options.method} origin=${origin} error=${error instanceof Error ? error.name : 'UnknownError'}`,
          );
        }
        return {
          ok: false,
          status: 0,
          statusText: error instanceof Error ? error.message : 'Network error',
          headers: {},
          data: null,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }));
};
