import { OPENCLAW_HISTORY_DETAIL_MAX_IDS } from '@shared/openclaw/historyIpc';
import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';
import { prepareVisibleTimelineRows } from '@/libs/openclaw-chat/model/timeline-avatar-state';
import { readTranscriptIdentity } from '@/libs/openclaw-chat/model/transcript-identity';
import {
  normalizeGatewayHistoryForDisplay,
  persistFailedRun,
  persistInterruptedMessage,
  projectGatewayHistoryForDisplay,
} from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('projectGatewayHistoryForDisplay', () => {
  test('projects a persisted goal feedback command as the original user feedback', () => {
    const projected = projectGatewayHistoryForDisplay([
      {
        role: 'user',
        content: buildGoalFollowUpPrompt(
          'Objective containing <follow_up_request> text',
          'Improve chapter two',
        ),
      },
    ]);

    expect(projected).toEqual([{ role: 'user', content: 'Improve chapter two' }]);
  });

  test('removes persisted control artifacts while preserving legitimate assistant text', () => {
    const projected = projectGatewayHistoryForDisplay([
      { role: 'assistant', content: 'Visible answer\nNO_REPLY' },
      { role: 'assistant', content: 'NO_RE' },
      { role: 'assistant', content: 'HEARTBEAT_OK' },
      { role: 'assistant', content: 'Use HEARTBEAT_OK as the acknowledgement token.' },
      { role: 'assistant', content: 'temporary', __openclawStreamFallback: true },
      { role: 'assistant', content: 'NO' },
    ]);

    expect(projected).toEqual([
      { role: 'assistant', content: 'Visible answer' },
      { role: 'assistant', content: 'Use HEARTBEAT_OK as the acknowledgement token.' },
      { role: 'assistant', content: 'NO' },
    ]);
  });

  test('removes legacy status-only interruption bubbles', () => {
    expect(
      projectGatewayHistoryForDisplay([
        {
          role: 'assistant',
          content: [{ type: 'text', text: '运行已中断。', interrupted: true }],
          interrupted: true,
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Partial model output', interrupted: true }],
          interrupted: true,
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial model output', interrupted: true }],
        interrupted: true,
      },
    ]);
  });
});

describe('normalizeGatewayHistoryForDisplay', () => {
  test.each([250, 251, 501])('hydrates %i tool results in bounded batches', async count => {
    const sessionKey = 'agent:main:justdo:large-history';
    const getToolInputs = vi.fn(async (params: { sessionKey: string; toolCallIds: string[] }) => {
      expect(params.sessionKey).toBe(sessionKey);
      expect(params.toolCallIds.length).toBeLessThanOrEqual(OPENCLAW_HISTORY_DETAIL_MAX_IDS);
      return {
        success: true,
        inputs: Object.fromEntries(
          params.toolCallIds.map(id => [id, { name: 'read', input: { path: id } }]),
        ),
      };
    });
    vi.stubGlobal('electron', { openclaw: { history: { getToolInputs } } });
    const source = Array.from({ length: count }, (_, index) => ({
      role: 'toolResult',
      toolCallId: `call-${index}`,
      content: 'result',
    }));

    const messages = await normalizeGatewayHistoryForDisplay(source, { sessionKey });

    expect(getToolInputs).toHaveBeenCalledTimes(Math.ceil(count / OPENCLAW_HISTORY_DETAIL_MAX_IDS));
    expect(getToolInputs.mock.calls.flatMap(([params]) => params.toolCallIds)).toEqual(
      source.map(message => message.toolCallId),
    );
    expect(messages).toEqual(
      source.map(message => ({
        ...message,
        toolName: 'read',
        toolInput: { path: message.toolCallId },
      })),
    );
  });

  test.each([250, 251, 501])('hydrates %i compaction markers in bounded batches', async count => {
    const sessionKey = 'agent:main:justdo:large-history';
    const getCompactionDetails = vi.fn(
      async (params: { sessionKey: string; entryIds: string[] }) => {
        expect(params.sessionKey).toBe(sessionKey);
        expect(params.entryIds.length).toBeLessThanOrEqual(OPENCLAW_HISTORY_DETAIL_MAX_IDS);
        return {
          success: true,
          details: Object.fromEntries(
            params.entryIds.map(id => [
              id,
              { summary: `Summary ${id}`, tokensBefore: 1000, tokensAfter: 100 },
            ]),
          ),
        };
      },
    );
    vi.stubGlobal('electron', { openclaw: { history: { getCompactionDetails } } });
    const source = Array.from({ length: count }, (_, index) => ({
      role: 'system',
      __openclaw: { kind: 'compaction', id: `compact-${index}` },
    }));

    const messages = await normalizeGatewayHistoryForDisplay(source, { sessionKey });

    expect(getCompactionDetails).toHaveBeenCalledTimes(
      Math.ceil(count / OPENCLAW_HISTORY_DETAIL_MAX_IDS),
    );
    expect(messages).toEqual(
      source.map(message => ({
        ...message,
        __openclaw: {
          ...message.__openclaw,
          summary: `Summary ${message.__openclaw.id}`,
          tokensBefore: 1000,
          tokensAfter: 100,
        },
      })),
    );
  });

  test.each(['rejected', 'unsuccessful'])(
    'keeps history and later tool batches when a lookup is %s',
    async failure => {
      const getToolInputs = vi.fn().mockResolvedValue({
        success: true,
        inputs: { 'call-250': { name: 'read', input: { path: 'last.md' } } },
      });
      if (failure === 'rejected')
        getToolInputs.mockRejectedValueOnce(new Error('Gateway disconnected'));
      else getToolInputs.mockResolvedValueOnce({ success: false });
      vi.stubGlobal('electron', { openclaw: { history: { getToolInputs } } });
      const source = Array.from({ length: 251 }, (_, index) => ({
        role: 'toolResult',
        toolCallId: `call-${index}`,
        content: 'result',
      }));

      const messages = await normalizeGatewayHistoryForDisplay(source, {
        sessionKey: 'agent:main:justdo:history',
      });

      expect(messages).toHaveLength(source.length);
      expect(messages[0]).toEqual(source[0]);
      expect(messages[250]).toMatchObject({ toolInput: { path: 'last.md' } });
    },
  );

  test('retains successful compaction batches when a later lookup fails', async () => {
    const getCompactionDetails = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        details: { 'compact-0': { summary: 'Retained summary' } },
      })
      .mockRejectedValueOnce(new Error('Gateway disconnected'));
    vi.stubGlobal('electron', { openclaw: { history: { getCompactionDetails } } });
    const source = Array.from({ length: 251 }, (_, index) => ({
      role: 'system',
      __openclaw: { kind: 'compaction', id: `compact-${index}` },
    }));

    const messages = await normalizeGatewayHistoryForDisplay(source, {
      sessionKey: 'agent:main:justdo:history',
    });

    expect(messages).toHaveLength(source.length);
    expect(messages[0]).toMatchObject({ __openclaw: { summary: 'Retained summary' } });
    expect(messages[250]).toEqual(source[250]);
  });

  test('restores a locally persisted interrupted message across later history reloads', async () => {
    const now = Date.now();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    persistInterruptedMessage('agent:main:justdo:session-1', 'run-stopped', {
      role: 'assistant',
      content: [{ type: 'text', text: 'Truncated answer', interrupted: true }],
      timestamp: now,
      interrupted: true,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'first', timestamp: now - 100 },
        { role: 'user', content: 'next question', timestamp: now + 100 },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages.map(message => (message as Record<string, unknown>).timestamp)).toEqual([
      now - 100,
      now,
      now + 100,
    ]);
    expect(messages[1]).toMatchObject({ role: 'assistant', interrupted: true });

    const olderPage = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'older', timestamp: now - 200 }],
      {
        sessionKey: 'agent:main:justdo:session-1',
        includeInterruptedOverlays: false,
      },
    );
    expect(olderPage).toEqual([{ role: 'user', content: 'older', timestamp: now - 200 }]);
    expect(readTranscriptIdentity(messages[1])).toEqual({
      kind: 'durable-id',
      value: expect.stringContaining('interrupted:'),
    });
  });

  test('keeps a persisted failure independent of the session last error', async () => {
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'assistant',
          content: 'The agent run failed before producing a reply.',
        },
      ],
      {
        sessionKey: 'agent:main:cron:run-1',
        lastError: 'Model request failed',
      },
    );

    expect(messages).toEqual([
      {
        role: 'system',
        content: 'The agent run failed before producing a reply.',
        isError: true,
        __justdoFailedRunMessage: true,
      },
    ]);
  });

  test.each(['run-old', undefined])(
    'does not rewrite an older failure after a new failure (%s)',
    async runId => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      });
      const timestamp = Date.now();
      const sessionKey = 'agent:main:justdo:session-1';
      const history = [
        { role: 'user', content: 'First', timestamp: timestamp - 5_000 },
        {
          role: 'assistant',
          runId,
          content: 'The agent run failed before producing a reply.',
          timestamp: timestamp - 4_000,
        },
        { role: 'user', content: 'Retry', timestamp: timestamp - 500 },
      ];
      const before = await normalizeGatewayHistoryForDisplay(history, { sessionKey });
      persistFailedRun({
        sessionKey,
        runId: 'run-new',
        error: 'New provider failure',
        timestamp,
        promptTimestamp: timestamp - 500,
      });
      const after = await normalizeGatewayHistoryForDisplay(history, {
        sessionKey,
        lastError: 'New provider failure',
      });
      expect(after[1]).toEqual(before[1]);
      expect(after).toHaveLength(4);
      expect(after[3]).toMatchObject({ content: 'New provider failure', runId: 'run-new' });
    },
  );

  test.each([true, false])(
    'preserves durable error details with timestamp: %s',
    async withTimestamp => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      });
      const timestamp = Date.now();
      const sessionKey = 'agent:main:justdo:session-1';
      persistFailedRun({
        sessionKey,
        runId: 'run-1',
        error: 'Local error',
        timestamp,
        promptTimestamp: timestamp - 500,
      });
      const messages = await normalizeGatewayHistoryForDisplay(
        [
          { role: 'user', content: 'Prompt', timestamp: timestamp - 500 },
          {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Durable error',
            ...(withTimestamp ? { timestamp } : {}),
          },
        ],
        { sessionKey },
      );
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        content: 'Durable error',
        __justdoFailedRunMessageId: 'run-1',
      });
    },
  );

  test('does not overwrite an anonymous failure already assigned to another run', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    const sessionKey = 'agent:main:justdo:session-1';
    for (const [runId, error, offset] of [
      ['run-1', 'First error', 0],
      ['run-2', 'Second error', 100],
    ] as const) {
      persistFailedRun({
        sessionKey,
        runId,
        error,
        timestamp: timestamp + offset,
        promptTimestamp: timestamp - 500,
      });
    }
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'Prompt', timestamp: timestamp - 500 },
        { role: 'assistant', content: 'The agent run failed before producing a reply.' },
      ],
      { sessionKey },
    );
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      content: 'First error',
      __justdoFailedRunMessageId: 'run-1',
    });
    expect(messages[2]).toMatchObject({ content: 'Second error', runId: 'run-2' });
  });

  test('turns an empty persisted assistant error into a visible error', async () => {
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '429 insufficient balance',
          __openclaw: { runId: 'run-1' },
        },
      ],
      {
        sessionKey: 'agent:main:justdo:session-1',
      },
    );

    expect(messages).toEqual([
      {
        role: 'system',
        content: '429 insufficient balance',
        stopReason: 'error',
        errorMessage: '429 insufficient balance',
        isError: true,
        __justdoFailedRunMessage: true,
        __openclaw: { runId: 'run-1' },
      },
    ]);
  });

  test('restores a failed run when history contains only its user prompt', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'Inline API key is temporarily disabled.',
      timestamp,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'Continue', timestamp: timestamp - 250 }],
      {
        sessionKey: 'agent:main:justdo:session-1',
      },
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Continue', timestamp: timestamp - 250 },
      {
        role: 'system',
        content: 'Inline API key is temporarily disabled.',
        isError: true,
        __justdoFailedRunMessage: true,
        __justdoFailedRunMessageId: 'run-1',
        runId: 'run-1',
        timestamp,
      },
    ]);
    expect(readTranscriptIdentity(messages[1])).toEqual({
      kind: 'durable-id',
      value: 'failed-run:run-1',
    });
  });

  test('does not restore a failed run without its nearby user prompt', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'Model request failed.',
      timestamp,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'Older prompt', timestamp: timestamp - 120_000 }],
      {
        sessionKey: 'agent:main:justdo:session-1',
      },
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Older prompt', timestamp: timestamp - 120_000 },
    ]);
  });

  test('keeps partial assistant output and restores its terminal failure', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'The model stream failed.',
      timestamp,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
        {
          role: 'assistant',
          content: 'Partial reply',
          timestamp: timestamp - 200,
          __openclaw: { runId: 'run-1' },
        },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Partial reply' });
    expect(messages[2]).toMatchObject({
      role: 'system',
      content: 'The model stream failed.',
      isError: true,
      runId: 'run-1',
    });
  });

  test('keeps a failure after partial assistant output without a run id', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'The model stream failed.',
      timestamp,
      promptTimestamp: timestamp - 500,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
        { role: 'assistant', content: 'Partial reply', timestamp: timestamp - 200 },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({
      role: 'system',
      content: 'The model stream failed.',
      isError: true,
      runId: 'run-1',
    });
  });

  test('anchors a delayed failure to the prompt timestamp encoded in its run id', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const promptTimestamp = Date.now() - 180_000;
    const failureTimestamp = promptTimestamp + 120_000;
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'physical-session-1',
      runId: `justdo-${promptTimestamp}-run-1`,
      error: 'The long-running request failed.',
      timestamp: failureTimestamp,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'Run the long task', timestamp: promptTimestamp + 100 }],
      {
        sessionKey: 'agent:main:justdo:session-1',
        sessionId: 'physical-session-1',
      },
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      content: 'The long-running request failed.',
      isError: true,
      runId: `justdo-${promptTimestamp}-run-1`,
    });
  });

  test('does not restore a failure from a replaced physical session', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'physical-session-old',
      runId: 'run-1',
      error: 'Old session failed.',
      timestamp,
      promptTimestamp: timestamp - 100,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'New session prompt', timestamp: timestamp - 100 }],
      {
        sessionKey: 'agent:main:justdo:session-1',
        sessionId: 'physical-session-new',
      },
    );

    expect(messages).toEqual([
      { role: 'user', content: 'New session prompt', timestamp: timestamp - 100 },
    ]);
  });

  test('does not restore an unscoped legacy failure into a known physical session', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-legacy',
      error: 'Legacy session failed.',
      timestamp,
      promptTimestamp: timestamp - 100,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'Current session prompt', timestamp: timestamp - 100 }],
      {
        sessionKey: 'agent:main:justdo:session-1',
        sessionId: 'physical-session-current',
      },
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Current session prompt', timestamp: timestamp - 100 },
    ]);
  });

  test('does not append local failed-run overlays to an older history page', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'Recent run failed.',
      timestamp,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'Older page prompt', timestamp: timestamp - 100 }],
      {
        sessionKey: 'agent:main:justdo:session-1',
        includeFailedRunOverlays: false,
      },
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Older page prompt', timestamp: timestamp - 100 },
    ]);
  });

  test('deduplicates a durable failure without a run id against its local record', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: '429 insufficient balance',
      timestamp,
      promptTimestamp: timestamp - 500,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '429 insufficient balance',
          timestamp,
        },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'system',
      content: '429 insufficient balance',
      __justdoFailedRunMessageId: 'run-1',
    });
  });

  test('deduplicates and enriches a durable failure without identity or timestamp', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'Provider request failed.',
      timestamp,
      promptTimestamp: timestamp - 500,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
        {
          role: 'assistant',
          content: 'The agent run failed before producing a reply.',
        },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
      expect.objectContaining({
        role: 'system',
        content: 'Provider request failed.',
        __justdoFailedRunMessageId: 'run-1',
      }),
    ]);
  });

  test('does not restore a failed attempt beside a successful sibling-branch reply', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'physical-session-1',
      runId: 'run-failed',
      error: 'The first branch failed.',
      timestamp,
      promptTimestamp: timestamp - 500,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
        {
          role: 'assistant',
          content: 'The regenerated branch succeeded.',
          runId: 'run-success',
          timestamp: timestamp + 500,
        },
      ],
      {
        sessionKey: 'agent:main:justdo:session-1',
        sessionId: 'physical-session-1',
      },
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
      {
        role: 'assistant',
        content: 'The regenerated branch succeeded.',
        runId: 'run-success',
        timestamp: timestamp + 500,
      },
    ]);
  });

  test('keeps a failed run visible beside a managed subagent announcement', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-parent',
      error: 'The parent run failed.',
      timestamp,
      promptTimestamp: timestamp - 500,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        { role: 'user', content: 'Continue', timestamp: timestamp - 500 },
        {
          role: 'assistant',
          content: 'The managed subagent finished its task.',
          runId: 'announce:v1:agent:main:subagent:child-run',
          timestamp: timestamp - 200,
        },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({
      role: 'system',
      content: 'The parent run failed.',
      isError: true,
      runId: 'run-parent',
    });
  });

  test('recognizes run_id metadata and blank text blocks in durable failures', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'Provider request failed.',
      timestamp,
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '  ' }],
          stop_reason: 'error',
          metadata: { run_id: 'run-1' },
          timestamp,
        },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: 'Provider request failed.',
        isError: true,
      }),
    ]);
  });

  test('hides the internal managed handoff failure placeholder', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      error: 'Managed subagent terminal handoff could not be persisted.',
      timestamp: Date.now(),
    });
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'assistant',
          runId: 'run-1',
          content: 'The agent run failed before producing a reply.',
        },
      ],
      {
        sessionKey: 'agent:main:justdo:session-1',
      },
    );

    expect(messages).toEqual([]);
  });

  test('hides a durable internal managed handoff error without local storage context', async () => {
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Managed subagent terminal handoff could not be persisted.',
        },
      ],
      { sessionKey: 'agent:main:justdo:session-1' },
    );

    expect(messages).toEqual([]);
  });

  test('keeps unrelated failure placeholders when only one run has an internal handoff error', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-older',
      error: 'Older model request failed.',
      timestamp: Date.now() - 120_000,
    });
    persistFailedRun({
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-internal',
      error: 'Managed subagent terminal handoff could not be persisted.',
      timestamp: Date.now(),
    });
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'assistant',
          runId: 'run-older',
          content: 'The agent run failed before producing a reply.',
        },
        {
          role: 'assistant',
          runId: 'run-internal',
          content: 'The agent run failed before producing a reply.',
        },
      ],
      {
        sessionKey: 'agent:main:justdo:session-1',
        lastError: 'Managed subagent terminal handoff could not be persisted.',
      },
    );

    expect(messages).toEqual([
      {
        role: 'system',
        runId: 'run-older',
        content: 'Older model request failed.',
        isError: true,
        __justdoFailedRunMessage: true,
      },
    ]);
  });

  test('normalizes an enveloped pre-reply failure through footer projection', async () => {
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          type: 'message',
          runId: 'run-1',
          timestamp: 2_000,
          message: {
            role: 'assistant',
            content: 'The agent run failed before producing a reply.',
          },
        },
      ],
      {
        sessionKey: 'agent:main:cron:run-1',
        lastError: 'API rate limit reached. Please try again later.',
      },
    );

    expect(messages).toEqual([
      {
        type: 'message',
        runId: 'run-1',
        timestamp: 2_000,
        message: {
          role: 'system',
          content: 'The agent run failed before producing a reply.',
          isError: true,
          __justdoFailedRunMessage: true,
        },
      },
    ]);

    const timeline = projectPersistedTimeline(messages as GatewayMessage[]);
    const rows = prepareVisibleTimelineRows(timeline, {
      suppressTrailingAssistantFooter: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.showFooter).toBe(false);
  });

  test('hydrates missing tool names and arguments before timeline projection', async () => {
    const getToolInputs = vi.fn().mockResolvedValue({
      success: true,
      inputs: {
        'call-1': {
          name: 'read',
          input: { path: 'result.txt' },
        },
      },
    });
    vi.stubGlobal('electron', {
      openclaw: {
        history: {
          getToolInputs,
        },
      },
    });

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          content: 'file contents',
        },
      ],
      { sessionKey: 'agent:main:cron:run-2' },
    );

    expect(getToolInputs).toHaveBeenCalledWith({
      sessionKey: 'agent:main:cron:run-2',
      toolCallIds: ['call-1'],
    });
    expect(messages[0]).toEqual(
      expect.objectContaining({
        toolName: 'read',
        toolInput: { path: 'result.txt' },
      }),
    );
    expect(projectPersistedTimeline(messages as GatewayMessage[])).toEqual([
      expect.objectContaining({
        kind: 'process-summary',
        items: [
          expect.objectContaining({
            type: 'tool',
            name: 'read',
            input: { path: 'result.txt' },
          }),
        ],
      }),
    ]);
  });

  test('shares gateway compaction enrichment with history consumers', async () => {
    const enrichCompactionMarkers = vi.fn(async (messages: unknown[]) =>
      messages.map(message => ({
        ...(message as Record<string, unknown>),
        __openclaw: {
          ...((message as Record<string, unknown>).__openclaw as Record<string, unknown>),
          summary: 'Earlier work summary',
        },
      })),
    );

    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'system',
          __openclaw: { kind: 'compaction', id: 'compact-1' },
        },
      ],
      {
        sessionKey: 'agent:main:main',
        enrichCompactionMarkers,
      },
    );

    expect(enrichCompactionMarkers).toHaveBeenCalledOnce();
    expect(messages[0]).toEqual(
      expect.objectContaining({
        __openclaw: expect.objectContaining({
          summary: 'Earlier work summary',
        }),
      }),
    );
  });
});
