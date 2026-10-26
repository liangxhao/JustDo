import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runProgressDetail } from '../../components/timeline/run-progress-label';
import { createChatTranscriptState } from '../../model/chat-transcript-state';
import { projectTurnItems } from '../../model/timeline/project-turn-items';
import { projectWaitingStatus } from '../../model/turn/run-activity';
import { readRunProgress } from '../../model/turn/run-progress';
import { ChatController } from '../chat-controller';

const sessionKey = 'agent:main:justdo:progress-test';
let controller: ChatController;
let sequence: number;
let handle: (event: { event: string; payload: unknown }) => void;
const emit = (stream: string, data: Record<string, unknown>, overrides = {}) =>
  handle({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-progress',
      sessionId: 'physical-session',
      lifecycleGeneration: 'generation-current',
      seq: ++sequence,
      ts: Date.now(),
      stream,
      data,
      ...overrides,
    },
  });
const progressItem = (progress: Record<string, unknown>) => ({
  itemId: 'run-stream-progress',
  kind: 'status',
  phase: 'update',
  status: 'running',
  progress,
});
const requestActivityItem = (at = Date.now()) => ({
  itemId: 'run-request-activity',
  kind: 'status',
  phase: 'update',
  status: 'running',
  at,
  progress: { kind: 'model-activity' },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  sequence = 0;
  controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'physical-session';
  controller.state.transcript = createChatTranscriptState(sessionKey, 'physical-session');
  controller.state.client = { request: vi.fn().mockResolvedValue({}), stop: vi.fn() } as never;
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  handle = (controller as unknown as { handleEvent: typeof handle }).handleEvent.bind(controller);
  emit('lifecycle', { phase: 'start' });
});
afterEach(() => {
  controller.disconnect();
  vi.useRealTimers();
});

