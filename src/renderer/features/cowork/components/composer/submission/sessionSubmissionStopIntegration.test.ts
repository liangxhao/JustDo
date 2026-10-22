import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import {
  bindSessionSubmissionRun,
  createSessionSubmission,
  stopSessionSubmission,
} from './sessionSubmission';

afterEach(() => vi.useRealTimers());

test('repeats session stop after an in-flight native queue admission is acknowledged', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  let acknowledge!: (result: unknown) => void;
  Object.assign(controller.state, {
    sessionKey: 'session-a', currentSessionId: 'native-a', connected: true,
    chatRunId: 'active-run', chatSending: true,
    client: { request: vi.fn(() => new Promise(resolve => { acknowledge = resolve; })) },
  });
  vi.spyOn(controller, 'loadHistory').mockResolvedValue(true);
  const operation = createSessionSubmission();
  const sending = controller.queueMessage('next').finally(operation.finish);
  const stop = vi.fn().mockResolvedValue(true);
  const stopping = stopSessionSubmission(operation, stop);
  await Promise.resolve();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(operation.stopping).toBe(true);
  acknowledge({ status: 'started' });
  await sending;
  expect(await stopping).toBe(true);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(controller.state.chatRunId).toBe('active-run');
});

test.each([false, true])(
  'settles the canonical run when Stop precedes its acknowledgement (receipt write fails=%s)',
  async persistenceFails => {
    vi.useFakeTimers();
    let acknowledge!: (result: { runId: string; status: string }) => void;
    const controller = new ChatController();
    controller.state.sessionKey = 'session-a';
    controller.state.connected = true;
    controller.state.client = {
      request: vi.fn((method: string) =>
        method === 'chat.send'
          ? new Promise(resolve => {
              acknowledge = resolve;
            })
          : Promise.resolve({ messages: [] }),
      ),
    } as never;
    const operation = createSessionSubmission();
    const sending = controller
      .sendMessage('slow model', [], undefined, {
        clientTurnId: 'justdo-provisional-run',
        onRunBound: runId =>
          bindSessionSubmissionRun(operation, runId, async () => {
            if (persistenceFails) throw new Error('receipt unavailable');
          }),
      })
      .finally(operation.finish);
    const capturedRunId = controller.state.chatRunId;
    const abort = vi.fn().mockResolvedValue(true);
    const stopping = stopSessionSubmission(operation, abort);
    acknowledge({ runId: 'canonical-run', status: 'accepted' });
    await sending;
    expect(await stopping).toBe(true);
    expect(controller.state.chatRunId).toBe('canonical-run');
    controller.settleConfirmedRun('session-a', operation.runId ?? capturedRunId!, 'aborted');
    controller.clearSending('session-a', capturedRunId);
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.transcript.activeTurn?.status).toBe('aborted');
    expect(abort).toHaveBeenCalledTimes(2);
  },
);
