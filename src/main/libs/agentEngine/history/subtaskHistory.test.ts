import { expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../../coworkStore';
import type { GatewayClientLike } from '../gateway/types';
import { SubtaskHistory } from './subtaskHistory';

function createSubtaskHistory(client: GatewayClientLike) {
  const store = {
    getSession: vi.fn(() => ({
      id: 'parent-1',
      agentId: 'main',
      messages: [],
    })),
  } as unknown as CoworkStore;

  const historyReconciler = {
    patchToolInputFromHistoryRaw: vi.fn(),
  };

  return {
    historyReconciler,
    store,
    subtaskHistory: new SubtaskHistory({
      ensureGatewayClientReady: vi.fn(async () => undefined),
      getGatewayClient: () => client,
      historyReconciler: historyReconciler as never,
      sessionKeyToLabel: new Map(),
      store,
      subagentMessages: new Map([
        ['tool-call-1', [{ role: 'assistant', content: 'legacy fallback should not be used' }]],
      ]),
      toolCallIdToSessionKey: new Map([['tool-call-1', 'agent:main:subagent:mapped-child']]),
      uuidToToolCallId: new Map(),
    }),
  };
}

test('getSubTaskHistory uses explicit childSessionId as the strict Gateway history path', async () => {
  const request = vi.fn(async () => ({
    messages: [
      { role: 'user', content: 'write a greeting' },
      { role: 'assistant', content: 'hello from child' },
    ],
  }));
  const { historyReconciler, subtaskHistory } = createSubtaskHistory({
    start: vi.fn(),
    stop: vi.fn(),
    request,
  });

  const messages = await subtaskHistory.getSubTaskHistory(
    'parent-1',
    'tool-call-1',
    'agent:main:subagent:legacy-session',
    'agent:main:subagent:child-1',
  );

  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:subagent:child-1',
    limit: 100,
  });
  expect(messages.map(message => [message.type, message.content])).toEqual([
    ['user', 'write a greeting'],
    ['assistant', 'hello from child'],
  ]);
  expect(messages[0].metadata?.isSubagentContext).toBe(true);
  expect(historyReconciler.patchToolInputFromHistoryRaw).toHaveBeenCalledOnce();
});

test('getSubTaskHistory does not use legacy fallback when childSessionId history is empty', async () => {
  const request = vi.fn(async () => ({ messages: [] }));
  const { store, subtaskHistory } = createSubtaskHistory({
    start: vi.fn(),
    stop: vi.fn(),
    request,
  });

  const messages = await subtaskHistory.getSubTaskHistory(
    'parent-1',
    'tool-call-1',
    undefined,
    'agent:main:subagent:child-1',
  );

  expect(messages).toEqual([]);
  expect(store.getSession).not.toHaveBeenCalled();
});
