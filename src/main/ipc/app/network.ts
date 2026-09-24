import { ipcMain, type IpcMainInvokeEvent, session, type WebContents } from 'electron';

import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../../../config/builtinModels';
import { type ApiFetchOptions, NetworkFetchPurpose, NetworkIpc } from '../../../shared/network/network';
import {
  MODEL_PROVIDER_HEADER_LIMITS,
  normalizeModelProviderHeaders,
} from '../../../shared/providers/modelProviderHeaders';
import { t } from '../../core/i18n';
import {
  applyMainProcessOutboundHeaderPolicy,
  MainProcessOutboundHeaderSource,
} from '../../core/network/mainProcessFetch';
import { getBuiltinModelRequestHeaders } from '../../providers/builtinModelCredential';

interface PendingFetch {
  controller: AbortController;
  sender: WebContents;
  handleSenderDestroyed: () => void;
}

const pendingFetches = new Map<string, PendingFetch>();
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

const MODEL_PROBE_MAX_BODY_BYTES = 16 * 1024;
const MODEL_PROBE_GENERATED_HEADER_ALLOWANCE = 4;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key));

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
        typeof parsed.model !== 'string' ||
        !parsed.model.trim() ||
        parsed.model.length > 512 ||
        !Number.isInteger(parsed.max_tokens) ||
        (parsed.max_tokens as number) < 1 ||
        (parsed.max_tokens as number) > 64 ||
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
          parsed.metadata.request_purpose !== 'connection_test')
      ) {
        throw new Error('Invalid model connection test request.');
      }
      return {
        body: JSON.stringify({
          model: parsed.model,
          ...(parsed.metadata ? { metadata: { request_purpose: 'connection_test' } } : {}),
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: parsed.max_tokens,
        }),
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

export const registerNetworkHandlers = (): void => {
  ipcMain.removeAllListeners('network:status-change');
  ipcMain.on('network:status-change', (_event, status: 'online' | 'offline') => {
    console.log(`[Main] Network status changed: ${status}`);
  });

  ipcMain.handle(NetworkIpc.CancelFetch, (event, requestId: string) => {
    cancelPendingFetch(getPendingFetchKey(event, requestId));
  });

  ipcMain.handle(NetworkIpc.Fetch, async (event, options: ApiFetchOptions) => {
    const pendingKey = options.requestId ? getPendingFetchKey(event, options.requestId) : null;
    const controller = pendingKey ? new AbortController() : null;
    const handleSenderDestroyed = () => controller?.abort();
    if (pendingKey && controller) {
      cancelPendingFetch(pendingKey);
      pendingFetches.set(pendingKey, {
        controller,
        sender: event.sender,
        handleSenderDestroyed,
      });
      event.sender.once('destroyed', handleSenderDestroyed);
    }

    const doFetch = async (headers: Record<string, string>, body = options.body) => {
      const requestHeaders = { ...headers };
      const baseUrl = BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl.replace(/\/+$/, '');
      const isBuiltinProbe = options.purpose === NetworkFetchPurpose.ModelConnectionTest &&
        options.method === 'POST' && options.url === `${baseUrl}/chat/completions`;
      if (isBuiltinProbe) {
        const authHeaders = getBuiltinModelRequestHeaders();
        if (!authHeaders) throw new Error(t('builtinModelAuthenticationUnavailable'));
        for (const name of Object.keys(requestHeaders)) {
          if (Object.keys(authHeaders).some(key => key.toLowerCase() === name.toLowerCase())) {
            delete requestHeaders[name];
          }
        }
        Object.assign(requestHeaders, authHeaders);
      }
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: requestHeaders,
        redirect: 'error',
        body,
        signal: controller?.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      let data: string | object;

      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    };

    try {
      const validatedProbe = options.purpose ? validateModelProbe(options) : null;
      const headers = options.purpose
        ? applyMainProcessOutboundHeaderPolicy(
            options.url,
            options.headers,
            MainProcessOutboundHeaderSource.ModelProbe,
          )
        : options.headers;
      return await doFetch(headers, validatedProbe?.body);
    } catch (error) {
      if (!controller?.signal.aborted) {
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
    } finally {
      if (pendingKey && pendingFetches.get(pendingKey)?.controller === controller) {
        pendingFetches.delete(pendingKey);
        if (!event.sender.isDestroyed()) {
          event.sender.removeListener('destroyed', handleSenderDestroyed);
        }
      }
    }
  });
};
