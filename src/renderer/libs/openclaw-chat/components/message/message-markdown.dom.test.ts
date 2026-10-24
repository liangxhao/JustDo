// @vitest-environment jsdom

import { render, type TemplateResult } from 'lit';
import { describe, expect, test } from 'vitest';

import {
  renderAssistantTimelineContent,
  renderMessageBlock,
  renderStreamingThinkingGroup,
} from './message-render';

function messageBubble(role: 'user' | 'assistant', text: string): TemplateResult {
  return renderMessageBlock({
    kind: 'group',
    key: `${role}-markdown`,
    role,
    messages: [{ key: `${role}-message`, message: { role, content: text, timestamp: 1 } }],
    timestamp: 1,
    isStreaming: false,
  }) as TemplateResult;
}

describe('shared Markdown rendering in chat bubbles', () => {
  test.each([false, true])('hides inline reasoning in assistant bodies (streaming: %s)', streaming => {
    const host = document.createElement('div');
    const source = '<think>PRIVATE_THOUGHT</think>Public answer with `<think>literal</think>`.';
    const template = (text: string) => streaming
      ? renderAssistantTimelineContent(text, { key: 'legacy-body', timestamp: 1, streaming: true })
      : messageBubble('assistant', text);
    if (streaming) {
      for (let index = 1; index <= '<think>PRIVATE_THOUGHT'.length; index++) {
        render(template(source.slice(0, index)), host);
        expect(host.textContent).not.toContain('PRIVATE_THOUGHT');
      }
    }
    render(template(source), host);
    expect(host.querySelector('.chat-bubble__text')?.textContent)
      .toContain(streaming
        ? 'Public answer with `<think>literal</think>`.'
        : 'Public answer with <think>literal</think>.');
    expect(host.textContent).not.toContain('PRIVATE_THOUGHT');
  });

  test.each([
    ['user', '.chat-bubble--user .markdown-content', (text: string) => messageBubble('user', text)],
    [
      'content',
      '.chat-bubble--assistant .markdown-content',
      (text: string) => messageBubble('assistant', text),
    ],
    ['thinking', '.chat-thinking__content [data-thinking-body]', (text: string) => renderStreamingThinkingGroup(text)],
    [
      'streaming content',
      '.chat-bubble--assistant .markdown-content',
      (text: string) =>
        renderAssistantTimelineContent(text, {
          key: 'streaming-markdown',
          timestamp: 1,
          streaming: true,
        }),
    ],
  ] as const)(
    'renders paired single-line dividers in the %s bubble',
    (_label, selector, renderBubble) => {
      const host = document.createElement('div');

      render(renderBubble('---\n**哈哈哈**\n---\n\n'), host);

      const body = host.querySelector(selector);
      expect(body).not.toBeNull();
      expect(Array.from(body!.children, element => element.tagName)).toEqual(['HR', 'P', 'HR']);
      expect(body!.querySelector('p > strong')?.textContent).toBe('哈哈哈');
    },
  );
});
