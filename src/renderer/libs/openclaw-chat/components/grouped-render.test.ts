import { describe, expect, test, vi } from 'vitest';

vi.mock('./markdown', () => ({
  toSanitizedMarkdownHtml: (text: string) => text,
  toStreamingMarkdownHtml: (text: string) => text,
}));

import {
  formatGroupTimestamp,
  getGroupFooterLabel,
  getThinkingToolsGroupToolCount,
  renderMessageGroup,
  renderThinkingToolsContentGroup,
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
  splitThinkingToolsGroup,
} from '@/libs/openclaw-chat/components/grouped-render';
import type { MessageGroup } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

function createThinkingToolsGroup(
  toolCount: number,
  includeText = false,
  isActive = false,
): MessageGroup {
  return {
    kind: 'group',
    key: 'thinking-tools-group',
    role: 'assistant',
    messages: [
      {
        key: 'thinking-tools-message',
        message: {
          role: 'assistant',
          __justdoToolActive: isActive,
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            ...Array.from({ length: toolCount }, (_, index) => ({
              type: 'tool_use',
              id: `tool-${index}`,
              name: `Tool${index}`,
              input: {},
            })),
            ...(includeText ? [{ type: 'text', text: 'answer' }] : []),
          ],
        },
      },
    ],
    timestamp: 1,
    isStreaming: false,
  };
}

describe('getThinkingToolsGroupToolCount', () => {
  test('counts tools in a Thinking and Tools group', () => {
    expect(getThinkingToolsGroupToolCount(createThinkingToolsGroup(3))).toBe(3);
  });

  test('counts tools when the group also contains Content', () => {
    expect(getThinkingToolsGroupToolCount(createThinkingToolsGroup(2, true))).toBe(2);
  });

  test('treats reasoning blocks as Thinking for collapsing', () => {
    const group = createThinkingToolsGroup(1);
    const message = group.messages[0]?.message as { content: Array<Record<string, unknown>> };
    message.content[0] = { type: 'reasoning', text: 'reasoning content' };

    expect(getThinkingToolsGroupToolCount(group)).toBe(1);
  });

  test.each([
    ['Thinking, Tools, Content', ['thinking', 'tool_use', 'tool_use', 'text']],
    ['Thinking, Content, Tools', ['thinking', 'text', 'tool_use', 'tool_use']],
  ])('keeps Content outside the collapsed group for %s', (_label, blockOrder) => {
    const blocks = blockOrder.map((type, index) => {
      if (type === 'thinking') return { type, thinking: 'reasoning' };
      if (type === 'text') return { type, text: 'answer for the user' };
      return { type, id: `tool-${index}`, name: `Tool${index}`, input: {} };
    });
    const group = createThinkingToolsGroup(0);
    group.messages[0] = {
      ...group.messages[0],
      message: { role: 'assistant', content: blocks },
    };

    const collapse = splitThinkingToolsGroup(group);

    expect(collapse?.toolCount).toBe(2);
    expect(
      (
        collapse?.collapsedGroup.messages[0]?.message as { content: Array<{ type: string }> }
      ).content.map(block => block.type),
    ).toEqual(blockOrder.filter(type => type !== 'text'));
    expect(
      (collapse?.contentGroup?.messages[0]?.message as { content: Array<Record<string, unknown>> })
        .content,
    ).toEqual([{ type: 'text', text: 'answer for the user' }]);
  });

  test('keeps every user-visible block outside the collapsed process group', () => {
    const group = createThinkingToolsGroup(1);
    const message = group.messages[0]?.message as { content: Array<Record<string, unknown>> };
    message.content.push(
      { type: 'image', url: 'https://example.com/image.png' },
      {
        type: 'canvas',
        preview: {
          kind: 'canvas',
          surface: 'assistant_message',
          render: 'url',
          url: 'https://example.com/preview',
        },
      },
    );

    const collapse = splitThinkingToolsGroup(group);
    const collapsedContent = (
      collapse?.collapsedGroup.messages[0]?.message as { content: Array<{ type: string }> }
    ).content;
    const visibleContent = (
      collapse?.contentGroup?.messages[0]?.message as { content: Array<{ type: string }> }
    ).content;

    expect(collapsedContent.map(block => block.type)).toEqual(['thinking', 'tool_use']);
    expect(visibleContent.map(block => block.type)).toEqual(['image', 'canvas']);
  });

  test('does not match a Thinking and Tools group until its tool completes', () => {
    expect(getThinkingToolsGroupToolCount(createThinkingToolsGroup(1, false, true))).toBeNull();
    expect(getThinkingToolsGroupToolCount(createThinkingToolsGroup(1, false, false))).toBe(1);
  });

  test('does not match while an attached tool is active', () => {
    const baseGroup = createThinkingToolsGroup(1);
    const group = {
      ...baseGroup,
      messages: baseGroup.messages.map(entry => ({
        ...entry,
        message: {
          ...(entry.message as Record<string, unknown>),
          __justdoAttachedToolMessages: [
            {
              role: 'assistant',
              toolCallId: 'attached-tool',
              toolName: 'AttachedTool',
              __justdoToolActive: true,
              content: [{ type: 'toolcall', toolCallId: 'attached-tool', name: 'AttachedTool' }],
            },
          ],
        },
      })),
    };

    expect(getThinkingToolsGroupToolCount(group)).toBeNull();
  });
});

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

