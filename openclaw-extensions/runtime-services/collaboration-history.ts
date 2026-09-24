import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { withCodexSessionTranscriptMirrorWriteLock } from 'openclaw/plugin-sdk/codex-session-transcript-runtime';
import { isSubagentSessionKey } from 'openclaw/plugin-sdk/routing';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

const managed = (key?: string) => Boolean(key && /^agent:[^:]+:justdo:[^:]+$/.test(key));

// History remains readable even when the optional agent-team extension is disabled.
export function registerCollaborationHistory(api: OpenClawPluginApi) {
  // An old transcript can still contain peer keys. Do not let a broad native
  // session-visibility setting bypass the user's disabled extension choice.
  api.on('before_tool_call', (event, ctx) => {
    if (event.toolName !== 'sessions_send' || !managed(ctx.sessionKey)) return;
    if (
      typeof event.params?.sessionKey === 'string' &&
      isSubagentSessionKey(event.params.sessionKey)
    )
      return;
    const plugins = api.runtime.config.current().plugins;
    if (
      plugins?.enabled === false ||
      plugins?.entries?.['agent-team']?.enabled !== true ||
      plugins?.deny?.includes('agent-team') ||
      (plugins?.allow?.length && !plugins.allow.includes('agent-team'))
    ) {
      return {
        block: true,
        blockReason:
          'Agent Team is disabled. For a SubAgent, use its exact sessionKey; do not send peer tasks.',
      };
    }
  });

  const rpc = (method: string, params: Record<string, unknown>) =>
    api.runtime.gateway.request(method, params, { scopes: ['operator.admin', 'operator.read'] });
  api.registerGatewayMethod(
    'collaboration.messages',
    async ({ params, respond }) => {
      try {
        const lookups = Array.isArray(params.lookups) ? params.lookups : [];
        if (!lookups.length || lookups.length > 16)
          throw new Error('Invalid collaboration message lookup.');
        const parsed = lookups.map(value => {
          const item = value as Record<string, unknown>;
          if (
            typeof item.deliveryId !== 'string' ||
            !item.deliveryId ||
            typeof item.receiptId !== 'string' ||
            !item.receiptId ||
            typeof item.sessionId !== 'string' ||
            !item.sessionId ||
            typeof item.sessionKey !== 'string' ||
            !managed(item.sessionKey) ||
            typeof item.sourceSessionKey !== 'string' ||
            !managed(item.sourceSessionKey)
          )
            throw new Error('Invalid collaboration message lookup.');
          const parts = item.sessionKey.split(':');
          if (parts[3] !== item.sessionId)
            throw new Error('Collaboration session identity does not match.');
          return item as {
            deliveryId: string;
            receiptId: string;
            sessionId: string;
            sessionKey: string;
            sourceSessionKey: string;
          };
        });
        const results: Array<{ deliveryId: string; message?: unknown }> = [];
        const groups = new Map<string, typeof parsed>();
        for (const item of parsed) {
          const group = groups.get(item.sessionKey) ?? [];
          group.push(item);
          groups.set(item.sessionKey, group);
        }
        for (const group of groups.values()) {
          const first = group[0];
          // The UUID in a managed session key is the product conversation ID,
          // not OpenClaw's physical transcript ID. Resolve the native owner.
          const nativeEntry = getSessionEntry({
            sessionKey: first.sessionKey,
            readConsistency: 'latest',
          });
          if (!nativeEntry?.sessionId) {
            results.push(...group.map(item => ({ deliveryId: item.deliveryId })));
            continue;
          }
          const keys = group.flatMap(item => [item.receiptId, `${item.receiptId}:user`]);
          const anchors = await withCodexSessionTranscriptMirrorWriteLock(
            {
              agentId: first.sessionKey.split(':')[1],
              sessionId: nativeEntry.sessionId,
              sessionKey: first.sessionKey,
            },
            async locked =>
              (await locked.readMessageFacts({ idempotencyKeys: keys })).anchorsByIdempotencyKey,
          );
          const resolved = await Promise.all(
            group.map(async lookup => {
              const anchor =
                anchors.get(lookup.receiptId) ?? anchors.get(`${lookup.receiptId}:user`);
              if (!anchor) return { deliveryId: lookup.deliveryId };
              const result = (await rpc('chat.message.get', {
                agentId: first.sessionKey.split(':')[1],
                sessionKey: first.sessionKey,
                messageId: anchor.entryId,
              })) as { ok?: boolean; message?: unknown };
              if (!result.ok || !result.message || typeof result.message !== 'object')
                return { deliveryId: lookup.deliveryId };
              const message = result.message as Record<string, unknown>;
              const provenance = message.provenance as Record<string, unknown> | undefined;
              const idempotencyKey = String(message.idempotencyKey);
              if (
                ![lookup.receiptId, `${lookup.receiptId}:user`].includes(idempotencyKey) ||
                provenance?.kind !== 'inter_session' ||
                !['collaboration_send', 'sessions_send'].includes(String(provenance.sourceTool)) ||
                provenance.sourceSessionKey !== lookup.sourceSessionKey
              )
                return { deliveryId: lookup.deliveryId };
              return { deliveryId: lookup.deliveryId, message: result.message };
            }),
          );
          results.push(...resolved);
        }
        respond(true, { messages: results });
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'Collaboration message lookup failed.',
        });
      }
    },
    { scope: 'operator.admin' },
  );
}
