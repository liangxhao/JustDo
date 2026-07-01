import { describe, expect, test, vi } from 'vitest';

vi.mock('./markdown', () => ({
  toSanitizedMarkdownHtml: (text: string) => text,
  toStreamingMarkdownHtml: (text: string) => text,
}));

import type { MessageGroup } from '../types';
import {
  formatGroupTimestamp,
  getGroupFooterLabel,
  renderMessageGroup,
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
} from './grouped-render';

function createGroup(role: string): MessageGroup {
  return {
    kind: 'group',
    key: `${role}-group`,
    role,
    messages: [{ key: `${role}-msg`, message: { role, content: 'hello', timestamp: 1 } }],
    timestamp: 1,
    isStreaming: false,
  };
}

function stringifyTemplate(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(stringifyTemplate).join('');
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  const strings = record.strings;
  const values = record.values;
  if (Array.isArray(strings) && Array.isArray(values)) {
    return strings
      .map((part, index) => `${String(part)}${stringifyTemplate(values[index])}`)
      .join('');
  }
  return Object.values(record).map(stringifyTemplate).join('');
}

describe('shouldRenderGroupFooter', () => {
  test('hides assistant footer when another assistant group follows', () => {
    expect(shouldRenderGroupFooterByNextItem(createGroup('assistant'), createGroup('assistant'))).toBe(
      false,
    );
  });

  test('hides assistant footer while streaming continues', () => {
    expect(
      shouldRenderGroupFooterByNextItem(createGroup('assistant'), {
        kind: 'stream',
        key: 'stream-1',
        text: 'loading',
        startedAt: 1,
        isStreaming: true,
      }),
    ).toBe(false);
  });

  test('shows assistant footer when the next item is a different role', () => {
    expect(shouldRenderGroupFooterByNextItem(createGroup('assistant'), createGroup('user'))).toBe(
      true,
    );
  });

  test('keeps user footers visible unless another user group follows', () => {
    expect(shouldRenderGroupFooterByNextItem(createGroup('user'), createGroup('assistant'))).toBe(
      true,
    );
  });
});

describe('shouldRenderGroupAvatarByPrevItem', () => {
  test('hides avatar when the previous visible group has the same role', () => {
    expect(
      shouldRenderGroupAvatarByPrevItem(createGroup('assistant'), createGroup('assistant')),
    ).toBe(false);
  });

  test('hides assistant avatar when a stream is continuing the same turn', () => {
    expect(
      shouldRenderGroupAvatarByPrevItem(createGroup('assistant'), {
        kind: 'stream',
        key: 'stream-1',
        text: 'loading',
        startedAt: 1,
        isStreaming: true,
      }),
    ).toBe(false);
  });

  test('shows avatar when the previous visible group is a different role', () => {
    expect(shouldRenderGroupAvatarByPrevItem(createGroup('assistant'), createGroup('user'))).toBe(
      true,
    );
  });
});

describe('group footer helpers', () => {
  test('uses assistant model name when present', () => {
    expect(
      getGroupFooterLabel({
        ...createGroup('assistant'),
        modelName: 'gpt-4.1',
      }),
    ).toBe('gpt-4.1');
  });

  test('falls back to assistant label when model name is missing', () => {
    expect(getGroupFooterLabel(createGroup('assistant'))).toBe('Assistant');
  });

  test('ignores empty string model names and still falls back', () => {
    expect(
      getGroupFooterLabel({
        ...createGroup('assistant'),
        modelName: '   ',
      }),
    ).toBe('Assistant');
  });

  test('formats timestamps as yyyy-mm-dd hh:mm', () => {
    const date = new Date(2026, 6, 1, 9, 5);
    expect(formatGroupTimestamp(date)).toBe('2026-07-01 09:05');
  });
});

describe('renderMessageGroup', () => {
  test('keeps assistant text before a later tool call in the same history message', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-msg',
            message: {
              role: 'assistant',
              timestamp: 1,
              content: [
                { type: 'thinking', thinking: 'Need to clean up.' },
                { type: 'text', text: 'Here is the file. Now cleaning up.' },
                {
                  type: 'toolCall',
                  id: 'tool-1',
                  name: 'exec',
                  arguments: { command: 'Remove-Item tmp.js' },
                },
              ],
              __justdoAttachedToolMessages: [
                {
                  role: 'toolResult',
                  toolCallId: 'tool-1',
                  toolName: 'exec',
                  content: [{ type: 'text', text: '(no output)' }],
                },
              ],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    const thinkingIndex = rendered.indexOf('Need to clean up.');
    const textIndex = rendered.indexOf('Here is the file. Now cleaning up.');
    const toolIndex = rendered.indexOf('Remove-Item tmp.js');

    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(thinkingIndex);
    expect(toolIndex).toBeGreaterThan(textIndex);
    expect(rendered.match(/tool-timeline__item /g)).toHaveLength(1);
    expect(rendered).toContain('tool-timeline__item--completed');
    expect(rendered).not.toContain('tool-timeline__item--running');
  });

  test('keeps input for a tool call after assistant text when result is attached', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-msg',
            message: {
              role: 'assistant',
              timestamp: 1782877052824,
              content: [
                { type: 'thinking', thinking: 'The document is generated.' },
                { type: 'text', text: '现在清理一下临时文件~' },
                {
                  type: 'toolCall',
                  id: 'call_00_iIMN8XpMcvtg9VBlJxGo2769',
                  name: 'exec',
                  arguments: {},
                  partialArgs:
                    '{"command":"Remove-Item \\"E:\\\\workspace\\\\examples\\\\1111\\\\create_doc.js\\" -Force 2>&1","timeout":5}',
                },
              ],
              __justdoAttachedToolMessages: [
                {
                  role: 'assistant',
                  toolCallId: 'call_00_iIMN8XpMcvtg9VBlJxGo2769',
                  toolName: 'exec',
                  content: [
                    {
                      type: 'toolcall',
                      toolCallId: 'call_00_iIMN8XpMcvtg9VBlJxGo2769',
                      name: 'exec',
                      arguments: {},
                    },
                    {
                      type: 'toolresult',
                      toolCallId: 'call_00_iIMN8XpMcvtg9VBlJxGo2769',
                      name: 'exec',
                      text: '(no output)',
                    },
                  ],
                  isError: false,
                },
              ],
            },
          },
        ],
        timestamp: 1782877052824,
        isStreaming: false,
      }),
    );

    expect(rendered.match(/tool-timeline__item /g)).toHaveLength(1);
    expect(rendered).toContain('Remove-Item');
    expect(rendered).toContain('create_doc.js');
    expect(rendered).toContain('"timeout": 5');
    expect(rendered).not.toContain('<pre><code>{}</code></pre>');
  });
});