describe('native run progress through the chat controller', () => {
  test('keeps hidden model output active without inventing tool identity or character counts', () => {
    emit('run_status', { phase: 'starting_model' });
    for (let index = 1; index <= 65; index++) {
      vi.setSystemTime(1_000 + index * 1_000);
      emit('item', requestActivityItem());
    }

    expect(controller.state.runActivity).toMatchObject({
      stage: 'receiving-model', hasRunningTool: false,
      lastAgentEventAt: 66_000, lastModelActivityAt: 66_000,
      progress: { kind: 'model-activity' },
    });
    expect(controller.state.runActivity?.progress).not.toHaveProperty('receivedChars');
    expect(controller.state.transcript.activeTurn?.toolById.size).toBe(0);
    expect(projectWaitingStatus({
      activity: controller.state.runActivity, transportStatus: 'connected', now: 66_000,
    })).toBeNull();
    const items = projectTurnItems(
      controller.state.transcript.activeTurn, true, null, controller.state.runActivity,
    );
    const waiting = items[items.length - 1];
    expect(waiting).toMatchObject({ kind: 'waiting', stage: 'receiving-model' });
    expect(runProgressDetail(controller.state.runActivity!, 66_000)).toBeTruthy();
  });

  test('retains counted model observations when generic request activity follows', () => {
    emit('item', progressItem({ kind: 'model', receivedChars: 500 }));
    vi.setSystemTime(2_000);
    emit('item', requestActivityItem());
    expect(controller.state.runActivity).toMatchObject({
      stage: 'receiving-model', lastModelActivityAt: 2_000,
      progress: { kind: 'model-stream', receivedChars: 500 },
    });
  });

  test('rejects stale and foreign request activity through the same native ownership gates', () => {
    emit('run_status', { phase: 'starting_model' });
    for (const override of [
      { runId: 'old-run' }, { sessionId: 'old-session' },
      { lifecycleGeneration: 'old-generation' },
      { sessionKey: 'agent:main:justdo:another-session' }, { seq: 1 },
    ]) emit('item', requestActivityItem(), override);
    expect(controller.state.runActivity?.stage).toBe('starting-model');
  });

  test.each([
    ['preparing_workspace', 'preparing-workspace'],
    ['preparing_context', 'preparing'],
    ['memory_flushing', 'memory-flushing'],
    ['starting_model', 'starting-model'],
  ])('renders the native %s stage', (phase, stage) => {
    emit('run_status', { phase });
    expect(controller.state.runActivity?.stage).toBe(stage);
    const items = projectTurnItems(
      controller.state.transcript.activeTurn,
      true,
      null,
      controller.state.runActivity,
    );
    expect(items[items.length - 1]).toMatchObject({ kind: 'waiting', stage });
  });

  test('keeps long arguments active without pretending that the tool has started', () => {
    for (let index = 0; index < 80; index++) {
      vi.setSystemTime(1_000 + index * 500);
      emit(
        'item',
        progressItem({
          kind: 'tool-input',
          name: 'write',
          toolCallId: 'call-1',
          receivedChars: index * 1_000,
        }),
      );
      emit('tool', {
        phase: 'input_delta',
        name: 'write',
        toolCallId: 'call-1',
        diff: { added: index, removed: 0 },
      });
    }
    expect(controller.state.transcript.activeTurn?.toolById.size).toBe(0);
    expect(controller.state.runActivity).toMatchObject({
      stage: 'generating-tool-input',
      hasRunningTool: false,
      progress: { receivedChars: 79_000, toolCallId: 'call-1' },
    });
    expect(
      projectWaitingStatus({
        activity: controller.state.runActivity,
        transportStatus: 'connected',
      }),
    ).toBeNull();
    emit(
      'item',
      progressItem({
        kind: 'tool-input',
        name: 'write',
        toolCallId: 'call-1',
        receivedChars: 80_000,
        complete: true,
      }),
    );
    expect(controller.state.runActivity?.stage).toBe('preparing-tool');
    emit('tool', {
      phase: 'start',
      name: 'write',
      toolCallId: 'call-1',
      args: { path: 'fixture.txt' },
    });
    expect(controller.state.runActivity).toMatchObject({
      stage: 'running-tool',
      hasRunningTool: true,
      progress: { kind: 'tool' },
    });
  });

  test('shows the native retry count and countdown, then clears them when work resumes', () => {
    emit('run_status', {
      phase: 'retrying',
      reason: 'overloaded',
      retryAttempt: 2,
      maxRetries: 3,
      delayMs: 8_000,
    });
    expect(controller.state.runActivity).toMatchObject({
      stage: 'retrying',
      retryAttempt: 2,
      maxRetries: 3,
      retryAt: 9_000,
    });
    expect(runProgressDetail(controller.state.runActivity!, 5_000)).toContain('4');
    emit('item', progressItem({ kind: 'model', receivedChars: 150 }));
    expect(controller.state.runActivity).toMatchObject({ stage: 'receiving-model' });
    expect(controller.state.runActivity).not.toHaveProperty('retryAt');
    expect(controller.state.runActivity).not.toHaveProperty('retryAttempt');
  });

  test('updates model counters without alternating a visible thinking/reply label', () => {
    emit('thinking', { text: 'Synthetic public thinking' });
    emit('item', progressItem({ kind: 'model', receivedChars: 150 }));
    expect(controller.state.runActivity).toMatchObject({
      stage: 'thinking',
      progress: { receivedChars: 150 },
    });
    emit('assistant', { text: 'Synthetic visible reply' });
    emit('item', progressItem({ kind: 'model', receivedChars: 200 }));
    expect(controller.state.runActivity).toMatchObject({
      stage: 'responding',
      progress: { receivedChars: 200 },
    });
  });

  test('surfaces public tool progress and command output without another transcript copy', () => {
    emit('tool', {
      phase: 'start',
      name: 'exec',
      toolCallId: 'command-1',
      args: { command: 'synthetic test' },
    });
    emit('item', {
      kind: 'tool',
      phase: 'update',
      itemId: 'tool:command-1',
      toolCallId: 'command-1',
      progressText: 'Running validation',
    });
    expect(controller.state.runActivity?.progress).toMatchObject({
      kind: 'tool',
      summary: 'Running validation',
    });
    emit('command_output', { toolCallId: 'command-1', output: 'test output', phase: 'delta' });
    expect(controller.state.runActivity?.progress).toMatchObject({ kind: 'tool', outputChars: 11 });
    expect(
      controller.state.transcript.activeTurn?.items.filter(item => item.type === 'tool'),
    ).toHaveLength(1);
    emit('tool', { phase: 'result', toolCallId: 'command-1', result: 'Completed' });
    expect(controller.state.runActivity?.stage).toBe('waiting-model');
    expect(controller.state.runActivity).not.toHaveProperty('progress');
  });

  test('preserves native ownership and rejects stale or unrelated progress', () => {
    emit('run_status', { phase: 'starting_model' });
    for (const override of [
      { runId: 'old-run' },
      { sessionId: 'old-session' },
      { lifecycleGeneration: 'old-generation' },
      { sessionKey: 'agent:main:justdo:another-session' },
      { seq: 1 },
    ])
      emit('item', progressItem({ kind: 'model', receivedChars: 3 }), override);
    expect(controller.state.runActivity?.stage).toBe('starting-model');
    handle({
      event: 'chat',
      payload: {
        sessionKey,
        runId: 'run-progress',
        state: 'final',
        message: { role: 'assistant', content: 'Done' },
      },
    });
    emit('item', progressItem({ kind: 'model', receivedChars: 1 }));
    expect(controller.state.runActivity).toBeNull();
    expect(controller.state.chatSending).toBe(false);
  });

  test('shows native compaction without a stalled-model notice', () => {
    emit('compaction', { phase: 'start', eventId: 'compaction-1' });
    expect(controller.state.runActivity?.stage).toBe('compacting');
    vi.setSystemTime(120_000);
    expect(
      projectWaitingStatus({
        activity: controller.state.runActivity,
        transportStatus: 'connected',
      }),
    ).toBeNull();
    emit('compaction', { phase: 'end', eventId: 'compaction-1' });
    expect(controller.state.runActivity?.stage).toBe('waiting-model');
  });

  test('restores progress through ordinary native snapshots without rewinding newer live work', () => {
    const applySnapshot = (
      controller as unknown as {
        applyInFlightRunSnapshot(
          snapshot: unknown,
          key: string,
          id: string,
          runId: string,
          info: unknown,
        ): void;
      }
    ).applyInFlightRunSnapshot.bind(controller);
    const replay = (seq: number, stream: string, data: Record<string, unknown>, overrides = {}) =>
      applySnapshot(
        {
          runId: 'run-progress',
          events: [
            {
              runId: 'run-progress',
              sessionKey,
              sessionId: 'physical-session',
              lifecycleGeneration: 'generation-current',
              seq,
              stream,
              ts: Date.now(),
              data,
              ...overrides,
            },
          ],
        },
        sessionKey,
        'physical-session',
        'run-progress',
        { hasActiveRun: true, activeRunIds: ['run-progress'] },
      );
    replay(
      10,
      'item',
      progressItem({
        kind: 'tool-input',
        toolCallId: 'call-1',
        name: 'write',
        receivedChars: 5_000,
      }),
    );
    expect(controller.state.runActivity).toMatchObject({
      stage: 'generating-tool-input',
      progress: { receivedChars: 5_000 },
    });
    vi.setSystemTime(30_000);
    replay(11, 'item', requestActivityItem(1_250));
    expect(controller.state.runActivity).toMatchObject({
      stage: 'generating-tool-input',
      progress: { receivedChars: 5_000 },
      lastModelActivityAt: 1_250,
    });
    expect(projectWaitingStatus({
      activity: controller.state.runActivity, transportStatus: 'connected', now: 30_000,
    })).not.toBeNull();
    emit('thinking', { text: 'Older queued visible text' }, { seq: 5 });
    expect(controller.state.runActivity?.stage).toBe('generating-tool-input');
    emit('tool', { phase: 'start', toolCallId: 'call-1', name: 'write', args: {} }, { seq: 12 });
    expect(controller.state.runActivity?.stage).toBe('running-tool');
    replay(11, 'item', requestActivityItem(1_250));
    expect(controller.state.runActivity?.lastModelActivityAt).toBe(30_000);
    replay(
      10,
      'item',
      progressItem({
        kind: 'tool-input',
        toolCallId: 'call-1',
        name: 'write',
        receivedChars: 5_000,
      }),
    );
    replay(
      20,
      'run_status',
      { phase: 'starting_model' },
      { lifecycleGeneration: 'old-generation' },
    );
    replay(21, 'run_status', { phase: 'starting_model' }, { sessionId: 'old-session' });
    expect(controller.state.runActivity?.stage).toBe('running-tool');
    expect(
      controller.state.transcript.activeTurn?.items.filter(item => item.type === 'tool'),
    ).toHaveLength(1);
  });

  test('keeps background progress current after the tool starts and returns', async () => {
    emit(
      'item',
      progressItem({
        kind: 'tool-input',
        toolCallId: 'call-1',
        name: 'write',
        receivedChars: 5_000,
      }),
    );
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;
    emit('tool', { phase: 'start', toolCallId: 'call-1', name: 'write', args: {} });
    emit('tool', { phase: 'result', toolCallId: 'call-1', name: 'write', result: 'Done' });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;
    expect(controller.state.runActivity?.stage).toBe('waiting-model');
    expect(controller.state.runActivity).not.toHaveProperty('progress');
    expect(controller.state.transcript.activeTurn?.toolById.get('call-1')?.status).toBe(
      'completed',
    );
  });

  test.each([false, true])(
    'retains background request activity with existing tool counters: %s',
    async detailed => {
      if (detailed) emit('item', progressItem({
        kind: 'tool-input', toolCallId: 'call-1', name: 'tool_call', receivedChars: 5_000,
      }));
      controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
      const away = controller.switchSession('agent:main:justdo:another-session');
      await vi.advanceTimersByTimeAsync(5_000);
      await away;
      const observedAt = Date.now();
      emit('item', requestActivityItem(observedAt));
      const returned = controller.switchSession(sessionKey);
      await vi.advanceTimersByTimeAsync(5_000);
      await returned;

      expect(controller.state.runActivity).toMatchObject({
        stage: detailed ? 'generating-tool-input' : 'receiving-model',
        lastModelActivityAt: observedAt,
        progress: detailed
          ? { kind: 'tool-input', receivedChars: 5_000 }
          : { kind: 'model-activity' },
      });
      expect(controller.state.transcript.activeTurn?.toolById.size).toBe(0);
    },
  );

  test('does not wake a silent announce run for content-free native progress', () => {
    controller.disconnect();
    controller = new ChatController();
    controller.state.sessionKey = sessionKey;
    controller.state.currentSessionId = 'physical-session';
    controller.state.transcript = createChatTranscriptState(sessionKey, 'physical-session');
    handle = (controller as unknown as { handleEvent: typeof handle }).handleEvent.bind(controller);
    const listener = vi.fn();
    controller.onStream(listener);
    const owner = { runId: 'announce:v1:agent:main:subagent:silent-child' };

    emit('lifecycle', { phase: 'start' }, owner);
    emit('run_status', { phase: 'starting_model' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 0 }), owner);
    emit('item', requestActivityItem(), owner);
    emit('assistant', { text: 'NO_RE' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 8 }), owner);
    emit('item', requestActivityItem(), owner);
    emit('assistant', { text: 'NO_REPLY' }, owner);
    emit('lifecycle', { phase: 'end' }, owner);

    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.transcript.activeTurn).toBeNull();
    expect(controller.state.runActivity).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  test('starts a dormant announce when visible content follows many content-free updates', () => {
    controller.disconnect();
    controller = new ChatController();
    controller.state.sessionKey = sessionKey;
    controller.state.currentSessionId = 'physical-session';
    controller.state.transcript = createChatTranscriptState(sessionKey, 'physical-session');
    handle = (controller as unknown as { handleEvent: typeof handle }).handleEvent.bind(controller);
    const owner = { runId: 'announce:v1:agent:main:subagent:visible-child' };

    emit('lifecycle', { phase: 'start' }, owner);
    vi.setSystemTime(5_000);
    for (let index = 0; index < 150; index++)
      emit('item', progressItem({ kind: 'model', receivedChars: index }), owner);
    expect(controller.state.transcript.activeTurn).toBeNull();
    emit('assistant', { text: 'Visible child summary' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 200 }), owner);

    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatRunId).toBe(owner.runId);
    expect(controller.state.transcript.activeTurn).toMatchObject({
      runId: owner.runId,
      startedAt: 1_000,
      items: [expect.objectContaining({ type: 'content', text: 'Visible child summary' })],
    });
    expect(controller.state.runActivity).toMatchObject({
      stage: 'responding',
      progress: { kind: 'model-stream', receivedChars: 200 },
    });
  });

  test('does not wake a cached session from dormant-announce progress metadata', async () => {
    handle({
      event: 'chat',
      payload: {
        sessionKey,
        runId: 'run-progress',
        state: 'final',
        message: { role: 'assistant', content: 'Done' },
      },
    });
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    const owner = { runId: 'announce:v1:agent:main:subagent:silent-child' };
    emit('run_status', { phase: 'starting_model' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 8 }), owner);
    emit('item', requestActivityItem(), owner);
    emit('assistant', { text: 'NO_REPLY' }, owner);
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.transcript.activeTurn).toBeNull();
    expect(controller.state.runActivity).toBeNull();
  });

  test('retains command-output progress received while the session is in the background', async () => {
    emit('tool', { phase: 'start', toolCallId: 'command-1', name: 'exec', args: {} });
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    emit('command_output', { toolCallId: 'command-1', output: 'test output', phase: 'delta' });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.runActivity).toMatchObject({
      stage: 'running-tool',
      progress: { kind: 'tool', toolCallId: 'command-1', outputChars: 11 },
    });
  });

  test('keeps background public progress attached to the reporting parallel tool', async () => {
    emit('tool', { phase: 'start', toolCallId: 'command-1', name: 'exec', args: {} });
    emit('tool', { phase: 'start', toolCallId: 'command-2', name: 'exec', args: {} });
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    emit('item', {
      kind: 'tool',
      phase: 'update',
      itemId: 'tool:command-1',
      toolCallId: 'command-1',
      progressText: 'First operation continuing',
    });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.runActivity).toMatchObject({
      stage: 'running-tool',
      progress: {
        kind: 'tool',
        toolCallId: 'command-1',
        summary: 'First operation continuing',
      },
    });
  });

  test('retains format-retry progress received while the session is in the background', async () => {
    emit('item', progressItem({ kind: 'model', receivedChars: 150 }));
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    emit('lifecycle', {
      phase: 'progress',
      stage: 'retrying',
      reason: 'tool_call_format',
      retryAttempt: 1,
      maxRetries: 2,
      at: Date.now(),
    });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.runActivity).toMatchObject({
      stage: 'retrying',
      retryReason: 'tool_call_format',
      retryAttempt: 1,
      maxRetries: 2,
    });
    expect(controller.state.runActivity).not.toHaveProperty('progress');
  });

  test('rejects malformed counters and prototype keys', () => {
    expect(readRunProgress('item', progressItem({ kind: 'model' }))).toBeNull();
    for (const receivedChars of [-1, Infinity, 1.5, '30']) {
      expect(readRunProgress('item', progressItem({ kind: 'model', receivedChars }))).toBeNull();
    }
    expect(readRunProgress('run_status', { phase: '__proto__' })).toBeNull();
    expect(
      readRunProgress('item', progressItem({ kind: 'tool-input', receivedChars: 10 })),
    ).toBeNull();
    expect(
      readRunProgress('item', {
        ...progressItem({ kind: 'model', receivedChars: 10 }),
        itemId: 'unrelated-status',
      }),
    ).toBeNull();
  });

  test('accepts only the exact request-activity envelope with its original timestamp', () => {
    expect(readRunProgress('item', requestActivityItem(1_250))).toEqual({
      stage: 'receiving-model', modelActivity: true,
      progress: { kind: 'model-activity' }, at: 1_250,
    });
    const invalid: Record<string, unknown>[] = [
      { itemId: 'other-status' }, { kind: 'tool' }, { phase: 'end' }, { status: 'completed' },
      { progress: { kind: 'model' } }, { progress: { kind: 'tool-input' } },
      { progress: [] }, { progress: null },
      ...[undefined, -1, Infinity, 1.5, '1250'].map(at => ({ at })),
    ];
    for (const override of invalid) {
      expect(readRunProgress('item', { ...requestActivityItem(), ...override })).toBeNull();
    }
    expect(readRunProgress('lifecycle', requestActivityItem())).toBeNull();
    expect(readRunProgress('item', {
      ...progressItem({ kind: 'model-activity' }), at: 1_250,
    })).toBeNull();
  });
});
