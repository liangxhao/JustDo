import { composeBrowserGatewayPrompt } from '@shared/browser/browser';
import { BrowserLinkTarget } from '@shared/browser/browserLinkOpening';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('./markdown', () => ({
  toSanitizedMarkdownHtml: (text: string) => text,
  toStreamingMarkdownHtml: (text: string) => text,
}));

import { defaultConfig } from '@/app/config';
import {
  formatGroupTimestamp,
  getGroupFooterLabel,
  renderMessageBlock,
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
} from '@/libs/openclaw-chat/components/message-render';
import type { MessageGroup } from '@/libs/openclaw-chat/types';
import { configService } from '@/services/config';
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

function collectTemplateFunctions(value: unknown): Array<(event: Event) => unknown> {
  if (typeof value === 'function') return [value as (event: Event) => unknown];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectTemplateFunctions);
  return Object.values(value as Record<string, unknown>).flatMap(collectTemplateFunctions);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe('browser annotation messages', () => {
  test('renders a compact expandable element reference in a user bubble', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock({
        ...createGroup('user'),
        messages: [
          {
            key: 'browser-annotation-message',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'Please update this button.' },
                {
                  type: 'browser_annotation',
                  annotation: {
                    id: 'annotation-1',
                    title: 'Settings',
                    displayUrl: 'example.com',
                    markedRegionCount: 1,
                    comment: 'Make the primary action clearer.',
                    element: {
                      tag: 'button',
                      id: 'save',
                      classes: ['primary'],
                      role: 'button',
                      name: 'Save changes',
                      cssPath: 'main > button#save',
                      rect: { x: 10, y: 20, width: 100, height: 40 },
                    },
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    expect(rendered).toContain('browser-annotation-message');
    expect(rendered).toContain('Save changes');
    expect(rendered).toContain('button');
    expect(rendered).not.toContain('&lt;button#save&gt;');
    expect(rendered).toContain('main > button#save');
    expect(rendered).toContain('Make the primary action clearer.');
    expect(rendered).toContain('example.com');
    expect(rendered).toContain('selector');
    expect(rendered).toContain('bounds');
    expect(rendered).not.toContain('已标注网页元素');
  });

  test.each([
    ['first-session raw string', false],
    ['continued-session raw text block', true],
  ])('never renders browser gateway context for %s', (_name, contentArray) => {
    const gatewayPrompt = composeBrowserGatewayPrompt('Please update this button.', [
      {
        id: 'annotation-1',
        modelContext: 'RAW_HTML_SHOULD_NEVER_FLASH <button id="save">Save</button>',
        title: 'Settings',
        displayUrl: 'example.com',
        markedRegionCount: 0,
        inspectedElement: true,
        display: {
          id: 'annotation-1',
          title: 'Settings',
          displayUrl: 'example.com',
          markedRegionCount: 0,
          element: {
            tag: 'button',
            id: 'save',
            classes: [],
            role: 'button',
            name: 'Save',
            cssPath: 'button#save',
            rect: { x: 10, y: 20, width: 100, height: 40 },
          },
        },
        dataUrl: 'data:image/png;base64,YWJj',
        fileName: 'browser-annotation.png',
        addedAt: 1,
      },
    ]);
    const rendered = stringifyTemplate(
      renderMessageBlock({
        ...createGroup('user'),
        messages: [
          {
            key: 'raw-browser-message',
            message: {
              role: 'user',
              content: contentArray ? [{ type: 'text', text: gatewayPrompt }] : gatewayPrompt,
            },
          },
        ],
      }),
    );

    expect(rendered).toContain('browser-annotation-message');
    expect(rendered).toContain('Save');
    expect(rendered).toContain('Please update this button.');
    expect(rendered).not.toContain('RAW_HTML_SHOULD_NEVER_FLASH');
    expect(rendered).not.toContain('EXTERNAL_UNTRUSTED_CONTENT');
  });
});

test.each([false, true])(
  'renders a trimmed recording-only message as a card (blocks=%s)',
  contentArray => {
    const prompt = composeBrowserGatewayPrompt('', [], {
      id: 'recording',
      sessionId: 'session',
      profile: 'embedded',
      title: '',
      note: '',
      startedAt: 1,
      images: [],
      steps: [
        {
          id: 'step',
          action: 'click',
          pageId: 'tab',
          at: 0,
          url: 'https://example.com/',
          title: 'Example',
        },
      ],
    }).trim();
    const rendered = stringifyTemplate(
      renderMessageBlock({
        ...createGroup('user'),
        messages: [
          {
            key: 'recording',
            message: {
              role: 'user',
              content: contentArray ? [{ type: 'text', text: prompt }] : prompt,
            },
          },
        ],
      }),
    );
    expect(rendered).toContain('recording-message');
    expect(rendered).not.toContain('EXTERNAL_UNTRUSTED_CONTENT');
    expect(rendered).not.toContain('recording-data-length:');
  },
);

describe('group footer helpers', () => {
  test('shows peer source labels instead of attributing them to the user', () => {
    expect(getGroupFooterLabel({ ...createGroup('user'), senderLabel: 'Review peer' })).toBe(
      'Review peer',
    );
    expect(getGroupFooterLabel(createGroup('user'))).toBe(i18nService.t('coworkYouLabel'));
  });
  test('uses the configured peer name for the footer and a distinct initial avatar', () => {
    const group = {
      ...createGroup('user'),
      senderId: 'review-agent',
      senderLabel: '协作消息 · review-agent',
    };
    expect(getGroupFooterLabel(group, undefined, { 'review-agent': '审查助手' })).toBe('审查助手');
    const rendered = stringifyTemplate(
      renderMessageBlock(group, { peerNames: { 'review-agent': '审查助手' } }),
    );
    expect(rendered).toContain('chat-avatar peer');
    expect(rendered).toContain('审查助手');
    expect(rendered).toContain('审');
  });
  test('uses assistant model name when present', () => {
    expect(
      getGroupFooterLabel({
        ...createGroup('assistant'),
        modelName: 'gpt-4.1',
      }),
    ).toBe('gpt-4.1');
  });
  test('uses the selected assistant identity on the local side of a peer perspective', () => {
    const group = createGroup('assistant');
    expect(getGroupFooterLabel(group, '实现助手', undefined, true)).toBe('实现助手');
    const rendered = stringifyTemplate(
      renderMessageBlock(group, {
        assistantName: '实现助手',
        peerPerspective: true,
        showAvatar: true,
      }),
    );
    expect(rendered).toContain('chat-avatar peer');
    expect(rendered).toContain('实现助手');
    expect(rendered).toContain('实');
    expect(rendered).not.toContain('chat-group--continuation');
    const continuation = stringifyTemplate(
      renderMessageBlock(group, {
        assistantName: '实现助手',
        peerPerspective: true,
        showAvatar: false,
      }),
    );
    expect(continuation).not.toContain('chat-avatar peer');
    expect(continuation).toContain('chat-group--continuation');
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

describe('last user message actions', () => {
  test('renders edit and withdraw controls only when the caller marks the message actionable', () => {
    const onAction = vi.fn();
    const actionable = stringifyTemplate(
      renderMessageBlock(createGroup('user'), {
        userMessageActions: {
          entryId: 'user-entry',
          canEdit: true,
          canWithdraw: true,
          onAction,
        },
      }),
    );
    const ordinary = stringifyTemplate(renderMessageBlock(createGroup('user')));

    expect(actionable).toContain('user-message-actions');
    expect(actionable).toContain(i18nService.t('coworkEditLastMessage'));
    expect(actionable).toContain(i18nService.t('coworkWithdrawLastMessage'));
    expect(ordinary).not.toContain('user-message-actions');
  });

  test('renders a fork control after completed assistant footer metadata', () => {
    const onFork = vi.fn();
    const rendered = stringifyTemplate(
      renderMessageBlock(
        { ...createGroup('assistant'), durationMs: 3_500 },
        {
          assistantMessageFork: {
            entryId: 'assistant-entry',
            onFork,
          },
        },
      ),
    );

    expect(rendered).toContain('assistant-message-action--fork');
    expect(rendered).toContain(i18nService.t('coworkForkFromMessage'));
    expect(
      rendered.indexOf(i18nService.t('coworkRunWorkedDuration').replace('{duration}', '3s')),
    ).toBeLessThan(rendered.indexOf('assistant-message-action--fork'));
  });
});

describe('renderMessageBlock', () => {
  test('renders read-aloud control only when an assistant speech handler is provided', () => {
    const handler = vi.fn();
    const withSpeech = stringifyTemplate(
      renderMessageBlock(createGroup('assistant'), { onSpeak: handler, speechState: 'idle' }),
    );
    const withoutSpeech = stringifyTemplate(renderMessageBlock(createGroup('assistant')));

    expect(withSpeech).toContain('message-speech');
    expect(withSpeech).toContain(i18nService.t('localTtsPlay'));
    expect(withoutSpeech).not.toContain('message-speech');
  });

  test('keeps the speaker control when assistant footer metadata is suppressed', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock(createGroup('assistant'), {
        showFooter: false,
        onSpeak: vi.fn(),
        speechState: 'idle',
      }),
    );

    expect(rendered).toContain('message-speech');
    expect(rendered).toContain('message-speech__icon');
    expect(rendered).not.toContain('▶');
  });

  test('keeps the loading speech control clickable so synthesis can be cancelled', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock(createGroup('assistant'), {
        onSpeak: vi.fn(),
        speechState: 'loading',
      }),
    );

    expect(rendered).toContain(i18nService.t('localTtsStop'));
    expect(rendered).not.toContain('disabled');
  });

  test('shows an audio waveform while the response is playing', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock(createGroup('assistant'), {
        onSpeak: vi.fn(),
        speechState: 'playing',
      }),
    );

    expect(rendered).toContain('message-speech__wave');
    expect(rendered).toContain(i18nService.t('localTtsStop'));
  });

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

  test.each(['user', 'assistant'])(
    'groups consecutive %s images in rows of three and splits at text',
    role => {
      const image = (name: string) => `MEDIA:https://example.com/${name}.png`;
      const rendered = stringifyTemplate(
        renderMessageBlock({
          kind: 'group',
          key: 'image-rows',
          role,
          messages: [
            {
              key: 'images',
              message: {
                role,
                timestamp: 1,
                content: [
                  image('a'),
                  image('b'),
                  image('c'),
                  image('d'),
                  'separator',
                  image('e'),
                  image('f'),
                ].join('\n'),
              },
            },
          ],
          timestamp: 1,
          isStreaming: false,
        }),
      );
      expect(rendered.match(/--image-columns: 3/g)).toHaveLength(1);
      expect(rendered.match(/--image-columns: 1/g)).toHaveLength(1);
      expect(rendered.match(/--image-columns: 2/g)).toHaveLength(1);
      expect(rendered.match(/class="chat-bubble__image"/g)).toHaveLength(6);
      expect(rendered.indexOf('/d.png')).toBeLessThan(
        rendered.indexOf('separator', rendered.indexOf('/d.png')),
      );
      expect(rendered.indexOf('separator', rendered.indexOf('/d.png'))).toBeLessThan(
        rendered.indexOf('/e.png'),
      );
    },
  );

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

  test('renders an attachment failure as a non-actionable status card', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock(
        {
          kind: 'group',
          key: 'assistant-attachment-error-group',
          role: 'assistant',
          messages: [
            {
              key: 'assistant-attachment-error-msg',
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: '5 个文件均已生成并验证通过。' },
                  {
                    type: 'attachment_error',
                    attachment: {
                      code: 'delivery-failed',
                      kind: 'document',
                      label: 'quicksort_v1.py',
                      mimeType: 'application/octet-stream',
                      url: 'quicksort_demo\\quicksort_v1.py',
                      error: 'Managed media attachment has an unsupported content type',
                    },
                  },
                ],
                timestamp: 1,
              },
            },
          ],
          timestamp: 1,
          isStreaming: false,
        },
        { workingDirectory: 'C:\\workspace\\project' },
      ),
    );

    expect(rendered).toContain('5 个文件均已生成并验证通过。');
    expect(rendered).toContain('quicksort_v1.py');
    expect(rendered).not.toContain('C:\\workspace\\project\\quicksort_demo\\quicksort_v1.py');
    expect(rendered).not.toContain('Managed media attachment has an unsupported content type');
    expect(rendered).toContain('message-attachment__warning');
    expect(rendered).toContain('附件不可用：quicksort_v1.py');
    expect(rendered).not.toContain('@contextmenu=');
    expect(rendered).not.toContain('message-attachment__open');
    expect(rendered).toContain('message-attachment--unavailable');
    expect(rendered).not.toContain('message-attachment__detail');
    expect(rendered).not.toContain('delete');
  });

  test.each(['result.py', 'picture.png'])(
    'opens the MEDIA file %s in the sidebar',
    async fileName => {
      const openExternal = vi.fn();
      const openPath = vi.fn().mockResolvedValue({ success: true });
      const dispatchEvent = vi.fn();
      vi.stubGlobal('window', {
        electron: { shell: { openExternal, openPath } },
        dispatchEvent,
        setTimeout,
      });
      const rendered = renderMessageBlock({
        kind: 'group',
        key: 'assistant-media-document-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-media-document-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'attachment',
                  attachment: {
                    url: `C:\\workspace\\project\\${fileName}`,
                    kind: 'document',
                    label: fileName,
                    mimeType: 'application/octet-stream',
                  },
                },
              ],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      });

      const handlers = collectTemplateFunctions(rendered);
      expect(handlers.length).toBeGreaterThanOrEqual(2);
      handlers[0]({ stopPropagation: vi.fn() } as unknown as Event);

      await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledOnce());
      const previewEvent = dispatchEvent.mock.calls[0][0] as CustomEvent;
      expect(previewEvent.type).toBe('cowork:preview-file');
      expect(previewEvent.detail).toEqual({
        filePath: `C:\\workspace\\project\\${fileName}`,
        workingDirectory: undefined,
      });
      expect(openPath).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  test('opens a MEDIA HTML document in the sidebar browser instead of the file preview', async () => {
    const openExternal = vi.fn();
    const openPath = vi.fn().mockResolvedValue({ success: true });
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', {
      electron: { shell: { openExternal, openPath } },
      dispatchEvent,
      setTimeout,
    });
    const rendered = renderMessageBlock(
      {
        kind: 'group',
        key: 'assistant-media-html-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-media-html-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'attachment',
                  attachment: {
                    url: 'output/report#1.HTML',
                    kind: 'document',
                    label: 'report.HTML',
                    mimeType: 'text/html',
                  },
                },
              ],
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      },
      { workingDirectory: 'C:\\workspace\\project' },
    );

    const handlers = collectTemplateFunctions(rendered);
    handlers[0]({ stopPropagation: vi.fn() } as unknown as Event);

    await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledOnce());
    const browserEvent = dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(browserEvent.type).toBe('cowork:open-local-html');
    expect(browserEvent.detail).toEqual({
      filePath: 'C:\\workspace\\project\\output/report#1.HTML',
      workingDirectory: 'C:\\workspace\\project',
    });
    expect(openPath).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test.each([BrowserLinkTarget.Embedded, BrowserLinkTarget.Chrome])(
    'opens a MEDIA web URL in %s according to the message link preference',
    async target => {
      vi.spyOn(configService, 'getConfig').mockReturnValue({
        ...defaultConfig,
        browserWebLinkTarget: target,
      });
      const openInChrome = vi.fn().mockResolvedValue({ success: true });
      const openExternal = vi.fn();
      const openPath = vi.fn();
      const dispatchEvent = vi.fn();
      vi.stubGlobal('window', {
        electron: { shell: { openExternal, openPath }, browser: { openInChrome } },
        dispatchEvent,
        setTimeout,
      });
      const rendered = renderMessageBlock({
        kind: 'group',
        key: 'assistant-media-web-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-media-web-message',
            message: {
              role: 'assistant',
              content: 'MEDIA:https://example.com/report.html?view=compact#chart',
              timestamp: 1,
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      });

      const handlers = collectTemplateFunctions(rendered);
      handlers[0]({ stopPropagation: vi.fn() } as unknown as Event);

      if (target === BrowserLinkTarget.Chrome) {
        await vi.waitFor(() => expect(openInChrome).toHaveBeenCalledOnce());
        expect(openInChrome).toHaveBeenCalledWith(
          'https://example.com/report.html?view=compact#chart',
        );
        expect(dispatchEvent).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledOnce());
        expect((dispatchEvent.mock.calls[0][0] as CustomEvent).detail).toEqual({
          url: 'https://example.com/report.html?view=compact#chart',
        });
        expect((dispatchEvent.mock.calls[0][0] as CustomEvent).type).toBe('cowork:open-web-url');
        expect(openInChrome).not.toHaveBeenCalled();
      }
      expect(openExternal).not.toHaveBeenCalled();
      expect(openPath).not.toHaveBeenCalled();
    },
  );

  test.each([
    {
      source: 'output/report.html#chart',
      filePath: 'C:\\project\\output/report.html',
      navigationSuffix: '#chart',
    },
    {
      source: 'output/report.html?view=compact#chart',
      filePath: 'C:\\project\\output/report.html',
      navigationSuffix: '?view=compact#chart',
    },
    {
      source: 'file:///C:/project/report.html?view=compact#chart',
      filePath: 'C:/project/report.html',
      navigationSuffix: '?view=compact#chart',
    },
    { source: 'output/100%.html', filePath: 'C:\\project\\output/100%.html' },
    {
      source: 'output/report.html#backup.html',
      filePath: 'C:\\project\\output/report.html#backup.html',
    },
  ])(
    'preserves the lookup and navigation of a MEDIA HTML link: $source',
    async ({ source, filePath, navigationSuffix }) => {
      const openPath = vi.fn();
      const dispatchEvent = vi.fn();
      vi.stubGlobal('window', { electron: { shell: { openPath } }, dispatchEvent, setTimeout });
      const rendered = renderMessageBlock(
        {
          ...createGroup('assistant'),
          messages: [
            {
              key: 'html-media',
              message: { role: 'assistant', content: `MEDIA:${source}`, timestamp: 1 },
            },
          ],
        },
        { workingDirectory: 'C:\\project' },
      );
      collectTemplateFunctions(rendered)[0]({ stopPropagation: vi.fn() } as unknown as Event);
      await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledOnce());
      const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe('cowork:open-local-html');
      expect(event.detail).toEqual({
        filePath,
        workingDirectory: 'C:\\project',
        ...(navigationSuffix ? { navigationSuffix } : {}),
      });
      expect(openPath).not.toHaveBeenCalled();
    },
  );

  test('does not infer a local path for an unbound managed attachment', () => {
    const renderedTemplate = renderMessageBlock(
      {
        kind: 'group',
        key: 'assistant-unbound-managed-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-unbound-managed-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'attachment',
                  attachment: {
                    artifactId: 'artifact_managed_media_remote',
                    url: '/api/chat/media/outgoing/session/remote/full',
                    kind: 'document',
                    label: 'remote.pdf',
                  },
                },
              ],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      },
      { workingDirectory: 'C:\\workspace\\project' },
    );
    const rendered = stringifyTemplate(renderedTemplate);

    expect(rendered).toContain('message-attachment--unavailable');
    expect(rendered).not.toContain('C:\\workspace\\project\\remote.pdf');
    expect(collectTemplateFunctions(renderedTemplate)).toHaveLength(0);
  });

  test.each([
    ['open-with-system', 'openPath'],
    ['show-in-folder', 'showItemInFolder'],
  ] as const)('runs %s against the absolute MEDIA path', async (action, expectedMethod) => {
    const openPath = vi.fn().mockResolvedValue({ success: true });
    const showItemInFolder = vi.fn().mockResolvedValue({ success: true });
    const showAttachmentContextMenu = vi.fn().mockResolvedValue(action);
    vi.stubGlobal('window', {
      electron: {
        shell: {
          openExternal: vi.fn(),
          openPath,
          showItemInFolder,
          showAttachmentContextMenu,
        },
      },
      dispatchEvent: vi.fn(),
      setTimeout,
    });
    const rendered = renderMessageBlock({
      kind: 'group',
      key: `assistant-media-${action}-group`,
      role: 'assistant',
      messages: [
        {
          key: `assistant-media-${action}-message`,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'attachment',
                attachment: {
                  url: 'C:\\workspace\\project\\result.bin',
                  kind: 'document',
                  label: 'result.bin',
                },
              },
            ],
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    });

    const handlers = collectTemplateFunctions(rendered);
    handlers[1]({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event);

    const expected = expectedMethod === 'openPath' ? openPath : showItemInFolder;
    const unexpected = expectedMethod === 'openPath' ? showItemInFolder : openPath;
    await vi.waitFor(() => expect(expected).toHaveBeenCalledOnce());
    expect(expected).toHaveBeenCalledWith('C:\\workspace\\project\\result.bin', undefined);
    expect(unexpected).not.toHaveBeenCalled();
  });

  test.each([
    ['open-with-system', 'openPath'],
    ['show-in-folder', 'showItemInFolder'],
  ] as const)(
    'shows a file-not-found toast when %s targets a deleted source file',
    async (action, expectedMethod) => {
      const dispatchEvent = vi.fn();
      const openPath = vi.fn().mockResolvedValue({ success: false, notFound: true });
      const showItemInFolder = vi.fn().mockResolvedValue({ success: false, notFound: true });
      vi.stubGlobal('window', {
        electron: {
          shell: {
            openExternal: vi.fn(),
            openPath,
            showItemInFolder,
            showAttachmentContextMenu: vi.fn().mockResolvedValue(action),
          },
        },
        dispatchEvent,
        setTimeout,
      });
      const rendered = renderMessageBlock({
        kind: 'group',
        key: 'assistant-deleted-source-group',
        role: 'assistant',
        messages: [
          {
            key: 'assistant-deleted-source-message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'attachment',
                  attachment: {
                    kind: 'document',
                    label: 'deleted.bin',
                    url: 'C:\\workspace\\project\\deleted.bin',
                  },
                },
              ],
            },
          },
        ],
        timestamp: 1,
        isStreaming: false,
      });

      const handlers = collectTemplateFunctions(rendered);
      handlers[1]({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event);

      const expected = expectedMethod === 'openPath' ? openPath : showItemInFolder;
      await vi.waitFor(() => expect(expected).toHaveBeenCalledOnce());
      const toastEvent = dispatchEvent.mock.calls[0][0] as CustomEvent;
      expect(toastEvent.type).toBe('app:showToast');
      expect(toastEvent.detail).toBe('文件不存在：C:\\workspace\\project\\deleted.bin');
    },
  );

  test('resolves a relative assistant attachment against the current workspace', () => {
    const rendered = stringifyTemplate(
      renderMessageBlock(
        {
          kind: 'group',
          key: 'assistant-relative-attachment-group',
          role: 'assistant',
          messages: [
            {
              key: 'assistant-relative-attachment-msg',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'attachment',
                    attachment: {
                      url: 'quicksort_demo\\quicksort_v1.py',
                      kind: 'document',
                      label: 'quicksort_v1.py',
                    },
                  },
                ],
                timestamp: 1,
              },
            },
          ],
          timestamp: 1,
          isStreaming: false,
        },
        { workingDirectory: 'C:\\workspace\\project' },
      ),
    );

    expect(rendered).toContain('C:\\workspace\\project\\quicksort_demo\\quicksort_v1.py');
    expect(rendered).toContain('@click=');
    expect(rendered).toContain('@contextmenu=');
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

    expect(rendered.match(/class=message-attachment(?:\s|>)/g)).toHaveLength(5);
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
