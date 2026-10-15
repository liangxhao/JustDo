/** @vitest-environment jsdom */

import './justdo-chat';

import { html, render } from 'lit';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { GatewayMessage } from '../types';
import { renderCompletedProcess } from './completed-process';
import type { JustDoChatElement } from './justdo-chat';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function createChat(state: 'running' | 'completed' = 'completed') {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = [
    {
      role: 'user',
      content: 'inspect',
      timestamp: 1_000,
      __openclaw: { id: 'user', runId: 'run-1' },
    },
    {
      role: 'assistant',
      timestamp: 1_100,
      __openclaw: { id: 'intermediate', runId: 'run-1' },
      content: [
        { type: 'thinking', thinking: 'Inspecting the configuration' },
        { type: 'text', text: 'Intermediate explanation' },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'config.json' } },
      ],
    },
    {
      role: 'toolResult',
      timestamp: 1_200,
      toolCallId: 'read-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'Read successfully' }],
      __openclaw: { id: 'result', runId: 'run-1' },
    },
    {
      role: 'assistant',
      content: 'Final answer\n\nSecond paragraph with **`variable`**.',
      timestamp: 2_000,
      __openclaw: { id: 'final', runId: 'run-1' },
    },
  ] satisfies GatewayMessage[];
  chat.runTimings = [
    {
      id: 'receipt-1',
      rootRunId: 'run-1',
      clientTurnId: 'turn-1',
      sessionId: 'session-1',
      startedAt: 1_000,
      ...(state === 'completed' ? { endedAt: 3_000 } : {}),
      state,
    },
  ];
  document.body.append(chat);
  return chat;
}

