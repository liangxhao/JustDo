import { describe, expect, test } from 'vitest';

import { normalizeMessage } from './message-normalizer';

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
