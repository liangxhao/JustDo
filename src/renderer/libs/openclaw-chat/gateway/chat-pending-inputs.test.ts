import type { NativePendingInput } from '@shared/openclaw/pendingInputs';
import { describe, expect, test, vi } from 'vitest';

import type { GatewayMessage } from '../types';
import { ChatController } from './chat-controller';
import type { ChatState } from './chat-controller-support';
import {
  nativePendingInputReadFailed,
  nativePendingInputState,
  projectNativePendingInputs,
  refreshNativePendingInputs,
} from './chat-pending-inputs';

const input = (id: number, state: NativePendingInput['state'] = 'queued'): NativePendingInput => ({
  id: String(id),
  runId: `run-${id}`,
  acceptedAt: id * 1000,
  state,
  message: {
    role: 'user',
    content: [{ type: 'text', text: `Input ${id}` }],
    timestamp: id * 1000,
    __openclaw: { id: `pending:${id}` },
  },
});
const page = (items: NativePendingInput[], nextBefore?: number) => ({
  pendingInputs: {
    items,
    total: items.length,
    queuedCount: 0,
    ...(nextBefore ? { nextBefore } : {}),
  },
});
function fixture() {
  const request = vi.fn(
    async (_method: string, params: Record<string, unknown>) =>
      ({
        inputReceipts: ((params.inputRunIds as string[]) ?? []).map(runId => ({
          runId,
          state: 'pending',
        })),
      }) as unknown,
  );
  const state = {
    sessionKey: 'agent:main:justdo:one',
    currentSessionId: 'physical-one',
    connected: true,
    client: { request },
    transcript: { historyGeneration: 1 },
    chatMessages: [],
    chatRunId: null,
    pendingUserMessage: null,
  } as unknown as ChatState;
  const changed = vi.fn();
  const consumed = vi.fn();
  return {
    state,
    request,
    changed,
    consumed,
    refresh: (response: unknown) => refreshNativePendingInputs(state, response, changed, consumed),
    project: (history: GatewayMessage[] = []) =>
      projectNativePendingInputs(state, history, history),
  };
}