describe('completed chat process history', () => {
  test('includes saved progress updates in one collapsed process and retains the compact receipt when expanded', async () => {
    const chat = createChat();
    const messages: GatewayMessage[] = [
      ...chat.messages.slice(0, -1),
      {
        role: 'assistant',
        timestamp: 1_300,
        __openclaw: { id: 'progress-call', runId: 'run-1' },
        content: [
          {
            type: 'toolCall',
            id: 'progress-1',
            name: 'progress_card',
            arguments: {
              plan: [
                { step: 'Inspect configuration', status: 'completed' },
                { step: 'Verify results', status: 'in_progress' },
              ],
            },
          },
        ],
      },
      {
        role: 'toolResult',
        timestamp: 1_400,
        toolCallId: 'progress-1',
        toolName: 'progress_card',
        content: [{ type: 'text', text: 'Updated' }],
        __openclaw: { id: 'progress-result', runId: 'run-1' },
      },
      {
        role: 'assistant',
        timestamp: 1_500,
        __openclaw: { id: 'after-progress', runId: 'run-1' },
        content: [
          { type: 'thinking', thinking: 'Checking the updated progress' },
          { type: 'text', text: 'Continuing verification' },
          { type: 'toolCall', id: 'verify-1', name: 'read', arguments: { path: 'result.json' } },
        ],
      },
      {
        role: 'toolResult',
        timestamp: 1_600,
        toolCallId: 'verify-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'Verified' }],
        __openclaw: { id: 'verify-result', runId: 'run-1' },
      },
      chat.messages[chat.messages.length - 1],
    ];
    chat.messages = messages;
    await chat.updateComplete;

    const root = chat.shadowRoot!;
    const disclosures = root.querySelectorAll<HTMLDetailsElement>('.completed-process');
    expect(disclosures).toHaveLength(1);
    const disclosure = disclosures[0];
    expect(disclosure.open).toBe(false);
    const receipt = root.querySelector('.progress-card-receipt')!;
    expect(receipt.closest('.completed-process')).toBe(disclosure);
    expect(root.querySelectorAll('.progress-card-receipt')).toHaveLength(1);
    expect(disclosure.textContent).toContain('Intermediate explanation');
    expect(disclosure.textContent).toContain('Continuing verification');
    expect(disclosure.textContent).not.toContain('Final answer');
    expect(root.querySelector('[data-entry-id="final"]')!.closest('.completed-process')).toBeNull();

    disclosure.open = true;
    chat.requestUpdate();
    await chat.updateComplete;
    expect(root.querySelector('.progress-card-receipt')).toBe(receipt);
    expect(receipt.textContent).toContain('Verify results');
    expect(chat.messages).toBe(messages);
  });

  test('defaults to collapsed, keeps the final answer outside, and retains expansion on rerender', async () => {
    const chat = createChat();
    await chat.updateComplete;
    const details = chat.shadowRoot!.querySelector<HTMLDetailsElement>('.completed-process')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Intermediate explanation');
    expect(details.querySelector('.completed-process__items')!.closest('.chat-group')).toBeNull();
    expect(
      details.querySelectorAll(
        '.completed-process__items > .chat-group, .completed-process__items > .chat-history-row',
      ),
    ).toHaveLength(3);
    expect(details.textContent).not.toContain('Final answer');
    const final = chat.shadowRoot!.querySelector('[data-entry-id="final"]')!;
    expect(final.closest('.completed-process')).toBeNull();
    expect(final.textContent).toContain('Second paragraph');

    details.open = true;
    chat.requestUpdate();
    await chat.updateComplete;
    expect(chat.shadowRoot!.querySelector('.completed-process')).toBe(details);
    expect(details.open).toBe(true);
    details.open = false;
    expect(details.open).toBe(false);
  });

  test('does not collapse the current run while Main still reports it running', async () => {
    const chat = createChat('running');
    await chat.updateComplete;
    expect(chat.shadowRoot!.querySelector('.completed-process')).toBeNull();
    expect(chat.shadowRoot!.textContent).toContain('Intermediate explanation');
  });

  test('bulk process controls expand and collapse the outer disclosure and nested summaries', async () => {
    const chat = createChat();
    await chat.updateComplete;
    const root = chat.shadowRoot!;
    const details = root.querySelector<HTMLDetailsElement>('.completed-process')!;
    expect(details.open).toBe(false);

    chat.processSummariesExpanded = true;
    await chat.updateComplete;

    expect(details.open).toBe(true);
    expect(root.querySelectorAll('.process-summary[aria-expanded="true"]')).toHaveLength(2);

    chat.processSummariesExpanded = false;
    await chat.updateComplete;

    expect(details.open).toBe(false);
    expect(root.querySelectorAll('.process-summary[aria-expanded="true"]')).toHaveLength(0);
  });

  test.each([0, 100])(
    'renders a revealed diagram without scrolling (host top: %i)',
    async hostTop => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrameId = 1;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      const chat = createChat();
      chat.messages = [
        { role: 'user', content: 'Draw a diagram', __openclaw: { id: 'prompt' } },
        {
          role: 'assistant',
          content: '```mermaid\nflowchart LR\nA-->B\n```',
          __openclaw: { id: 'diagram' },
        },
        { role: 'assistant', content: 'Final answer', __openclaw: { id: 'final' } },
      ];
      chat.getBoundingClientRect = () => new DOMRect(0, hostTop, 800, 600);
      await chat.updateComplete;
      const block = chat.shadowRoot!.querySelector<HTMLElement>('.mermaid-block')!;
      const details = block.closest('details')!;
      block.getBoundingClientRect = () =>
        details.open ? new DOMRect(0, 200, 200, 100) : new DOMRect();
      const drainFrames = async () => {
        for (let count = 0; frames.size && count < 100; count += 1) {
          const [id, callback] = frames.entries().next().value!;
          frames.delete(id);
          callback(performance.now());
          await chat.updateComplete;
        }
        expect(frames.size).toBe(0);
      };
      await drainFrames();
      expect(block.dataset.mermaidRendered).toBeUndefined();

      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      await drainFrames();

      expect(block.dataset.mermaidRendered).toBe('true');
    },
  );

  test('folds native history with no local receipts or per-message run IDs', async () => {
    const chat = createChat();
    chat.runTimings = [];
    chat.messages = chat.messages.map(message => ({
      ...message,
      __openclaw: { id: message.__openclaw?.id },
    }));
    await chat.updateComplete;

    const details = chat.shadowRoot!.querySelector<HTMLDetailsElement>('.completed-process')!;
    expect(details).not.toBeNull();
    expect(details.querySelector('.completed-process__label--collapsed')!.textContent).toBe(
      '展开处理过程',
    );
    expect(details.querySelectorAll('.process-summary-group')).toHaveLength(2);
    expect(details.textContent).toContain('Intermediate explanation');
    expect(details.textContent).not.toContain('Final answer');
  });

  test('folds both historical turns when an older local receipt retains the previous root run ID', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    const round = (id: string, start: number): GatewayMessage[] => [
      { role: 'user', content: `prompt-${id}`, timestamp: start, __openclaw: { id: `user-${id}` } },
      {
        role: 'assistant',
        timestamp: start + 1,
        __openclaw: { id: `process-${id}` },
        content: [
          { type: 'thinking', thinking: `inspect-${id}` },
          { type: 'text', text: `commentary-${id}` },
          { type: 'toolCall', id: `read-${id}`, name: 'read', arguments: {} },
        ],
      },
      {
        role: 'toolResult',
        timestamp: start + 2,
        toolCallId: `read-${id}`,
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        __openclaw: { id: `result-${id}` },
      },
      {
        role: 'assistant',
        content: `answer-${id}`,
        timestamp: start + 3,
        __openclaw: { id: `final-${id}`, runId: `run-${id}` },
      },
    ];
    chat.messages = [...round('one', 1_000), ...round('two', 300_000)];
    chat.runTimings = [
      {
        id: 'receipt-one',
        rootRunId: 'run-one',
        clientTurnId: 'client-one',
        sessionId: 'session',
        startedAt: 1_000,
        endedAt: 2_000,
        state: 'completed',
      },
      {
        id: 'receipt-two',
        rootRunId: 'run-one',
        clientTurnId: 'client-two',
        sessionId: 'session',
        startedAt: 300_000,
        endedAt: 301_000,
        state: 'completed',
      },
    ];
    document.body.append(chat);
    await chat.updateComplete;

    const disclosures = chat.shadowRoot!.querySelectorAll<HTMLDetailsElement>('.completed-process');
    expect(disclosures).toHaveLength(2);
    for (const [index, id] of ['one', 'two'].entries()) {
      expect(disclosures[index].textContent).toContain(`commentary-${id}`);
      expect(
        disclosures[index].querySelector('.completed-process__label--collapsed')!.textContent,
      ).toBe('展开处理过程');
      expect(
        chat
          .shadowRoot!.querySelector(`[data-entry-id="final-${id}"]`)!
          .closest('.completed-process'),
      ).toBeNull();
    }
    expect(chat.runTimings[1].rootRunId).toBe('run-one');
  });

  test('protects a streamed tail even if its local receipt is stale or absent', async () => {
    const chat = createChat();
    chat.runTimings = [];
    chat.isStreaming = true;
    await chat.updateComplete;
    expect(chat.shadowRoot!.querySelector('.completed-process')).toBeNull();

    chat.isStreaming = false;
    await chat.updateComplete;
    expect(chat.shadowRoot!.querySelector('.completed-process')).not.toBeNull();
  });

  test('keeps failed tool attempts inside one disclosure across three interleaved process clusters', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    const messages: GatewayMessage[] = [
      { role: 'user', content: 'Call the tools', __openclaw: { id: 'prompt' } },
    ];
    for (const [phase, toolCount] of [1, 4, 4].entries()) {
      const thinkingCount = phase === 2 ? 2 : 1;
      messages.push({
        role: 'assistant',
        __openclaw: { id: `process-${phase}` },
        content: [
          ...Array.from({ length: thinkingCount }, (_, index) => ({
            type: 'thinking',
            thinking: `Thinking ${phase}-${index}`,
          })),
          ...Array.from({ length: toolCount }, (_, index) => ({
            type: 'toolCall',
            id: `call-${phase}-${index}`,
            name: 'echo',
            arguments: {},
          })),
        ],
      });
      for (let index = 0; index < toolCount; index += 1) {
        const failed = phase === 1 && index < 2;
        messages.push({
          role: 'toolResult',
          toolCallId: `call-${phase}-${index}`,
          toolName: 'echo',
          isError: failed,
          content: [{ type: 'text', text: failed ? `Invalid parameters ${index}` : 'ok' }],
          __openclaw: { id: `result-${phase}-${index}` },
        });
      }
      messages.push({
        role: 'assistant',
        content:
          phase < 2
            ? `Intermediate explanation ${phase}`
            : 'Final answer\n\nComplete final paragraph.',
        __openclaw: { id: phase < 2 ? `explanation-${phase}` : 'final' },
      });
    }
    chat.messages = messages;
    document.body.append(chat);
    await chat.updateComplete;

    const root = chat.shadowRoot!;
    const disclosures = root.querySelectorAll<HTMLDetailsElement>('.completed-process');
    expect(disclosures).toHaveLength(1);
    const disclosure = disclosures[0];
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('.completed-process__label--collapsed')!.textContent).toBe(
      '展开处理过程',
    );
    expect(disclosure.querySelectorAll('.process-summary-group')).toHaveLength(3);
    expect(
      [...root.querySelectorAll('.process-summary')].filter(
        node => !node.closest('.completed-process__items'),
      ),
    ).toHaveLength(0);
    expect(disclosure.textContent).toContain('Intermediate explanation 0');
    expect(disclosure.textContent).toContain('Intermediate explanation 1');
    expect(disclosure.textContent).not.toContain('Final answer');

    disclosure.open = true;
    chat.processSummariesExpanded = true;
    await chat.updateComplete;
    expect(root.querySelectorAll('.process-summary__tool-status--failed')).toHaveLength(2);
    expect(disclosure.textContent).toContain('Invalid parameters 0');
    expect(root.querySelector('[data-entry-id="final"]')!.closest('.completed-process')).toBeNull();
    expect(root.textContent).toContain('Complete final paragraph.');
    expect(chat.messages).toBe(messages);
  });

  test('message navigation opens the process disclosure before scrolling', async () => {
    const chat = createChat();
    await chat.updateComplete;
    const target = chat.shadowRoot!.querySelector<HTMLElement>('[data-entry-id="intermediate"]')!;
    target.scrollIntoView = vi.fn();
    const details = target.closest('details')!;
    expect(details.open).toBe(false);

    expect(chat.revealMessage('intermediate')).toBe(true);

    expect(details.open).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalled();
  });

  test('resets disclosure state when the native session or history generation changes', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const show = (sessionIdentity: string) =>
      render(
        renderCompletedProcess(
          {
            kind: 'completed-process',
            key: 'same-process-key',
            items: [],
          },
          { sessionIdentity, showAvatar: false, renderItem: () => html`` },
        ),
        container,
      );
    show('session-1:generation-1');
    const initial = container.querySelector('details')!;
    initial.open = true;
    show('session-1:generation-1');
    expect(container.querySelector('details')).toBe(initial);
    expect(initial.open).toBe(true);

    show('session-1:generation-2');
    expect(container.querySelector('details')).not.toBe(initial);
    expect(container.querySelector('details')!.open).toBe(false);
  });
});
