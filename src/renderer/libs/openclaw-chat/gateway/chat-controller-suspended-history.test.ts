import { expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';

test('preserves a suspended live turn when reconnect history advances its leaf', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const messages = [{ role: 'user', content: 'continue working', __openclaw: { id: 'user-1' } }];
  let leaf = 'initial-leaf';
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'sessions.list') {
      return Promise.resolve({ sessions: [{ key: sessionKey, hasActiveRun: true }] });
    }
    return Promise.resolve({
      messages,
      sessionId: 'sid-1',
      sessionInfo: { sessionId: 'sid-1', activeLeafEntryId: leaf },
    });
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  await controller.loadHistory();
  const activeTurn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', sessionId: 'sid-1' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  const lifecycle = controller as unknown as {
    handleClose(): void;
    reconcileSuspendedRun(): Promise<void>;
  };
  lifecycle.handleClose();
  leaf = 'progress-leaf';
  controller.state.connected = true;

  await lifecycle.reconcileSuspendedRun();

  expect(controller.state.transcript.activeTurn).toBe(activeTurn);
  expect(controller.state.transcript.activeTurn?.status).toBe('running');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-1');
  expect(controller.state.visibleChatMessages).toEqual(messages);
  expect(request).toHaveBeenCalledWith('sessions.list', {});

  const generation = controller.state.transcript.historyGeneration;
  activeTurn.status = 'final';
  controller.state.chatSending = false;
  await controller.loadHistory();
  expect(controller.state.transcript.historyGeneration).toBeGreaterThan(generation);
  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.visibleChatMessages).toEqual(messages);
});
