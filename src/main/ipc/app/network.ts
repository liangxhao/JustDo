import { ipcMain, type IpcMainInvokeEvent, session, type WebContents } from 'electron';

import { type ApiFetchOptions, NetworkIpc } from '../../../shared/network';
import { t } from '../../core/i18n';
import {
  applyMainProcessOutboundHeaderPolicy,
  MainProcessOutboundHeaderSource,
} from '../../core/mainProcessFetch';
import { BUILTIN_CREDENTIAL_MARKER, BUILTIN_MODEL_PROVIDER_CONFIG, resolveBuiltinRequestApiKey } from '../../cowork/builtinModelProviderConfig';

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

    const doFetch = async (headers: Record<string, string>) => {
      const requestHeaders = { ...headers };
      const builtinAuth = Object.keys(requestHeaders).filter(name =>
        name.toLowerCase() === 'authorization' && requestHeaders[name] === `Bearer ${BUILTIN_CREDENTIAL_MARKER}`,
      );
      if (builtinAuth.length) {
        const baseUrl = BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl.replace(/\/+$/, '');
        if (options.method !== 'POST' || options.url !== `${baseUrl}/chat/completions`) {
          throw new Error(t('builtinCredentialTargetMismatch'));
        }
        for (const name of builtinAuth) {
          requestHeaders[name] = `Bearer ${resolveBuiltinRequestApiKey(BUILTIN_CREDENTIAL_MARKER, baseUrl)}`;
        }
      }
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: requestHeaders,
        ...(builtinAuth.length ? { redirect: 'error' as const } : {}),
        body: options.body,
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
      const headers = applyMainProcessOutboundHeaderPolicy(
        options.url,
        options.headers,
        MainProcessOutboundHeaderSource.RendererFetch,
      );
      return await doFetch(headers);
    } catch (error) {
      if (!controller?.signal.aborted) {
        console.error(
          `[api:fetch] ${options.method} ${options.url} -> ERROR:`,
          error instanceof Error ? error.message : error,
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
