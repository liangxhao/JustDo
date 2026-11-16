import { useEffect, useState } from 'react';

import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import {
  asRecord,
  isSubagentTaskHistoryMessage,
} from '@/libs/openclaw-chat/gateway/chat-controller-support';
import type { GatewayClient } from '@/libs/openclaw-chat/gateway/client';
import { readChunkedHistoryMessage } from '@/libs/openclaw-chat/gateway/history/chat-history-protocol';

interface TaskRead {
  controller: ChatController;
  client: GatewayClient;
  clientGeneration: number;
  historyGeneration: number;
  parentKey: string;
  sessionKey: string;
  sessionId: string;
  entryId: string;
}

function isCurrent(read: TaskRead): boolean {
  const { state } = read.controller;
  return (
    state.connected &&
    state.client === read.client &&
    read.client.generation === read.clientGeneration &&
    state.sessionKey === read.sessionKey &&
    state.currentSessionId === read.sessionId &&
    state.transcript.historyGeneration === read.historyGeneration
  );
}

/** Read only the opening entry's source. Keep the Gateway display projection in chat. */
export function useSubagentTaskEntry(
  controller: ChatController | null,
  sessionKey: string | undefined,
  parentKey: string | undefined,
  expectedSessionId: string | undefined,
): string | undefined {
  const [confirmed, setConfirmed] = useState<TaskRead | null>(null);

  useEffect(() => {
    if (!controller || !sessionKey || !parentKey) return;
    let pending: TaskRead | undefined;
    let disposed = false;
    const refresh = () => {
      const { state } = controller;
      const { client, currentSessionId } = state;
      const opening =
        state.connected && client && currentSessionId && state.sessionKey === sessionKey &&
        (expectedSessionId === undefined || currentSessionId === expectedSessionId) &&
        !state.historyHasMore && !state.historyReadFailed
          ? controller.getLoadedMessages().find(message => asRecord(message)?.role === 'user')
          : undefined;
      const record = asRecord(opening);
      const metadata = asRecord(record?.__openclaw);
      const entryId =
        typeof metadata?.id === 'string' && !metadata.senderIdentity && !record?.provenance &&
        !isSubagentTaskHistoryMessage(record)
          ? metadata.id
          : undefined;
      if (pending && pending.entryId === entryId && isCurrent(pending)) return;
      pending = undefined;
      setConfirmed(null);
      if (!client || !currentSessionId || !entryId) return;

      const read: TaskRead = {
        controller,
        client,
        clientGeneration: client.generation,
        historyGeneration: state.transcript.historyGeneration,
        parentKey,
        sessionKey,
        sessionId: currentSessionId,
        entryId,
      };
      pending = read;
      const stillCurrent = () => !disposed && pending === read && isCurrent(read);
      void readChunkedHistoryMessage(client, sessionKey, entryId, stillCurrent, currentSessionId)
        .then(source => {
          const native = asRecord(source);
          if (
            stillCurrent() && native && !native.provenance &&
            !asRecord(native.__openclaw)?.senderIdentity && isSubagentTaskHistoryMessage(native)
          ) {
            setConfirmed(read);
          }
        })
        .catch(() => undefined);
    };
    const unsubscribe = controller.subscribe(refresh);
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [controller, expectedSessionId, parentKey, sessionKey]);

  return confirmed && confirmed.controller === controller && confirmed.parentKey === parentKey &&
    confirmed.sessionKey === sessionKey &&
    (expectedSessionId === undefined || confirmed.sessionId === expectedSessionId) && isCurrent(confirmed)
    ? confirmed.entryId
    : undefined;
}
