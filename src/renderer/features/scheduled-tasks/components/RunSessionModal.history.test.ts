/** @vitest-environment jsdom */

import '@/libs/openclaw-chat/components/justdo-chat';

import { afterEach, expect, test } from 'vitest';

import type { JustDoChatElement } from '@/libs/openclaw-chat/components/justdo-chat';
import { materializeDisclosureContents } from '@/libs/openclaw-chat/components/timeline/disclosure-content';
import { normalizeGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import { projectScheduledTaskHistoryMessage } from '../../../../../plugins/extensions/runtime-services/scheduled-task-history-display';
import { createNestedToolActivity } from '../../../../../plugins/extensions/runtime-services/tests/fixtures/nested-tool-activity';

afterEach(() => document.body.replaceChildren());

test('keeps all cron browser steps inside one disclosure while the final answer remains visible', async () => {
  const messages = [
    { role: 'user', content: 'Read the news', id: 'prompt' },
    ...[1, 2].flatMap(index => [
      {
        role: 'assistant',
        id: `assistant-${index}`,
        content: [
          { type: 'thinking', thinking: `Inspect news source ${index}` },
          { type: 'toolCall', id: `outer-${index}`, name: 'tool_call', arguments: {} },
        ],
      },
      { ...createNestedToolActivity(index, index === 2), id: `activity-${index}` },
      {
        role: 'toolResult',
        id: `result-${index}`,
        toolCallId: `outer-${index}`,
        toolName: 'tool_call',
        content: [{ type: 'text', text: 'Dispatch finished' }],
      },
    ]),
    {
      role: 'assistant',
      id: 'final',
      content: [
        { type: 'thinking', thinking: 'Summarize the news' },
        { type: 'text', text: 'Today’s news summary' },
      ],
    },
  ];
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = (await normalizeGatewayHistoryForDisplay(
    messages.map(projectScheduledTaskHistoryMessage),
    { sessionKey: 'agent:main:cron:task:run:physical-run' },
  )) as GatewayMessage[];
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  const disclosure = root.querySelector<HTMLDetailsElement>('.completed-process')!;

  expect(root.querySelectorAll('.completed-process')).toHaveLength(1);
  expect(disclosure.open).toBe(false);
  expect(root.querySelectorAll('.process-summary-group')).toHaveLength(0);
  expect(root.textContent).toContain('Today’s news summary');

  chat.processSummariesExpanded = true;
  await chat.updateComplete;
  materializeDisclosureContents(root);

  expect(disclosure.open).toBe(true);
  const tools = [...root.querySelectorAll<HTMLDetailsElement>('details[data-tool-identity]')];
  expect(tools).toHaveLength(4);
  expect(tools.every(tool => disclosure.contains(tool))).toBe(true);
  for (const index of [1, 2]) {
    const tool = tools.find(
      candidate =>
        candidate.dataset.toolIdentity === JSON.stringify(['native-run', `nested-${index}`]),
    )!;
    expect(tool).toBeDefined();
    expect(tool.textContent).toContain(`tab-${index}`);
    expect(tool.textContent).toContain(index === 2 ? 'Page unavailable' : 'News page 1');
    expect(tool.querySelector('.process-summary__tool-status--failed') !== null).toBe(index === 2);
  }
  expect(disclosure.textContent).not.toContain('Today’s news summary');
});
