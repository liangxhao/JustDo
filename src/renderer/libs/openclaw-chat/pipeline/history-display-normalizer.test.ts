import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';
import { readTranscriptIdentity } from '@/libs/openclaw-chat/model/transcript-identity';
import {
  normalizeGatewayHistoryForDisplay,
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
