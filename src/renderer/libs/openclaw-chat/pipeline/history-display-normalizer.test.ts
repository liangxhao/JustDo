import { composeBrowserGatewayPrompt } from '@shared/browser/browser';
import { OPENCLAW_HISTORY_DETAIL_MAX_IDS } from '@shared/openclaw/historyIpc';
import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { readTranscriptIdentity } from '@/libs/openclaw-chat/model/history/transcript-identity';
import { mergePendingUserMessageForDisplay } from '@/libs/openclaw-chat/model/input/optimistic-user-message';
import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/timeline/project-history-timeline';
import { prepareVisibleTimelineRows } from '@/libs/openclaw-chat/model/timeline/timeline-avatar-state';
import {
  FAILED_RUN_MESSAGE_FLAG,
  FAILED_RUN_MESSAGE_ID,
} from '@/libs/openclaw-chat/model/turn/failed-run-message';
import {
  collapseRepeatedFailures,
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
  test.each(['Exec completed (job, code 0)', 'Exec failed (job, code 1)'])(
    'hides native exec wake-ups while retaining human messages: %s',
    text => {
      const content = `${text}\nSession selected: provider/model Reason: high`;
      const internal = {
        role: 'user', content,
        provenance: { kind: 'internal_system', sourceTool: 'exec' },
      };
      const human = { role: 'user', content };
      const external = { ...human, provenance: { kind: 'external_user', sourceTool: 'exec' } };
      const peer = { ...human, provenance: { kind: 'inter_session', sourceTool: 'exec' } };
      const reply = { role: 'assistant', content: 'Command result received.' };
      expect(projectGatewayHistoryForDisplay([human, internal, external, peer, reply]))
        .toEqual([human, external, peer, reply]);
      expect(projectGatewayHistoryForDisplay([{ ...internal, content: [{ type: 'text', text: content }] }]))
        .toEqual([]);
    },
  );
  test('keeps a different recording pending even when both visible prompts are empty', () => {
    const prompt = (id: string) =>
      composeBrowserGatewayPrompt('', [], {
        id,
        sessionId: 'session',
        profile: 'embedded',
        title: '',
        note: '',
        startedAt: 1,
        images: [],
        steps: [
          {
            id,
            action: 'click',
            pageId: 'tab',
            at: 0,
            url: 'https://example.com/',
            title: 'Example',
          },
        ],
      });
    const history = projectGatewayHistoryForDisplay([
      { role: 'user', content: prompt('first'), timestamp: 100 },
    ]) as GatewayMessage[];
    const pending = projectGatewayHistoryForDisplay([
      { role: 'user', content: prompt('second'), timestamp: 110 },
    ])[0] as GatewayMessage;
    expect(mergePendingUserMessageForDisplay(history, pending)).toEqual([...history, pending]);
    const plain = { role: 'user', content: '', timestamp: 100 } as GatewayMessage;
    expect(mergePendingUserMessageForDisplay([plain], pending)).toEqual([plain, pending]);
    const rawPending = { role: 'user', content: prompt('first'), timestamp: 110 } as GatewayMessage;
    expect(mergePendingUserMessageForDisplay(history, rawPending)).toEqual(history);
  });
  test.each([false, true])(
    'restores a recording-only history message and replaces its pending bubble (sanitized=%s)',
    sanitized => {
      const prompt = composeBrowserGatewayPrompt('', [], {
        id: 'recording',
        sessionId: 'session',
        profile: 'embedded',
        title: '',
        note: 'x'.repeat(60),
        startedAt: 1,
        images: [],
        steps: [
          {
            id: 'step',
            action: 'click',
            pageId: 'tab',
            at: 0,
            url: 'https://example.com/',
            title: 'Example',
          },
        ],
      }).replace(`"note":"${'x'.repeat(60)}"`, `"note":"${'\u200b'.repeat(60)}"`);
      const pending = projectGatewayHistoryForDisplay([
        { role: 'user', content: prompt, timestamp: 100 },
      ])[0] as GatewayMessage;
      const history = projectGatewayHistoryForDisplay([
        {
          role: 'user',
          content: [
            { type: 'text', text: (sanitized ? prompt.replace(/\u200b/g, '') : prompt).trim() },
          ],
          timestamp: 110,
        },
      ]) as GatewayMessage[];
      expect(history[0].content).toEqual([
        { type: 'text', text: '' },
        {
          type: 'browser_recording',
          recording: expect.objectContaining({
            steps: [expect.objectContaining({ id: 'step', action: 'click' })],
          }),
        },
      ]);
      expect(mergePendingUserMessageForDisplay(history, pending)).toEqual(history);
      expect(projectGatewayHistoryForDisplay(history)).toEqual(history);
    },
  );
  test('collapses the managed-media companion when the producer row already owns the file', () => {
    const source = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Generated the file.\n\n## Generated file\n\nMEDIA:C:\\workspace\\quick_sort.py\n\n## Checks',
        },
      ],
      openclawDelivery: { mediaUrls: ['C:\\workspace\\quick_sort.py'] },
    };
    const companion = {
      role: 'assistant',
      model: 'gateway-injected',
      content: [{ type: 'text', text: 'Generated the file.\n\n## Generated file\n\n## Checks' }],
      openclawDisplayContent: [
        { type: 'text', text: 'Generated the file.\n\n## Generated file\n\n## Checks' },
        {
          type: 'attachment',
          attachment: {
            url: '/api/chat/media/outgoing/session/file/full',
            kind: 'document',
            label: 'quick_sort.py',
          },
        },
      ],
    };

    expect(projectGatewayHistoryForDisplay([source, companion])).toEqual([source]);
  });

  test('keeps a gateway-injected attachment that is not a duplicate delivery companion', () => {
    const source = {
      role: 'assistant',
      content: 'Generated the first file.\nMEDIA:C:\\workspace\\first.py',
      openclawDelivery: { mediaUrls: ['C:\\workspace\\first.py'] },
    };
    const distinct = {
      role: 'assistant',
      model: 'gateway-injected',
      content: [
        { type: 'text', text: 'Generated another file.' },
        {
          type: 'attachment',
          attachment: {
            url: '/api/chat/media/outgoing/session/file/full',
            kind: 'document',
            label: 'second.py',
          },
        },
      ],
    };

    expect(projectGatewayHistoryForDisplay([source, distinct])).toEqual([source, distinct]);
  });

  test('collapses a flat native audio companion only when its producer owns that same delivery', () => {
    const source = {
      role: 'assistant',
      content: 'Done.',
      openclawDelivery: { mediaUrls: ['E:/output/voice.wav'] },
    };
    const companion = {
      role: 'assistant',
      model: 'gateway-injected',
      __openclaw: { seq: 7 },
      content: [
        { type: 'text', text: 'Done.' },
        {
          type: 'audio',
          artifactId: 'audio-id',
          url: '/api/chat/media/outgoing/session/audio/full',
          fileName: 'voice.wav',
          mimeType: 'audio/wav',
        },
      ],
    };
    expect(projectGatewayHistoryForDisplay([source, companion])).toHaveLength(1);
    const textOnly = { role: 'assistant', content: 'Done.' };
    expect(projectGatewayHistoryForDisplay([textOnly, companion])).toEqual([textOnly, companion]);
  });

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

  test('hides browser context while preserving the original user prompt', () => {
    const projected = projectGatewayHistoryForDisplay([
      {
        role: 'user',
        content: composeBrowserGatewayPrompt('Review this marked control.', [
          {
            id: 'annotation-1',
            modelContext: 'Untrusted browser context',
            title: 'Example',
            displayUrl: 'example.com',
            markedRegionCount: 1,
            inspectedElement: true,
            dataUrl: 'data:image/png;base64,YWJj',
            fileName: 'browser-annotation.png',
            addedAt: 1,
          },
        ]),
      },
    ]);

    expect(projected).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this marked control.' },
          {
            type: 'browser_annotation',
            annotation: {
              id: 'annotation-1',
              title: 'Example',
              displayUrl: 'example.com',
              markedRegionCount: 1,
            },
          },
        ],
      },
    ]);
  });

  test('restores multiple browser annotations after stripping inbound metadata', () => {
    const gatewayPrompt = composeBrowserGatewayPrompt('Compare these controls.', [
      {
        id: 'annotation-1',
        modelContext: 'First untrusted browser context',
        title: 'First',
        displayUrl: 'first.example',
        markedRegionCount: 1,
        inspectedElement: true,
        dataUrl: 'data:image/png;base64,YWJj',
        fileName: 'first.png',
        addedAt: 1,
      },
      {
        id: 'annotation-2',
        modelContext: 'Second untrusted browser context',
        title: 'Second',
        displayUrl: 'second.example',
        markedRegionCount: 2,
        inspectedElement: false,
        dataUrl: 'data:image/png;base64,YWJj',
        fileName: 'second.png',
        addedAt: 2,
      },
    ]);

    const projected = projectGatewayHistoryForDisplay([
      { role: 'user', content: `[[inbound:generated metadata]]\n${gatewayPrompt}` },
    ]);

    expect(projected).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these controls.' },
          {
            type: 'browser_annotation',
            annotation: expect.objectContaining({ id: 'annotation-1', title: 'First' }),
          },
          {
            type: 'browser_annotation',
            annotation: expect.objectContaining({ id: 'annotation-2', title: 'Second' }),
          },
        ],
      },
    ]);
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
  test('keeps distinct known failed-run identities without native run IDs', () => {
    const messages = [
      { role: 'user', content: 'Request' },
      ...['run-a', 'run-b'].map(id => ({
        role: 'system',
        content: 'Connection error.',
        [FAILED_RUN_MESSAGE_FLAG]: true,
        [FAILED_RUN_MESSAGE_ID]: id,
      })),
    ];
    expect(collapseRepeatedFailures(messages)).toEqual(messages);
  });

  test('compares rendered failure text and retains attached tool results', () => {
    const failure = {
      role: 'system',
      runId: 'run-a',
      [FAILED_RUN_MESSAGE_FLAG]: true,
      errorMessage: 'Same raw error.',
    };
    const messages = [
      { ...failure, content: 'First visible error.' },
      { ...failure, content: 'Second visible error.' },
      {
        ...failure,
        content: 'Second visible error.',
        __justdoAttachedToolMessages: [{ role: 'toolResult', toolCallId: 't1', content: 'Result' }],
      },
    ];
    expect(collapseRepeatedFailures(messages)).toEqual(messages);
  });

  const normalizeRetryDisplay = async (
    ...args: Parameters<typeof normalizeGatewayHistoryForDisplay>
  ) => collapseRepeatedFailures(await normalizeGatewayHistoryForDisplay(...args));
  const retryFailure = (runId?: string, errorMessage = 'Connection error.') => ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage,
    ...(runId ? { runId } : {}),
  });
  const retryOptions = { sessionKey: 'agent:main:justdo:retry-display' };

  test('collapses live durable errors only in projection and keeps the history sequence intact', async () => {
    const input = [
      { role: 'user', content: 'Request' },
      ...Array.from({ length: 4 }, (_, index) => ({
        ...retryFailure('run-1'),
        __openclaw: { id: `error-${index}`, messageSeq: index + 2 },
      })),
      { role: 'user', content: 'Next request' },
      retryFailure('run-2'),
    ] as GatewayMessage[];
    const original = structuredClone(input);
    expect(collapseRepeatedFailures(input)).toHaveLength(4);
    const normalized = await normalizeGatewayHistoryForDisplay(input, retryOptions);
    const projected = projectPersistedTimeline(normalized as GatewayMessage[]);
    expect(projected.filter(item => item.kind === 'history-message')).toHaveLength(4);
    expect(input).toEqual(original);
    expect(input).toHaveLength(7);
  });

  test.each(['run-1', undefined])(
    'collapses four identical attempts within a user turn (%s)',
    async runId => {
      const input = [
        { role: 'user', content: 'First request' },
        ...Array.from({ length: 4 }, (_, index) => ({
          ...retryFailure(runId),
          timestamp: 1000 + index,
        })),
      ];
      const original = structuredClone(input);
      const result = await normalizeRetryDisplay(input, retryOptions);
      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({ content: 'Connection error.', isError: true });
      expect(input).toEqual(original);
      expect(await normalizeRetryDisplay(input, retryOptions)).toEqual(result);
      expect(await normalizeRetryDisplay(result, retryOptions)).toEqual(result);
    },
  );

  test.each(['run-1', undefined])(
    'preserves later user requests and successful replies (%s)',
    async runId => {
      const nextRunId = runId ? 'run-2' : undefined;
      const result = await normalizeRetryDisplay(
        [
          { role: 'user', content: 'First request' },
          retryFailure(runId),
          retryFailure(runId),
          { role: 'user', content: 'Second request' },
          retryFailure(nextRunId),
          retryFailure(nextRunId),
          { role: 'user', content: 'Third request' },
          { role: 'assistant', content: 'Success', runId: 'run-3' },
        ],
        retryOptions,
      );
      expect(result.map(message => (message as GatewayMessage).content)).toEqual([
        'First request',
        'Connection error.',
        'Second request',
        'Connection error.',
        'Third request',
        'Success',
      ]);
    },
  );

  test('preserves different runs, changed errors and failures separated by tool output', async () => {
    const input = [
      { role: 'user', content: 'Request' },
      retryFailure('run-1'),
      retryFailure('run-2'),
      retryFailure('run-2', 'Authentication failed.'),
      { role: 'toolResult', content: 'Tool output', toolCallId: 'tool-1' },
      retryFailure('run-2', 'Authentication failed.'),
    ];
    expect(await normalizeRetryDisplay(input, retryOptions)).toHaveLength(input.length);
  });

  test('does not infer anonymous run identity across a partial history page', async () => {
    expect(
      await normalizeRetryDisplay([retryFailure(), retryFailure()], retryOptions),
    ).toHaveLength(2);
  });

  test('does not carry deduplication state into another session or snapshot', async () => {
    const input = [{ role: 'user', content: 'Request' }, retryFailure(), retryFailure()];
    expect(await normalizeRetryDisplay(input, retryOptions)).toHaveLength(2);
    expect(
      await normalizeRetryDisplay(input, {
        sessionKey: 'agent:main:justdo:another-session',
      }),
    ).toHaveLength(2);
    expect(await normalizeRetryDisplay([retryFailure()], retryOptions)).toHaveLength(1);
  });

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

  test.each([false, true])(
    'keeps the native receipt instead of adding a local failure overlay (enveloped=%s)',
    async enveloped => {
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      });
      const timestamp = Date.now();
      const sessionKey = 'agent:main:receipt-session';
      const error = 'Persisted user turn changed before replay admission';
      persistFailedRun({ sessionKey, runId: 'run-1', error, timestamp });
      const receipt = {
        role: 'custom',
        customType: 'run-failed-before-reply',
        content: `Your request couldn't be completed: ${error}`,
        display: true,
        timestamp,
        __openclaw: { id: 'failure-receipt', runId: 'run-1' },
      };
      const history = [
        { role: 'user', content: 'Continue', timestamp: timestamp - 100 },
        enveloped ? { message: receipt } : receipt,
      ];
      const before = structuredClone(history);
      const result = await normalizeGatewayHistoryForDisplay(history, { sessionKey });
      expect(result).toEqual(before);
      expect(history).toEqual(before);

      const otherRun = { ...receipt, __openclaw: { id: 'other-receipt', runId: 'run-other' } };
      const otherResult = await normalizeGatewayHistoryForDisplay([history[0], otherRun], {
        sessionKey,
      });
      expect(otherResult).toHaveLength(3);
      expect(otherResult).toContainEqual(otherRun);

      persistFailedRun({ sessionKey, runId: null, error: 'Unscoped failure', timestamp });
      const unscopedResult = await normalizeGatewayHistoryForDisplay(history, { sessionKey });
      expect(unscopedResult).toHaveLength(3);
      expect(unscopedResult).toContainEqual(
        expect.objectContaining({ content: 'Unscoped failure', [FAILED_RUN_MESSAGE_FLAG]: true }),
      );
    },
  );

  test('keeps a persisted failure independent of the session last error', async () => {
    const messages = await normalizeGatewayHistoryForDisplay(
      [
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Durable provider diagnostic',
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
        content: 'Durable provider diagnostic',
        stopReason: 'error',
        errorMessage: 'Durable provider diagnostic',
        isError: true,
        __justdoFailedRunMessage: true,
      },
    ]);
  });

  test.each([
    'The agent run failed before producing a reply.',
    "OpenClaw couldn't finish this reply.",
  ])('keeps ordinary assistant text without inferring a failure: %s', async content => {
    const original = [{ role: 'assistant', content }];
    const messages = await normalizeGatewayHistoryForDisplay(original, {
      sessionKey: 'agent:main:ordinary-reply',
      lastError: 'Unrelated latest session error',
    });

    expect(messages).toEqual(original);
    expect(messages[0]).not.toHaveProperty(FAILED_RUN_MESSAGE_FLAG);
  });

  test('does not invent a diagnostic for an empty failure without a recorded cause', async () => {
    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'assistant', content: [], stopReason: 'error' }],
      { sessionKey: 'agent:main:unknown-failure', includeFailedRunOverlays: false },
    );

    expect(messages).toEqual([
      {
        role: 'system',
        content: '',
        stopReason: 'error',
        isError: true,
        [FAILED_RUN_MESSAGE_FLAG]: true,
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
          content: [],
          stopReason: 'error',
          errorMessage: 'Older provider diagnostic',
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
        { role: 'assistant', content: [], stopReason: 'error' },
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
          content: [],
          stopReason: 'error',
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

  test('assigns an anonymous failure identity without replacing its existing native text', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const timestamp = Date.now();
    const sessionKey = 'agent:main:anonymous-failure';
    persistFailedRun({
      sessionKey,
      runId: 'run-1',
      error: 'Local authentication failure',
      timestamp,
      promptTimestamp: timestamp - 500,
    });
    const nativeFailure = {
      role: 'system',
      content: 'The agent run failed before producing a reply.',
      isError: true,
      [FAILED_RUN_MESSAGE_FLAG]: true,
    };

    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'user', content: 'Continue', timestamp: timestamp - 500 }, nativeFailure],
      { sessionKey },
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ ...nativeFailure, [FAILED_RUN_MESSAGE_ID]: 'run-1' });
    expect(nativeFailure).not.toHaveProperty(FAILED_RUN_MESSAGE_ID);
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
          content: [],
          stopReason: 'error',
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
          content: [],
          stopReason: 'error',
        },
        {
          role: 'assistant',
          runId: 'run-internal',
          content: [],
          stopReason: 'error',
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
        stopReason: 'error',
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
            content: [],
            stopReason: 'error',
            errorMessage: 'Durable provider request rejected',
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
          content: 'Durable provider request rejected',
          stopReason: 'error',
          errorMessage: 'Durable provider request rejected',
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

  test('hydrates native compaction entry details for shared history consumers', async () => {
    const getCompactionDetails = vi.fn().mockResolvedValue({
      success: true,
      details: {
        'compact-1': { summary: 'Earlier work summary' },
      },
    });
    vi.stubGlobal('electron', { openclaw: { history: { getCompactionDetails } } });
    const messages = await normalizeGatewayHistoryForDisplay(
      [{ role: 'system', __openclaw: { kind: 'compaction', id: 'compact-1' } }],
      { sessionKey: 'agent:main:main' },
    );
    expect(getCompactionDetails).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      entryIds: ['compact-1'],
    });
    expect(messages[0]).toEqual(
      expect.objectContaining({
        __openclaw: expect.objectContaining({ summary: 'Earlier work summary' }),
      }),
    );
  });
});
