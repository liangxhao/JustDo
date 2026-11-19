import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import {
  bindChatInputAdmissionOwner,
  fingerprintChatInput,
  recoverQueuedInputsFromMessages,
  rememberDirectInput,
} from '@/libs/openclaw-chat/gateway/input/chat-queued-input';

import {
  bindSessionSubmissionRun,
  createSessionSubmission,
  readRetainedDirectSubmission,
  stopSessionSubmission,
} from './sessionSubmission';

afterEach(() => vi.useRealTimers());

test.each([false, true])('recognizes the original audio input after remount until its draft is discarded (%s)', async discarded => {
  const owner = {};
  let draftCurrent = true;
  const previousController = new ChatController();
  const controller = new ChatController();
  bindChatInputAdmissionOwner(previousController.state, owner);
  bindChatInputAdmissionOwner(controller.state, owner);
  const request = vi.fn(async (_method: string, params: { idempotencyKey: string; message: string }) =>
    ({ status: 'started', runId: params.idempotencyKey }));
  Object.assign(controller.state, {
    sessionKey: 'session-a', currentSessionId: 'native-a', connected: true, client: { request },
  });
  vi.spyOn(controller, 'loadHistory').mockResolvedValue(true);
  const audio = 'MEDIA:E:/项目/.audio-attachments/录音.mp3';
  const draft = `Transcribe\n\n${audio}`;
  const operation = Object.assign(createSessionSubmission(() => draftCurrent), {
    sessionKey: 'session-a', receiptId: 'receipt-a', runId: 'direct-a', unknown: true,
    unknownInput: {
      fingerprint: await fingerprintChatInput(draft, []), nativeSessionId: 'native-a', workspaceRoot: 'E:/项目',
    },
  });
  const retained = readRetainedDirectSubmission(operation, {
    id: 'receipt-a', sessionId: 'product-a', clientTurnId: 'direct-a', rootRunId: 'other-run',
    startedAt: 10, acceptedAt: 11, endedAt: 12, state: 'completed',
  })!;
  rememberDirectInput(previousController.state, retained);

  const edited = `Summarize\n\n${audio}`;
  expect(await controller.matchInputForRecovery(edited, [], 'session-a')).toBe(false);
  await controller.queueMessage(edited);
  recoverQueuedInputsFromMessages(controller.state, 'native-a', [{
    role: 'user', content: draft, __openclaw: { id: 'other-row', seq: 1, idempotencyKey: 'other-run:user' },
  }]);
  expect(await controller.matchInputForRecovery(draft, [], 'session-a')).toBe(true);
  await expect(controller.queueMessage(draft)).rejects.toThrow();
  if (discarded) {
    draftCurrent = false;
    expect(controller.matchInputForRecovery(draft, [], 'session-a')).toBeNull();
  } else {
    recoverQueuedInputsFromMessages(controller.state, 'native-a', [{
      role: 'user', content: draft, __openclaw: { id: 'first-row', seq: 2, idempotencyKey: 'direct-a:user' },
    }]);
  }
  await controller.queueMessage(draft);
  expect(request.mock.calls.map(([, params]) => params.message)).toEqual(discarded ? [edited, draft] : [edited]);
  expect(controller.matchInputForRecovery(draft, [], 'session-a')).toBeNull();
});

test.each([false, true])('repeats Stop after native followup settles (older admission unknown=%s)', async hasUnknownPredecessor => {
  vi.useFakeTimers();
  const controller = new ChatController();
  let acknowledge!: (result: unknown) => void;
  let reportRunId!: (runId: string) => void;
  const requestIssued = new Promise<string>(resolve => { reportRunId = resolve; });
  Object.assign(controller.state, {
    sessionKey: 'session-a', currentSessionId: 'native-a', connected: true,
    chatRunId: 'active-run', chatSending: true,
    client: { request: vi.fn((_method: string, params: { idempotencyKey: string }) => new Promise(resolve => {
      acknowledge = resolve;
      reportRunId(params.idempotencyKey);
    })) },
  });
  vi.spyOn(controller, 'loadHistory').mockResolvedValue(true);
  const operation = createSessionSubmission();
  const sending = controller.queueMessage('next').finally(operation.finish);
  const runId = await requestIssued;
  const predecessor = hasUnknownPredecessor ? createSessionSubmission() : undefined;
  if (predecessor) {
    predecessor.unknown = true;
    predecessor.runId = 'unconfirmed-predecessor';
    predecessor.finish();
  }
  const stop = vi.fn().mockResolvedValue(true);
  const stopping = stopSessionSubmission(predecessor ?? operation, stop, {
    pendingFollowup: predecessor ? operation.settled : undefined,
    nativeTargetRunId: 'active-run',
  });
  await Promise.resolve();
  expect(stop).toHaveBeenCalledTimes(1);
  expect((predecessor ?? operation).stopping).toBe(true);
  acknowledge({ status: 'started', runId });
  await sending;
  expect(await stopping).toBe(true);
  if (predecessor) expect(predecessor.unknown).toBe(true);
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
