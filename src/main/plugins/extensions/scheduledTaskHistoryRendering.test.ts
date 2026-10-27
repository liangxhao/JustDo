import { afterEach, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/timeline/project-history-timeline';
import { PersistedTimelineRenderCache } from '@/libs/openclaw-chat/model/timeline/timeline-render-cache';
import { normalizeGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import { registerScheduledTaskHistory } from '../../../../plugins/extensions/runtime-services/scheduled-task-history';
import { createNestedToolActivity } from '../../../../plugins/extensions/runtime-services/tests/fixtures/nested-tool-activity';

const sdk = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-paths', () => ({
  resolveStorePath: () => '/native/sessions.json',
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  resolveTranscriptSessionKeyBySessionId: sdk.resolve,
}));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  readVisibleSessionTranscriptMessageEntries: sdk.read,
}));

afterEach(() => {
  vi.resetAllMocks();
});

test.each([false, true])(
  'folds cron browser history and retains nested tool details (failed child: %s)',
  async isError => {
    const sessionKey = 'agent:main:cron:task:run:physical-run';
    const entries = [
      { entryId: 'prompt', message: { role: 'user', content: 'Read the news' } },
      ...[1, 2, 3].flatMap(index => [
        {
          entryId: `assistant-${index}`,
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: `Inspect news source ${index}` },
              { type: 'toolCall', id: `outer-${index}`, name: 'tool_call', arguments: {} },
            ],
          },
        },
        {
          entryId: `activity-${index}`,
          message: createNestedToolActivity(index, index === 2 && isError),
        },
        {
          entryId: `result-${index}`,
          message: {
            role: 'toolResult',
            toolCallId: `outer-${index}`,
            toolName: 'tool_call',
            content: [{ type: 'text', text: 'Dispatch finished' }],
          },
        },
      ]),
      {
        entryId: 'final',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Summarize the news' },
            { type: 'text', text: 'Today’s news summary' },
          ],
        },
      },
    ];
    const original = structuredClone(entries);
    sdk.resolve.mockReturnValue('agent:main:cron:task');
    sdk.read.mockResolvedValue(entries);
    const register = vi.fn();
    registerScheduledTaskHistory({
      registerGatewayMethod: register,
      runtime: { config: { current: () => ({}) } },
    } as never);
    const respond = vi.fn();
    await register.mock.calls[0][1]({
      params: { sessionKey, sessionId: 'physical-run' },
      respond,
    });
    expect(respond.mock.calls[0][0]).toBe(true);
    const messages = await normalizeGatewayHistoryForDisplay(
      JSON.parse(respond.mock.calls[0][1].chunk),
      { sessionKey },
    );
    const rows = new PersistedTimelineRenderCache().get(
      projectPersistedTimeline(messages as GatewayMessage[]),
    ).rows;
    expect(rows.map(row => row.item.kind)).toEqual([
      'history-message',
      'completed-process',
      'history-message',
    ]);
    const history = rows[1].item;
    if (history.kind !== 'completed-process') throw new Error('Missing process history');
    expect(history.items).toHaveLength(1);
    const summary = history.items[0];
    if (summary.kind !== 'process-summary') throw new Error('Missing process summary');
    const tools = summary.items.filter(item => item.type === 'tool');
    expect(tools).toHaveLength(6);
    expect(summary.thinkingCount).toBe(4);
    for (const index of [1, 2, 3]) {
      expect(tools.find(tool => tool.toolCallId === `nested-${index}`)).toMatchObject({
        runId: 'native-run',
        name: 'browser',
        status: index === 2 && isError ? 'failed' : 'completed',
        input: { action: 'text', targetId: `tab-${index}` },
        output: index === 2 && isError ? 'Page unavailable' : `News page ${index}`,
        presentation: { parentToolCallId: `outer-${index}` },
      });
    }
    expect(rows[2].item).toMatchObject({
      kind: 'history-message',
      message: { id: 'final', content: [{ type: 'text', text: 'Today’s news summary' }] },
    });
    expect(entries).toEqual(original);
  },
);
