import { expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

test('registers the exact optimistic message before notifying render subscribers', async () => {
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ runId: 'motion-run', status: 'ok' }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  const onOptimisticMessage = vi.fn();
  const observedMessages: unknown[] = [];
  const unsubscribe = controller.subscribe(() => {
    const message = controller.state.chatMessages[0];
    if (message) {
      expect(onOptimisticMessage).toHaveBeenCalledWith(message);
      observedMessages.push(message);
    }
  });

  await controller.sendMessage('animate this send', [], undefined, {
    clientTurnId: 'motion-run',
    onOptimisticMessage,
  });

  expect(onOptimisticMessage).toHaveBeenCalledOnce();
  const message = onOptimisticMessage.mock.calls[0][0];
  expect(controller.getLoadedMessages()).toContain(message);
  expect(controller.state.chatMessages[0]).toBe(message);
  expect(observedMessages).toContain(message);
  expect(message.content).toBe('animate this send');
  unsubscribe();
});

test('registers the exact first-send pending object and preserves it during session promotion', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:temp-motion';
  const onOptimisticMessage = vi.fn();

  controller.setPendingUserMessage('first send', [], undefined, onOptimisticMessage);
  const message = onOptimisticMessage.mock.calls[0][0];
  await controller.switchSession('agent:main:justdo:canonical-motion', {
    promoteFromSessionKey: 'agent:main:justdo:temp-motion',
  });

  expect(onOptimisticMessage).toHaveBeenCalledOnce();
  expect(controller.state.pendingUserMessage).toBe(message);
  expect(message.content).toBe('first send');
});

test('does not register motion when send admission rejects a stale session', async () => {
  const controller = new ChatController();
  const request = vi.fn();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-b';
  const onOptimisticMessage = vi.fn();

  await expect(controller.sendMessage('stale send', [], undefined, {
    expectedSessionKey: 'session-a',
    onOptimisticMessage,
  })).rejects.toThrow('context changed');

  expect(onOptimisticMessage).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(controller.getLoadedMessages()).toEqual([]);
});
