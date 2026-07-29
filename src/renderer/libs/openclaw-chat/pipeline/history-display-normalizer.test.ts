import { afterEach, describe, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';
import {
  normalizeGatewayHistoryForDisplay,
  projectGatewayHistoryForDisplay,
} from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('projectGatewayHistoryForDisplay', () => {
  test('removes persisted control artifacts while preserving legitimate assistant text', () => {
    const projected = projectGatewayHistoryForDisplay([
      { role: 'assistant', content: 'Visible answer\nNO_REPLY' },
      { role: 'assistant', content: 'NO_RE' },
      { role: 'assistant', content: 'HEARTBEAT_OK' },
      { role: 'assistant', content: 'temporary', __openclawStreamFallback: true },
      { role: 'assistant', content: 'NO' },
    ]);

    expect(projected).toEqual([
      { role: 'assistant', content: 'Visible answer' },
      { role: 'assistant', content: 'NO' },
    ]);
  });
});

describe('normalizeGatewayHistoryForDisplay', () => {
  test('turns a persisted pre-reply failure into a visible error', async () => {
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
        content: 'Model request failed',
        isError: true,
      },
    ]);
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
    const enrichCompactionMarkers = vi.fn(
      async (messages: unknown[]) =>
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
