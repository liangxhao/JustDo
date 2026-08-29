import { describe, expect, test, vi } from 'vitest';

vi.mock('./markdown', () => ({
  toSanitizedMarkdownHtml: (text: string) => text,
  toStreamingMarkdownHtml: (text: string) => text,
}));

import {
  formatGroupTimestamp,
  getGroupFooterLabel,
  renderMessageBlock,
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
} from '@/libs/openclaw-chat/components/message-render';
import type { MessageGroup } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

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

  test.each(['openclaw/gateway-injected', 'gateway-injected'])(
    'uses the localized system message label for %s',
    modelName => {
      expect(
        getGroupFooterLabel({
          ...createGroup('assistant'),
          modelName,
        }),
      ).toBe(i18nService.t('coworkSystemMessageLabel'));
    },
  );

  test('uses the system message label while only the live sender label is available', () => {
    expect(
      getGroupFooterLabel({
        ...createGroup('assistant'),
        modelName: null,
        senderLabel: 'OpenClaw/Internal/Gateway-Injected',
      }),
    ).toBe(i18nService.t('coworkSystemMessageLabel'));
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

  test('does not present the configured assistant name as actual model metadata', () => {
    expect(getGroupFooterLabel(createGroup('assistant'), 'Research Agent')).toBe(
      i18nService.t('coworkAssistantLabel'),
    );
  });

  test('formats timestamps as yyyy-mm-dd hh:mm', () => {
    const date = new Date(2026, 6, 1, 9, 5);
    expect(formatGroupTimestamp(date)).toBe('2026-07-01 09:05');
  });

  test('renders a derived duration for a completed assistant turn', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
        ...createGroup('assistant'),
        timestamp: 4_500,
        durationMs: 3_500,
      }),
    );

    expect(rendered).toContain(
      i18nService.t('coworkRunWorkedDuration').replace('{duration}', '3s'),
    );
  });
});

