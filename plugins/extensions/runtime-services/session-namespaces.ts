import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import {
  cloneSessionNamespaceValue,
  isSessionNamespaceReadInput,
  SESSION_NAMESPACE_METHOD,
} from './sdk/session-namespace';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function ownValue(value: object, key: string): { present: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false };
  if (!('value' in descriptor) || descriptor.value === undefined)
    throw new Error('Native namespace is unreadable.');
  return { present: true, value: descriptor.value };
}

/** A single bounded raw namespace, never a business interpretation or full session entry. */
export function registerSessionNamespaces(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(SESSION_NAMESPACE_METHOD, ({
    params, respond, client, signal, hasCurrentClientAuthority,
  }) => {
    const assertCurrent = () => {
      if (!api.lifecycle.signal || api.lifecycle.signal.aborted || signal?.aborted ||
          client?.connect.client.mode !== 'backend' || hasCurrentClientAuthority?.() === false)
        throw new Error('A current backend request is required.');
    };
    try {
      assertCurrent();
      if (!isSessionNamespaceReadInput(params)) throw new Error('Exact native namespace identity is required.');
      const entry = getSessionEntry({ sessionKey: params.sessionKey, readConsistency: 'latest' });
      if (!entry || entry.sessionId !== params.nativeSessionId ||
          (entry.lifecycleRevision ?? null) !== params.lifecycleRevision)
        throw new Error('Native session identity changed.');
      let selected: { present: boolean; value?: unknown } = { present: false };
      const extensions = entry.pluginExtensions;
      if (extensions !== undefined) {
        if (!record(extensions)) throw new Error('Native namespace inventory is unreadable.');
        const owner = ownValue(extensions, params.pluginId);
        if (owner.present) {
          if (!record(owner.value)) throw new Error('Native namespace owner is unreadable.');
          selected = ownValue(owner.value, params.namespace);
        }
      }
      const snapshot = {
        ...params,
        present: selected.present,
        ...(selected.present ? { value: cloneSessionNamespaceValue(selected.value) } : {}),
      };
      assertCurrent();
      respond(true, snapshot);
    } catch {
      respond(false, undefined, {
        code: 'invalid_request',
        message: 'Native session namespace snapshot is unavailable.',
      });
    }
  }, { scope: 'operator.admin', profileAccess: 'independent' });
}
