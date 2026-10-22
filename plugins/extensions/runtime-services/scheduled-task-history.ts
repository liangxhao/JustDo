import { createHash } from 'node:crypto';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-paths';
import { resolveTranscriptSessionKeyBySessionId } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

const CHUNK_CHARS = 256 * 1024;

// cron run aliases can disappear while their physical transcript window survives.
// Resolve the exact run, never the task's current window (which may be another run).
export function registerScheduledTaskHistory(api: OpenClawPluginApi) {
  api.registerGatewayMethod(
    'runtimeServices.scheduledTaskHistory',
    async ({ params, respond }) => {
      try {
        const match =
          typeof params.sessionKey === 'string'
            ? /^agent:([^:]+):cron:([^:]+):run:([^:]+)$/.exec(params.sessionKey)
            : null;
        const offset = params.offset ?? 0;
        if (
          !match ||
          params.sessionId !== match[3] ||
          !Number.isSafeInteger(offset) ||
          (offset as number) < 0
        ) {
          throw new Error('Invalid scheduled task history identity or offset.');
        }
        const [, agentId, taskId, sessionId] = match;
        const storePath = resolveStorePath(api.runtime.config.current().session?.store, {
          agentId,
        });
        const identity = { agentId, sessionId, storePath };
        const sessionKey = resolveTranscriptSessionKeyBySessionId(identity);
        if (!sessionKey) {
          respond(true, { unavailableReason: 'not-found' });
          return;
        }
        if (sessionKey !== params.sessionKey && sessionKey !== `agent:${agentId}:cron:${taskId}`) {
          throw new Error('Scheduled task transcript belongs to a different session.');
        }
        const entries = await readVisibleSessionTranscriptMessageEntries({
          ...identity,
          sessionKey,
        });
        // Recheck ownership after the async read; deletion must not resurrect a transcript.
        if (resolveTranscriptSessionKeyBySessionId(identity) !== sessionKey) {
          throw new Error('Scheduled task transcript changed during lookup.');
        }
        const messages = entries.map(entry => ({
          ...entry.message,
          id: entry.entryId,
        }));
        if (messages.length === 0) {
          respond(true, { unavailableReason: 'empty' });
          return;
        }
        const serialized = JSON.stringify(messages);
        const version = createHash('sha256').update(serialized).digest('hex');
        if (
          (offset as number) > serialized.length ||
          ((offset as number) > 0 && params.version !== version)
        ) {
          throw new Error('Scheduled task transcript changed during lookup.');
        }
        const end = Math.min(serialized.length, (offset as number) + CHUNK_CHARS);
        respond(true, {
          version,
          chunk: serialized.slice(offset as number, end),
          nextOffset: end < serialized.length ? end : null,
        });
      } catch {
        respond(false, undefined, {
          code: 'UNAVAILABLE',
          message: 'Scheduled task history lookup failed.',
        });
      }
    },
    { scope: 'operator.admin' },
  );
}
