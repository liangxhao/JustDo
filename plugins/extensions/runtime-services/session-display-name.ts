import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry, patchSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import {
  normalizeSessionDisplayName,
  SESSION_DISPLAY_NAME_METHOD,
} from './contracts/session-display-name';
import { buildCoworkSessionKey, parseCoworkSessionKey } from './contracts/session-key';

export function registerSessionDisplayName(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    SESSION_DISPLAY_NAME_METHOD,
    async ({ params, respond, client, signal, hasCurrentClientAuthority }) => {
      const assertCurrent = () => {
        if (
          api.lifecycle.signal?.aborted !== false ||
          signal?.aborted ||
          client?.connectionSignal?.aborted ||
          client?.connect.client.mode !== 'backend' ||
          hasCurrentClientAuthority?.() !== true
        ) {
          throw new Error('A current backend request is required.');
        }
      };
      try {
        assertCurrent();
        const { sessionKey, nativeSessionId, lifecycleRevision, expectedDisplayName, confirmOnly } =
          params;
        const displayName = normalizeSessionDisplayName(params.displayName);
        const key =
          typeof sessionKey === 'string' && sessionKey.length <= 512
            ? parseCoworkSessionKey(sessionKey)
            : null;
        if (
          typeof sessionKey !== 'string' ||
          !key?.agentId ||
          !/^[a-z0-9_-]{1,64}$/.test(key.agentId) ||
          sessionKey !== buildCoworkSessionKey(key.sessionId, key.agentId) ||
          typeof nativeSessionId !== 'string' ||
          !nativeSessionId.trim() ||
          nativeSessionId.length > 512 ||
          (lifecycleRevision !== null &&
            (typeof lifecycleRevision !== 'string' ||
              !lifecycleRevision.trim() ||
              lifecycleRevision.length > 512)) ||
          !displayName ||
          (confirmOnly !== undefined && confirmOnly !== true) ||
          (expectedDisplayName !== undefined && !normalizeSessionDisplayName(expectedDisplayName))
        ) {
          throw new Error('Invalid native session title request.');
        }
        const target = { sessionKey, agentId: key.agentId };
        const initial = getSessionEntry({ ...target, readConsistency: 'latest' });
        const assertIdentity = (entry: typeof initial) => {
          if (
            !entry ||
            entry.sessionId !== nativeSessionId ||
            (entry.lifecycleRevision ?? null) !== lifecycleRevision
          ) {
            throw new Error('Native session identity changed.');
          }
        };
        assertIdentity(initial);
        const initialDisplayName = initial?.displayName;
        const receipt = { sessionKey, nativeSessionId, lifecycleRevision, displayName };
        if (initialDisplayName === displayName) {
          respond(true, receipt);
          return;
        }
        if (confirmOnly) throw new Error('Native session title unavailable.');
        if (
          expectedDisplayName !== undefined &&
          initialDisplayName !== undefined &&
          initialDisplayName !== normalizeSessionDisplayName(expectedDisplayName)
        )
          throw new Error('Native session title changed.');

        const updated = await patchSessionEntry({
          ...target,
          preserveActivity: true,
          requireWriteSuccess: true,
          assertCommitAllowed: assertCurrent,
          update: entry => {
            assertIdentity(entry);
            if (entry.displayName !== initialDisplayName)
              throw new Error('Native session title changed.');
            return { displayName };
          },
        });
        assertIdentity(updated ?? undefined);
        if (updated?.displayName !== displayName)
          throw new Error('Native session title unavailable.');
        respond(true, receipt);
      } catch {
        respond(false, undefined, {
          code: 'invalid_request',
          message: 'Unable to update the native session title.',
        });
      }
    },
    { scope: 'operator.admin', profileAccess: 'independent' },
  );
}
