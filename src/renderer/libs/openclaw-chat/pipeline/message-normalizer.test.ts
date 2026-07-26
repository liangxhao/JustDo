import { describe, expect, test } from 'vitest';

import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';

describe('normalizeMessage image content', () => {
  test('normalizes OpenClaw base64 image blocks in user messages', () => {
    const message = normalizeMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'YWJj',
          },
        },
      ],
    });

    expect(message.content).toEqual([
      { type: 'text', text: 'describe this', name: undefined, args: undefined },
      {
        type: 'attachment',
        attachment: {
          url: 'data:image/png;base64,YWJj',
          kind: 'image',
          label: 'Image',
          mimeType: 'image/png',
        },
      },
    ]);
  });

  test('normalizes gateway image attachment blocks', () => {
    const message = normalizeMessage({
      role: 'user',
      content: [
        {
          type: 'image',
          mimeType: 'image/jpeg',
          content: 'ZGVm',
        },
      ],
    });

    expect(message.content[0]).toMatchObject({
      type: 'attachment',
      attachment: {
        url: 'data:image/jpeg;base64,ZGVm',
        kind: 'image',
      },
    });
  });

  test('normalizes OpenClaw managed image URL blocks', () => {
    const message = normalizeMessage({
      role: 'user',
      content: [
        {
          type: 'image',
          url: '/api/chat/media/outgoing/session/image/full',
          alt: 'Uploaded image',
          mimeType: 'image/png',
        },
      ],
    });

    expect(message.content[0]).toEqual({
      type: 'attachment',
      attachment: {
        url: '/api/chat/media/outgoing/session/image/full',
        kind: 'image',
        label: 'Uploaded image',
        mimeType: 'image/png',
      },
    });
  });
});

describe('normalizeMessage assistant media', () => {
  test('renders a MEDIA path even when it is relative or does not exist', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: '文件已生成：\nMEDIA:missing/output/report.pdf',
    });

    expect(message.content).toEqual([
      { type: 'text', text: '文件已生成：' },
      {
        type: 'attachment',
        attachment: {
          url: 'missing/output/report.pdf',
          kind: 'document',
          label: 'report.pdf',
          mimeType: 'application/pdf',
        },
      },
    ]);
  });

  test('labels an HTTPS MEDIA URL with its file name', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: '文件已生成：\nMEDIA:https://container/report.pdf',
    });

    expect(message.content).toEqual([
      { type: 'text', text: '文件已生成：' },
      {
        type: 'attachment',
        attachment: {
          url: 'https://container/report.pdf',
          kind: 'document',
          label: 'report.pdf',
          mimeType: 'application/pdf',
        },
      },
    ]);
  });

  test('labels an HTTP MEDIA URL with its host name', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'MEDIA:http://container',
    });

    expect(message.content).toEqual([
      {
        type: 'attachment',
        attachment: {
          url: 'http://container',
          kind: 'document',
          label: 'container',
          mimeType: undefined,
        },
      },
    ]);
  });
});

describe('normalizeMessage user media', () => {
  test('normalizes a MEDIA path in user text content', () => {
    const message = normalizeMessage({
      role: 'user',
      content: '帮我看这个文件\nMEDIA:C:\\workspace\\reports\\brief.pdf',
    });

    expect(message.content).toEqual([
      { type: 'text', text: '帮我看这个文件' },
      {
        type: 'attachment',
        attachment: {
          url: 'C:\\workspace\\reports\\brief.pdf',
          kind: 'document',
          label: 'brief.pdf',
          mimeType: 'application/pdf',
        },
      },
    ]);
  });

  test('normalizes a MEDIA path in user text blocks', () => {
    const message = normalizeMessage({
      role: 'user',
      content: [{ type: 'text', text: '参考图片\nMEDIA:/tmp/screen.png' }],
    });

    expect(message.content).toEqual([
      { type: 'text', text: '参考图片', name: undefined, args: undefined },
      {
        type: 'attachment',
        attachment: {
          url: '/tmp/screen.png',
          kind: 'image',
          label: 'screen.png',
          mimeType: 'image/png',
        },
      },
    ]);
  });
});

describe('normalizeMessage assistant model label', () => {
  test('uses OpenClaw provider and model fields for assistant messages', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'hello',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });

    expect(message.modelName).toBe('deepseek/deepseek-v4-flash');
  });

  test('prefers explicit modelName over provider and model fields', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'hello',
      modelName: 'gpt-4.1',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });

    expect(message.modelName).toBe('gpt-4.1');
  });
});

describe('normalizeMessage goal token usage', () => {
  test('hides an unreliable zero token count from an OpenClaw goal reply', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Goal complete: Write a poem\nTokens used: 0',
      api: 'openai-responses',
      provider: 'openclaw',
      model: 'gateway-injected',
    });

    expect(message.content).toEqual([{ type: 'text', text: 'Goal complete: Write a poem' }]);
  });

  test('hides zero usage when a projected goal reply has no model metadata', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Goal complete: Write a poem\nTokens used: 0' }],
    });

    expect(message.content).toEqual([{ type: 'text', text: 'Goal complete: Write a poem' }]);
  });

  test('hides zero usage when the goal footer is split across text blocks', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Goal complete: Write a poem' },
        { type: 'text', text: 'Tokens used: 0' },
      ],
    });

    expect(message.content).toEqual([{ type: 'text', text: 'Goal complete: Write a poem' }]);
  });

  test('keeps a non-zero goal token count', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Goal complete: Write a poem\nTokens used: 1200',
      provider: 'openclaw',
      model: 'gateway-injected',
    });

    expect(message.content).toEqual([
      { type: 'text', text: 'Goal complete: Write a poem\nTokens used: 1200' },
    ]);
  });
});
