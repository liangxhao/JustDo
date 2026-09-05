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
          artifactId: 'artifact_managed_image_image',
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
        artifactId: 'artifact_managed_image_image',
      },
    });
  });
});

describe('normalizeMessage assistant media', () => {
  test('preserves the artifact identity of a managed document attachment', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: [
        {
          type: 'attachment',
          attachment: {
            artifactId: 'artifact_managed_media_document',
            url: '/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession/file/full',
            kind: 'document',
            label: 'result.py',
            mimeType: 'application/octet-stream',
          },
        },
      ],
    });

    expect(message.content).toEqual([
      {
        type: 'attachment',
        attachment: {
          artifactId: 'artifact_managed_media_document',
          url: '/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession/file/full',
          kind: 'document',
          label: 'result.py',
          mimeType: 'application/octet-stream',
        },
      },
    ]);
  });

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

  test('normalizes an attachment delivery failure as non-actionable', () => {
    const message = normalizeMessage({
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
            url: '/api/chat/media/outgoing/session/file/full',
            error: 'Managed media attachment has an unsupported content type',
          },
        },
      ],
    });

    expect(message.content).toEqual([
      { type: 'text', text: '5 个文件均已生成并验证通过。' },
      {
        type: 'attachment_error',
        attachment: {
          code: 'delivery-failed',
          kind: 'document',
          label: 'quicksort_v1.py',
          mimeType: 'application/octet-stream',
        },
      },
    ]);
  });

  test('renders original absolute and relative MEDIA paths from delivery metadata', () => {
    const message = normalizeMessage({
      role: 'assistant',
      openclawDelivery: {
        mediaUrls: [
          'C:\\workspace\\result.py',
          'missing\\report.txt',
          'https://example.test/remote.pdf',
        ],
      },
      content: [
        {
          type: 'attachment',
          attachment: {
            artifactId: 'artifact_managed_media_local',
            url: '/api/chat/media/outgoing/session/local/full',
            kind: 'document',
            label: 'result.py',
          },
        },
        {
          type: 'attachment_error',
          attachment: {
            code: 'delivery-failed',
            kind: 'document',
            label: 'report.txt',
          },
        },
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
    });

    expect(message.content).toEqual([
      {
        type: 'attachment',
        attachment: {
          url: 'C:\\workspace\\result.py',
          kind: 'document',
          label: 'result.py',
          mimeType: undefined,
        },
      },
      {
        type: 'attachment',
        attachment: {
          url: 'missing\\report.txt',
          kind: 'document',
          label: 'report.txt',
          mimeType: 'text/plain',
        },
      },
      {
        type: 'attachment',
        attachment: {
          url: 'https://example.test/remote.pdf',
          kind: 'document',
          label: 'remote.pdf',
          mimeType: 'application/pdf',
        },
      },
    ]);
  });

  test('renders metadata MEDIA paths without checking whether the file exists', () => {
    const message = normalizeMessage({
      role: 'assistant',
      openclawDelivery: { mediaUrls: ['missing\\never-created.txt'] },
      content: [{ type: 'text', text: '文件如下。' }],
    });

    expect(message.content).toEqual([
      { type: 'text', text: '文件如下。' },
      {
        type: 'attachment',
        attachment: {
          url: 'missing\\never-created.txt',
          kind: 'document',
          label: 'never-created.txt',
          mimeType: 'text/plain',
        },
      },
    ]);
  });

  test('discards malformed attachment delivery failures', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: [
        { type: 'attachment_error', attachment: { code: 'delivery-failed' } },
        { type: 'text', text: '最终总结仍然保留。' },
      ],
    });

    expect(message.content).toEqual([{ type: 'text', text: '最终总结仍然保留。' }]);
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

  test('qualifies a bare explicit modelName with the provider', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'hello',
      modelName: 'gpt-4.1',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });

    expect(message.modelName).toBe('deepseek/gpt-4.1');
  });
});

describe('normalizeMessage gateway-injected log hint', () => {
  test.each(['openclaw/gateway-injected', 'gateway-injected'])(
    'removes the OpenClaw log hint from %s messages',
    modelName => {
      const message = normalizeMessage({
        role: 'assistant',
        content: 'Task failed\nLog: openclaw logs --follow',
        modelName,
      });

      expect(message.content).toEqual([{ type: 'text', text: 'Task failed' }]);
    },
  );

  test('removes a standalone OpenClaw log hint from gateway-injected messages', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Log: openclaw logs --follow',
      provider: 'openclaw',
      model: 'gateway-injected',
    });

    expect(message.content).toEqual([]);
  });

  test('removes the plural OpenClaw logs hint identified by the live sender label', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Task failed\nLogs: openclaw logs --follow',
      senderLabel: 'openclaw/gateway-injected',
    });

    expect(message.content).toEqual([{ type: 'text', text: 'Task failed' }]);
  });

  test('recognizes case-insensitive multi-segment gateway-injected model refs', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Logs: openclaw logs --follow',
      modelName: 'OpenClaw/Internal/Gateway-Injected',
    });

    expect(message.content).toEqual([]);
  });

  test('only removes a standalone log hint line and tolerates Markdown or extra spacing', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Blog: openclaw logs --follow\nLogs: `openclaw  logs   --follow`\nStill visible',
      modelName: 'gateway-injected',
    });

    expect(message.content).toEqual([
      { type: 'text', text: 'Blog: openclaw logs --follow\nStill visible' },
    ]);
  });

  test('removes every OpenClaw log hint from gateway-injected messages', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content:
        'Task failed\nLog: openclaw logs --follow\nRetry failed\nLog: openclaw logs --follow',
      modelName: 'gateway-injected',
    });

    expect(message.content).toEqual([{ type: 'text', text: 'Task failed\nRetry failed' }]);
  });

  test('removes the internal log hint from regular assistant messages too', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Log: openclaw logs --follow',
      model: 'gpt-4.1',
    });

    expect(message.content).toEqual([]);
  });

  test('keeps an ordinary Logs heading in a completed message', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: 'Logs:\nApplication started',
      model: 'gpt-4.1',
    });

    expect(message.content).toEqual([{ type: 'text', text: 'Logs:\nApplication started' }]);
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