describe('renderMessageBlock', () => {
  test('marks ordinary messages as content rows for consistent bubble spacing', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
        kind: 'group',
        key: 'content-spacing',
        role: 'assistant',
        messages: [
          {
            key: 'message-1',
            message: { role: 'assistant', content: 'First response' },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('chat-group--content');
  });

  test('applies Markdown styles to user message content', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
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
      renderMessageBlock({
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
      renderMessageBlock({
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
      renderMessageBlock({
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
      renderMessageBlock({
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
      renderMessageBlock({
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
    expect(rendered).toContain('双击放大查看');
    expect(rendered).toContain('draggable="false"');
    expect(rendered).toContain('@contextmenu=');
    expect(rendered).not.toContain('message-attachment');
    expect(rendered).not.toContain('MEDIA:');
  });

  test('renders assistant MEDIA content at its original position inside the bubble', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
        kind: 'group',
        key: 'assistant-inline-media-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-inline-media-msg',
            message: {
              role: 'assistant',
              content:
                '图片之前\nMEDIA:https://container/generated/image.png\n图片之后\nMEDIA:https://example.com/report.pdf\n文件之后',
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    const beforeImage = rendered.indexOf('图片之前');
    const image = rendered.indexOf('https://container/generated/image.png');
    const afterImage = rendered.indexOf('图片之后');
    const file = rendered.indexOf('https://example.com/report.pdf');
    const afterFile = rendered.indexOf('文件之后');

    expect(rendered.match(/chat-bubble--assistant/g)).toHaveLength(1);
    expect(beforeImage).toBeLessThan(image);
    expect(image).toBeLessThan(afterImage);
    expect(afterImage).toBeLessThan(file);
    expect(file).toBeLessThan(afterFile);
    expect(rendered).not.toContain('message-attachment__detail');
  });

  test('renders Markdown list MEDIA deliveries without dropping the following section', () => {
    const content =
      '5 个 subagent 已全部完成。\n\n## 生成文件（已核验存在）\n\n' +
      '- MEDIA:C:\\project\\task1_fib.py\n' +
      '- MEDIA:C:\\project\\task2_primes.py\n' +
      '- MEDIA:C:\\project\\task3_wordfreq.py\n' +
      '- MEDIA:C:\\project\\task4_sumsq.py\n' +
      '- MEDIA:C:\\project\\task5_json.py\n\n' +
      '## 过程备注\n\n' +
      '- 5 个文件均生成、执行并验证通过。';
    const rendered = stringifyTemplate(
      renderMessageBlock({
        kind: 'group',
        key: 'assistant-list-media-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-list-media-msg',
            message: { role: 'assistant', content, timestamp: 1 },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered.match(/class="message-attachment"/g)).toHaveLength(5);
    expect(rendered.match(/class="message-attachment-list-item__marker"/g)).toHaveLength(5);
    expect(rendered.match(/•/g)).toHaveLength(5);
    expect(rendered).not.toContain('MEDIA:');
    expect(rendered.indexOf('生成文件')).toBeLessThan(rendered.indexOf('task1_fib.py'));
    expect(rendered.indexOf('task5_json.py')).toBeLessThan(rendered.indexOf('过程备注'));
    expect(rendered).toContain('5 个文件均生成、执行并验证通过。');
  });

  test('preserves ordered list numbers for MEDIA deliveries', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
        kind: 'group',
        key: 'assistant-numbered-media-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-numbered-media-msg',
            message: {
              role: 'assistant',
              content: '1. MEDIA:C:\\project\\first.py\n2. MEDIA:C:\\project\\second.py',
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered.match(/class="message-attachment-list-item__marker"/g)).toHaveLength(2);
    expect(rendered.indexOf('1.')).toBeLessThan(rendered.indexOf('first.py'));
    expect(rendered.indexOf('2.')).toBeLessThan(rendered.indexOf('second.py'));
  });

  test('renders user MEDIA content in text order inside the user bubble', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
        kind: 'group',
        key: 'user-inline-media-group',
        role: 'user',
        messages: [
          {
            key: 'user-inline-media-msg',
            message: {
              role: 'user',
              content: '文件之前\nMEDIA:C:\\openclaw\\media\\brief.pdf\n文件之后',
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered.match(/chat-bubble--user/g)).toHaveLength(1);
    expect(rendered.indexOf('文件之前')).toBeLessThan(rendered.indexOf('brief.pdf'));
    expect(rendered.indexOf('brief.pdf')).toBeLessThan(rendered.indexOf('文件之后'));
  });

  test('resolves a relative assistant MEDIA image against the working directory', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock(
        {
          kind: 'group',
          key: 'assistant-local-image-group',
          role: 'assistant',
          messages: [
            {
              key: 'assistant-local-image-msg',
              message: {
                role: 'assistant',
                content: '图片已生成\nMEDIA:output files/visualization_demo.png',
                timestamp: 1,
              },
            },
          ],
          timestamp: 1,
          isStreaming: false,
        },
        { workingDirectory: 'E:\\workspace\\JustDo' },
      ),
    );

    expect(rendered).toContain(
      'localfile:///E%3A/workspace/JustDo/output%20files/visualization_demo.png',
    );
    expect(rendered).not.toContain('message-attachment');
  });

  test('resolves a relative assistant MEDIA image from a root working directory', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock(
        {
          kind: 'group',
          key: 'assistant-root-image-group',
          role: 'assistant',
          messages: [
            {
              key: 'assistant-root-image-msg',
              message: { role: 'assistant', content: 'MEDIA:visualization.png', timestamp: 1 },
            },
          ],
          timestamp: 1,
          isStreaming: false,
        },
        { workingDirectory: '/' },
      ),
    );

    expect(rendered).toContain('localfile:///visualization.png');
  });

  test('renders a persisted transcript file attachment from MediaPath fields', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
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
      renderMessageBlock({
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

  test('never recreates the retired nested tools timeline from grouped history', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
        kind: 'group',
        key: 'assistant-group-tools',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-msg-tools',
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
                {
                  type: 'toolresult',
                  id: 'tool-1',
                  name: 'exec',
                  text: '(no output)',
                },
              ],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      }),
    );

    expect(rendered).toContain('Here is the file. Now cleaning up.');
    expect(rendered).not.toContain('Need to clean up.');
    expect(rendered).not.toContain('tool-timeline');
    expect(rendered).not.toContain('N tools');
    expect(rendered).not.toContain('<details');
    expect(rendered).not.toContain('<summary');
  });

  test('does not render standalone Tool messages outside the canonical timeline', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
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

    expect(rendered).not.toContain('Completed with 0 errors');
    expect(rendered).not.toContain('tool-message');
    expect(rendered).not.toContain('<details');
  });
});