describe('native accepted input recovery', () => {
  test('does not resurrect an explicitly retired optimistic input if the later receipt read fails', async () => {
    const f = fixture();
    f.state.chatRunId = 'run-1';
    f.state.pendingUserMessage = {
      role: 'user',
      content: 'Input 1',
      text: 'Input 1',
      timestamp: 1000,
    };
    const pending = input(1);
    pending.message.__openclaw = { id: 'pending:1', truncated: true };
    f.request.mockResolvedValueOnce({ ok: false, unavailableReason: 'not_visible' });
    f.request.mockRejectedValueOnce(new Error('transport unavailable'));
    await f.refresh(page([pending]));
    expect(f.project().messages).toEqual([]);
    expect(f.project().suppressOptimistic).toBe(true);
  });
  test.each(['not_found', 'not_visible'])(
    'retires a truncated input without run correlation when native lookup says %s',
    async reason => {
      const f = fixture();
      f.request.mockResolvedValue({ ok: false, unavailableReason: reason });
      const pending = input(1);
      delete pending.runId;
      pending.message.__openclaw = { id: 'pending:1', truncated: true };
      await f.refresh(page([pending]));
      expect(f.project().messages).toEqual([]);
      expect(f.consumed).toHaveBeenCalledTimes(reason === 'not_found' ? 1 : 0);
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(['chat.message.get']);
    },
  );

  test('keeps the native truncated placeholder when single-message lookup is temporarily unavailable', async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error('temporary transport error'));
    const pending = input(1);
    delete pending.runId;
    pending.message.__openclaw = { id: 'pending:1', truncated: true };
    await f.refresh(page([pending]));
    expect(f.project().messages).toHaveLength(1);
    expect(f.project().messages[0].__openclaw).toMatchObject({ truncated: true });
    expect(f.consumed).not.toHaveBeenCalled();
  });

  test.each(['pagination', 'receipts'])(
    'a failed %s read retains the unconfirmed optimistic message',
    async phase => {
      const f = fixture();
      f.state.chatRunId = 'run-1';
      f.state.pendingUserMessage = {
        role: 'user',
        content: 'Input 1',
        text: 'Input 1',
        timestamp: 1000,
      };
      f.request.mockRejectedValue(new Error('Fixture read failure'));
      await f.refresh(page([input(1)], phase === 'pagination' ? 1 : undefined));
      expect(nativePendingInputReadFailed(f.state)).toBe(true);
      expect(f.project().messages).toEqual([]);
      expect(f.project().suppressOptimistic).toBe(false);
    },
  );

  test('history commit recovers custody without adding it to the controller transcript', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:one';
    controller.state.connected = true;
    controller.state.client = {
      request: vi.fn(async (_method, params) =>
        params.inputRunIds
          ? { inputReceipts: [{ runId: 'run-1', state: 'pending' }] }
          : {
              messages: [],
              sessionId: 'physical-one',
              sessionInfo: { sessionId: 'physical-one' },
              ...page([input(1)]),
            },
      ),
    } as unknown as NonNullable<ChatState['client']>;
    await expect(controller.loadHistory()).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(projectNativePendingInputs(controller.state, [], []).messages).toHaveLength(1),
    );
    expect(controller.getLoadedMessages()).toEqual([]);
    expect(controller.state.chatMessages).toEqual([]);
    expect(controller.state.transcript.persistedMessages).toEqual([]);
  });

  test('loads independent 20+1 pages even with queuedCount zero, in timestamp order without storing transcripts', async () => {
    const f = fixture();
    f.request.mockImplementation(async (_method, params) =>
      params.pendingBefore
        ? page([input(1)])
        : {
            inputReceipts: (params.inputRunIds as string[]).map(runId => ({
              runId,
              state: 'pending',
            })),
          },
    );
    await f.refresh(
      page(
        Array.from({ length: 20 }, (_, i) => input(i + 2)),
        2,
      ),
    );
    const projected = f.project([{ role: 'assistant', content: 'Later answer', timestamp: 22000 }]);
    expect(projected.messages).toHaveLength(22);
    expect(projected.messages[0].__openclaw).toEqual({ id: 'pending:1' });
    expect(projected.messages[projected.messages.length - 1]?.content).toBe('Later answer');
    expect(f.state.chatMessages).toEqual([]);
    expect(f.request).toHaveBeenCalledWith(
      'chat.history',
      expect.objectContaining({ pendingBefore: 2, limit: 20, sessionId: 'physical-one' }),
    );
  });

  test('retains cancelled/interrupted text, hides withdrawn tombstones and suppresses only matching optimistic identity', async () => {
    const f = fixture();
    f.state.chatRunId = 'run-3';
    f.state.pendingUserMessage = {
      role: 'user',
      content: 'withdrawn',
      text: 'withdrawn',
      timestamp: 3000,
    };
    f.request.mockResolvedValue({
      inputReceipts: [
        { runId: 'run-1', state: 'pending', cancelled: true },
        { runId: 'run-2', state: 'pending' },
        { runId: 'run-3', state: 'pending', cancelled: true },
      ],
    });
    await f.refresh(
      page([
        input(1, 'cancelled'),
        input(2, 'interrupted'),
        { ...input(3, 'cancelled'), message: { role: 'user', content: [], display: false } },
      ]),
    );
    const result = f.project();
    expect(result.messages.map(nativePendingInputState)).toEqual(['cancelled', 'interrupted']);
    expect(result.suppressOptimistic).toBe(true);
    f.state.chatRunId = 'new-run';
    f.state.pendingUserMessage = {
      role: 'user',
      content: 'Input 1',
      text: 'Input 1',
      timestamp: 1001,
    };
    expect(f.project().suppressOptimistic).toBe(false);
  });

  test('consumption during pagination removes custody and asks for fresh canonical history', async () => {
    const f = fixture();
    f.request.mockImplementation(async (_method, params) =>
      params.pendingBefore
        ? page([])
        : {
            inputReceipts: [
              { runId: 'run-1', state: 'consumed', consumedByEventId: 'canonical-user' },
            ],
          },
    );
    await f.refresh(page([input(1)], 1));
    expect(f.project().messages).toEqual([]);
    expect(f.consumed).toHaveBeenCalledOnce();
    expect(f.state.chatMessages).toEqual([]);
  });

  test('withdrawal during receipt verification never flashes the stale input and requests its current state', async () => {
    const f = fixture();
    const displays: number[] = [];
    f.changed.mockImplementation(() => displays.push(f.project().messages.length));
    f.request.mockResolvedValue({
      inputReceipts: [{ runId: 'run-1', state: 'pending', cancelled: true }],
    });
    await f.refresh(page([input(1)]));
    expect(displays).toEqual([0]);
    expect(f.consumed).toHaveBeenCalledOnce();
  });

  test('an exact missing receipt also reloads canonical history after consumption', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ inputReceipts: [] });
    await f.refresh(page([input(1)]));
    expect(f.project().messages).toEqual([]);
    expect(f.consumed).toHaveBeenCalledOnce();
  });

  test('does not duplicate an input promoted into a canonical user message', async () => {
    const f = fixture();
    await f.refresh(page([input(1)]));
    const canonical = {
      role: 'user',
      content: 'Input 1',
      __openclaw: { id: 'real-user', runId: 'run-1' },
      timestamp: 1000,
    };
    expect(f.project([canonical]).messages).toEqual([canonical]);
    const nativeCanonical = {
      role: 'user',
      content: 'Input 1',
      __openclaw: { id: 'real-user', idempotencyKey: 'run-1:user' },
      timestamp: 1000,
    };
    expect(f.project([nativeCanonical]).messages).toEqual([nativeCanonical]);
  });

  test('stale pagination cannot restore inputs after a session switch or newer empty snapshot', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const old = f.refresh(page([input(2)], 2));
    await f.refresh(page([]));
    resolve(page([input(1)]));
    await old;
    expect(f.project().messages).toEqual([]);
    await f.refresh(page([input(1)]));
    f.state.currentSessionId = 'new-physical';
    expect(f.project().messages).toEqual([]);
  });

  test('refuses a repeated pending cursor without blocking canonical history', async () => {
    const f = fixture();
    f.request.mockResolvedValue(page([input(1)], 2));
    await f.refresh(page([input(2)], 2));
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(nativePendingInputReadFailed(f.state)).toBe(true);
    expect(f.state.chatMessages).toEqual([]);
  });

  test('hydrates a truncated pending message with the native message endpoint only', async () => {
    const f = fixture();
    f.request.mockImplementation(async (method, params) =>
      method === 'chat.message.get'
        ? { ok: true, message: { role: 'user', content: 'Full native pending input' } }
        : {
            inputReceipts: (params.inputRunIds as string[]).map(runId => ({
              runId,
              state: 'pending',
            })),
          },
    );
    await f.refresh(
      page([
        {
          ...input(1),
          message: { ...input(1).message, __openclaw: { id: 'pending:1', truncated: true } },
        },
      ]),
    );
    expect(f.project().messages[0].content).toBe('Full native pending input');
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      'chat.message.get',
      'chat.history',
    ]);
  });
});