function templateIncludesAttribute(
  value: unknown,
  className: string,
  attributeName: string,
): boolean {
  if (value === null || value === undefined || typeof value === 'boolean') return false;
  if (Array.isArray(value)) {
    return value.some(item => templateIncludesAttribute(item, className, attributeName));
  }
  if (typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const strings = record.strings;
  const values = record.values;
  if (Array.isArray(strings) && Array.isArray(values)) {
    for (let index = 0; index < strings.length; index += 1) {
      const part = String(strings[index]);
      if (
        part.includes(`class="${className}"`) &&
        part.includes(` ${attributeName}=`) &&
        values[index] === true
      ) {
        return true;
      }
      if (templateIncludesAttribute(values[index], className, attributeName)) {
        return true;
      }
    }
    return false;
  }
  return Object.values(record).some(item =>
    templateIncludesAttribute(item, className, attributeName),
  );
}

describe('shouldRenderGroupFooter', () => {
  test('hides assistant footer when another assistant group follows', () => {
    expect(
      shouldRenderGroupFooterByNextItem(createGroup('assistant'), createGroup('assistant')),
    ).toBe(false);
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

  test('renders a split Content footer only at the end of the assistant sequence', () => {
    const sourceGroup = createThinkingToolsGroup(1, true);
    const contentGroup = splitThinkingToolsGroup(sourceGroup)?.contentGroup;
    expect(contentGroup).not.toBeNull();

    const continued = stringifyTemplate(
      renderThinkingToolsContentGroup(
        contentGroup as MessageGroup,
        sourceGroup,
        createGroup('assistant'),
      ),
    );
    const completed = stringifyTemplate(
      renderThinkingToolsContentGroup(contentGroup as MessageGroup, sourceGroup, null),
    );

    expect(continued).not.toContain('chat-group__footer');
    expect(completed).toContain('chat-group__footer');
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
    expect(getGroupFooterLabel(createGroup('assistant'))).toBe(
      i18nService.t('coworkAssistantLabel'),
    );
  });

  test('ignores empty string model names and still falls back', () => {
    expect(
      getGroupFooterLabel({
        ...createGroup('assistant'),
        modelName: '   ',
      }),
    ).toBe(i18nService.t('coworkAssistantLabel'));
  });

  test('uses the configured assistant name when model metadata is unavailable', () => {
    expect(getGroupFooterLabel(createGroup('assistant'), 'Research Agent')).toBe('Research Agent');
  });

  test('formats timestamps as yyyy-mm-dd hh:mm', () => {
    const date = new Date(2026, 6, 1, 9, 5);
    expect(formatGroupTimestamp(date)).toBe('2026-07-01 09:05');
  });
});

describe('renderMessageGroup', () => {
  test('applies Markdown styles to user message content', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'user-code-group',
        role: 'user',
        messages: [
          {
            key: 'user-code-message',
            message: { role: 'user', content: '```python\nprint("hello")\n```', timestamp: 1 },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('class="chat-bubble__text markdown-content"');
  });

  test('hides zero usage from an ordered OpenClaw goal reply', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'goal-complete-group',
        role: 'assistant',
        messages: [
          {
            key: 'goal-complete-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Goal complete: Write a poem\nTokens used: 0',
                },
              ],
              provider: 'openclaw',
              model: 'gateway-injected',
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('Goal complete: Write a poem');
    expect(rendered).not.toContain('Tokens used: 0');
  });

  test('hides zero usage from split ordered Goal text blocks', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'split-goal-complete-group',
        role: 'assistant',
        messages: [
          {
            key: 'split-goal-complete-message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Goal complete: Write a poem' },
                { type: 'text', text: 'Tokens used: 0' },
              ],
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('Goal complete: Write a poem');
    expect(rendered).not.toContain('Tokens used: 0');
  });

  test('renders Canvas content and removes its embed directive from visible text', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-canvas-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-canvas-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Preview below\n[embed url="https://example.com/view" title="Report" height="420" /]',
                },
              ],
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('class="assistant-canvas__frame"');
    expect(rendered).toContain('https://example.com/view');
    expect(rendered).toContain('height: 420px');
    expect(rendered).not.toContain('[embed');
  });

  test('renders a MEDIA file attachment from user message content', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'user-media-group',
        role: 'user',
        messages: [
          {
            key: 'user-media-msg',
            message: {
              role: 'user',
              content: 'Review this file\nMEDIA:C:\\openclaw\\media\\brief.pdf',
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('message-attachment');
    expect(rendered).toContain('brief.pdf');
    expect(rendered).toContain('C:\\openclaw\\media\\brief.pdf');
    expect(rendered).not.toContain('MEDIA:');
  });

  test('renders an assistant MEDIA image URL as an image', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-media-image-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-media-image-msg',
            message: {
              role: 'assistant',
              content: '图片已生成\nMEDIA:https://container/generated/image.png',
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('chat-bubble__images--assistant');
    expect(rendered).toContain('class="chat-bubble__image"');
    expect(rendered).toContain('https://container/generated/image.png');
    expect(rendered).not.toContain('message-attachment');
    expect(rendered).not.toContain('MEDIA:');
  });

  test('renders a persisted transcript file attachment from MediaPath fields', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'user-file-group',
        role: 'user',
        messages: [
          {
            key: 'user-file-msg',
            message: {
              role: 'user',
              content: 'Review this file',
              timestamp: 1,
              MediaPath: 'C:\\openclaw\\media\\brief.pdf',
              MediaType: 'application/pdf',
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('message-attachment');
    expect(rendered).toContain('brief.pdf');
    expect(rendered).toContain('C:\\openclaw\\media\\brief.pdf');
  });

  test('renders every persisted transcript file attachment from MediaPaths fields', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'user-files-group',
        role: 'user',
        messages: [
          {
            key: 'user-files-msg',
            message: {
              role: 'user',
              content: 'Compare these files',
              timestamp: 1,
              MediaPaths: ['/openclaw/media/first.pdf', '/openclaw/media/second.txt'],
              MediaTypes: ['application/pdf', 'text/plain'],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('first.pdf');
    expect(rendered).toContain('second.txt');
  });

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

  test('keeps the outer tools summary collapsed by default', () => {
    const message = {
      role: 'assistant',
      timestamp: 1782877052824,
      content: [
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'WebFetch',
          arguments: { url: 'https://www.baidu.com/s?wd=最新新闻', maxChars: 5000 },
        },
      ],
    };
    const collapsed = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-group-collapsed',
        role: 'assistant',
        messages: [{ key: 'assistant-msg-collapsed', message }],
        timestamp: 1782877052824,
        isStreaming: false,
      }),
    );
    const expanded = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-group-expanded',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-msg-expanded',
            message: { ...message, __justdoToolTimelineOpen: true },
          },
        ],
        timestamp: 1782877052824,
        isStreaming: false,
      }),
    );

    expect(collapsed).toContain('class="tool-timeline__summary"');
    expect(collapsed).toContain('1 tools: WebFetch');
    expect(collapsed).toContain('WebFetch');
    expect(collapsed).toContain('{"url":"https://www.baidu.com/s?wd=最新新闻","maxChars":5000}');
    expect(collapsed).toContain('class="tool-timeline__body"');
    expect(expanded).toContain('class="tool-timeline__summary"');
    expect(expanded).toContain('class="tool-timeline__body"');
    expect(expanded).toContain('tool-timeline__summary-input');
  });

  test('renders consecutive history tool blocks as one collapsed tools timeline', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-group-tools',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-msg-tools',
            message: {
              role: 'assistant',
              timestamp: 1782877052824,
              content: [
                {
                  type: 'toolCall',
                  id: 'call_1',
                  name: 'Read',
                  arguments: { file_path: 'README.md' },
                },
                {
                  type: 'toolCall',
                  id: 'call_2',
                  name: 'Write',
                  arguments: { file_path: 'out.txt', content: 'ok' },
                },
                {
                  type: 'toolCall',
                  id: 'call_3',
                  name: 'Bash',
                  arguments: { command: 'npm test' },
                },
              ],
            },
          },
        ],
        timestamp: 1782877052824,
        isStreaming: false,
      }),
    );

    expect(rendered.match(/class="tool-timeline"/g)).toHaveLength(1);
    expect(rendered).toContain('3 tools: Read、Write、Bash');
    expect(rendered.match(/tool-timeline__item /g)).toHaveLength(3);
  });

  test('marks an empty tool result as completed instead of running', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-empty-tool-result',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-empty-tool-result-message',
            message: {
              role: 'assistant',
              content: [{ type: 'toolresult', id: 'call-empty', name: 'exec', text: '' }],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('tool-timeline__item--completed');
    expect(rendered).not.toContain('tool-timeline__item--running');
    expect(rendered).toContain(i18nService.t('coworkToolNoOutput'));
  });

  test('detects structured error tool output in a timeline', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'assistant-error-tool-result',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-error-tool-result-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'toolresult',
                  id: 'call-error',
                  name: 'exec',
                  text: '{"error":"permission denied"}',
                },
              ],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('tool-timeline__item--error');
  });

  test('does not treat benign text containing the word errors as a tool failure', () => {
    const rendered = stringifyTemplate(
      renderMessageGroup({
        kind: 'group',
        key: 'standalone-tool-success',
        role: 'tool',
        messages: [
          {
            key: 'standalone-tool-success-message',
            message: {
              role: 'tool',
              toolName: 'test',
              content: [{ type: 'text', text: 'Completed with 0 errors' }],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).not.toContain('tool-message--error');
  });

  test('keeps tool input and result details collapsed even when the tools timeline is open', () => {
    const rendered = renderMessageGroup({
      kind: 'group',
      key: 'assistant-group-expanded',
      role: 'assistant',
      messages: [
        {
          key: 'assistant-msg-expanded',
          message: {
            role: 'assistant',
            timestamp: 1782877052824,
            __justdoToolTimelineOpen: true,
            content: [
              {
                type: 'toolCall',
                id: 'call_1',
                name: 'Read',
                arguments: { file_path: 'README.md' },
              },
            ],
          },
        },
      ],
      timestamp: 1782877052824,
      isStreaming: false,
    });

    expect(stringifyTemplate(rendered)).toContain('class="tool-timeline"');
    expect(templateIncludesAttribute(rendered, 'tool-timeline__body', 'open')).toBe(false);
  });
});
