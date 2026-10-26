/** @vitest-environment jsdom */

import '../justdo-chat';

import { afterEach, describe, expect, test } from 'vitest';

import type {
  AskUserResponse,
  Question,
} from '../../../../../../plugins/extensions/ask-user-question/contracts/result';
import type { AssistantTurn, ToolItem } from '../../model/chat-transcript-state';
import type { GatewayMessage } from '../../types';
import type { JustDoChatElement } from '../justdo-chat';
import { materializeDisclosureContents } from './disclosure-content';

const questions: Question[] = [
  {
    id: 'stack',
    question: '使用哪种技术栈？',
    options: [
      { id: 'react', label: 'React + TypeScript' },
      { id: 'vue', label: 'Vue + TypeScript' },
    ],
    defaultOptionIds: ['react'],
  },
];
const input = { questions };
const result = (response: AskUserResponse) => ({ version: 1 as const, questions, response });

function createHistory(response?: AskUserResponse) {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = [
    { role: 'user', content: '创建项目', __openclaw: { id: 'prompt' } },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '开始前确认技术栈。' },
        { type: 'toolCall', id: 'question-1', name: 'ask_user_question', arguments: input },
      ],
      __openclaw: { id: 'question-call' },
    },
    ...(response
      ? [
          {
            role: 'toolResult',
            toolCallId: 'question-1',
            toolName: 'ask_user_question',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  askUserQuestion: result(response),
                  summary: 'Model-facing tool summary',
                }),
              },
            ],
            __openclaw: { id: 'question-result' },
          },
          { role: 'assistant', content: '继续创建项目。', __openclaw: { id: 'final' } },
        ]
      : []),
  ] as GatewayMessage[];
  document.body.append(chat);
  return chat;
}

async function inspect(chat: JustDoChatElement) {
  await chat.updateComplete;
  materializeDisclosureContents(chat.shadowRoot!);
  return chat.shadowRoot!;
}

afterEach(() => document.body.replaceChildren());

describe('question history host boundary', () => {
  test.each([false, true])(
    'keeps human and default answers inside one closed process group (defaults: %s)',
    async timedOut => {
      const chat = createHistory({
        status: 'answered',
        timedOut,
        answers: { stack: { selected: ['react'] } },
      });
      const messages = chat.messages;
      const root = await inspect(chat);
      const disclosures = root.querySelectorAll<HTMLDetailsElement>('.completed-process');
      expect(disclosures).toHaveLength(1);
      expect(disclosures[0].open).toBe(false);
      expect(
        disclosures[0].querySelector('.completed-process__label--collapsed')!.textContent,
      ).toBe('展开处理过程');
      const answer = root.querySelector('.question-answer')!;
      expect(answer.closest('.completed-process')).toBe(disclosures[0]);
      expect(answer.textContent).toContain('使用哪种技术栈？');
      expect(answer.textContent).toContain('React + TypeScript');
      expect(answer.classList.contains('question-answer--human')).toBe(!timedOut);
      expect(answer.textContent).toContain(timedOut ? '系统自动选择' : '你的回答');
      const final = root.querySelector('[data-entry-id="final"]')!;
      expect(final.closest('.completed-process')).toBeNull();
      expect(chat.messages).toBe(messages);
      expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(disclosures[0].textContent).not.toContain('Model-facing tool summary');
    },
  );

  test('keeps pending historical questions closed without an inline form', async () => {
    const root = await inspect(createHistory());
    const disclosure = root.querySelector<HTMLDetailsElement>('.completed-process')!;
    expect(disclosure).not.toBeNull();
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain('等待你的回答');
    expect(disclosure.querySelector('input, textarea, select, form')).toBeNull();
  });

  test('uses the same closed process disclosure for a live pending question', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    const tool: ToolItem = {
      id: 'live-question',
      runId: 'live-run',
      toolCallId: 'call-live',
      type: 'tool',
      name: 'ask_user_question',
      input,
      status: 'running',
      firstSeq: 1,
      lastSeq: 1,
      startedAt: 1,
      updatedAt: 1,
    };
    chat.activeTurn = {
      id: 'live-run',
      runId: 'live-run',
      sessionId: 'session',
      sessionKey: 'key',
      lifecycleGeneration: null,
      lastAgentSeq: 1,
      startedAt: 1,
      status: 'running',
      items: [tool],
      toolById: new Map([[tool.toolCallId, tool]]),
    } satisfies AssistantTurn;
    chat.isStreaming = true;
    document.body.append(chat);
    const root = await inspect(chat);
    const disclosure = root.querySelector<HTMLDetailsElement>('.completed-process')!;
    expect(disclosure).not.toBeNull();
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain('等待你的回答');
    expect(root.querySelector('.process-live--tool')).toBeNull();
  });
});
