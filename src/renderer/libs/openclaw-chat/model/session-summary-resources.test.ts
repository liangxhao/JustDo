import type { ArtifactSummary } from '@shared/openclaw/artifacts';
import { describe, expect, it, vi } from 'vitest';

import { hydrateTruncatedHistoryMessages } from '../gateway/chat-history-protocol';
import type { GatewayClient } from '../gateway/client';
import {
  projectGatewayHistoryForDisplay,
  readCollapsedDeliveryArtifacts,
} from '../pipeline/history-display-normalizer';
import {
  projectSessionSummaryResources,
  resolveSummaryArtifactResource,
  resolveSummaryAttachment,
  summaryWebUrl,
} from './session-summary-resources';

const artifact: ArtifactSummary = {
  id: 'delivered',
  title: 'report.pdf',
  type: 'file',
  download: { mode: 'bytes' },
};

it('keeps the hydrated inbound image as a source when its native media reference is opaque', () => {
  const message = {
    role: 'user',
    __openclaw: {
      id: 'user-1',
      seq: 1,
      media: [
        { path: 'media://inbound/first---managed-id.png', contentType: 'image/png', kind: 'image' },
      ],
    },
    content: [
      {
        type: 'attachment',
        attachment: {
          kind: 'image',
          label: 'first.png',
          url: 'data:image/png;base64,YWJj',
          mimeType: 'image/png',
        },
      },
    ],
  };
  const { sources } = projectSessionSummaryResources([message], []);
  expect(sources).toHaveLength(1);
  expect(sources[0].target).toMatchObject({ kind: 'attachment', index: 0 });
  expect(
    resolveSummaryAttachment(
      [message],
      sources[0].target as Extract<(typeof sources)[0]['target'], { kind: 'attachment' }>,
    )?.url,
  ).toBe('data:image/png;base64,YWJj');
  expect(JSON.stringify(sources)).not.toContain('YWJj');
});

it('associates native media artifact titles with their original block rather than its display label', () => {
  const message = {
    role: 'assistant',
    __openclaw: { seq: 12 },
    content: [
      {
        type: 'image',
        url: 'https://example.com/result.png',
        fileName: 'result.png',
        mimeType: 'image/png',
      },
    ],
  };
  const { outputs } = projectSessionSummaryResources(
    [message],
    [
      {
        ...artifact,
        id: 'native-image',
        type: 'image',
        title: 'result.png',
        mimeType: 'image/png',
        messageSeq: 12,
      },
    ],
  );
  expect(outputs).toHaveLength(1);
  expect(outputs[0].title).toBe('result.png');
  expect(outputs[0].target).toEqual({ kind: 'media', url: 'https://example.com/result.png' });
});

it.each([false, true])(
  'preserves the confirmed original delivery association after collapsing its managed companion (truncated=%s)',
  async truncated => {
    const id = 'artifact_managed_media_22222222-2222-4222-8222-222222222222';
    const producer = {
      role: 'assistant',
      __openclaw: {
        id: 'producer',
        seq: 11,
        ...(truncated ? { truncated: true, reason: 'max_chars' } : {}),
      },
      content: 'Generated the file.\nMEDIA:E:/project/report.pdf',
      openclawDelivery: { mediaUrls: ['E:/project/report.pdf'] },
    };
    const companion = {
      role: 'assistant',
      model: 'gateway-injected',
      __openclaw: { seq: 12 },
      content: 'Generated the file.',
      openclawDisplayContent: [
        { type: 'text', text: 'Generated the file.' },
        {
          type: 'attachment',
          attachment: {
            url: '/api/chat/media/outgoing/session/report/full',
            artifactId: id,
            kind: 'document',
            label: 'report.pdf',
            mimeType: 'application/pdf',
          },
        },
      ],
    };
    const original = structuredClone([producer, companion]);
    const projected = projectGatewayHistoryForDisplay([producer, companion]);
    const full = {
      role: 'assistant',
      content: producer.content,
      openclawDelivery: producer.openclawDelivery,
    };
    const request = vi.fn().mockResolvedValue({ ok: true, message: full });
    const messages = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      projected,
      'session-1',
    );
    expect(messages).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(truncated ? 1 : 0);
    expect(readCollapsedDeliveryArtifacts(messages[0])).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain(id);
    const target = {
      kind: 'artifact' as const,
      artifactId: id,
      assistantOnly: true,
      messageSeq: 12,
    };
    expect(resolveSummaryArtifactResource(messages, target, 'report.pdf')?.target).toEqual({
      kind: 'file',
      path: 'E:/project/report.pdf',
    });
    const { outputs } = projectSessionSummaryResources(messages, [
      { ...artifact, id, messageSeq: 12 },
    ]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].target).toEqual({ kind: 'file', path: 'E:/project/report.pdf' });
    expect([producer, companion]).toEqual(original);
  },
);

it('does not guess between different same-name native media in one message', () => {
  const message = {
    role: 'assistant',
    __openclaw: { seq: 12 },
    content: [
      {
        type: 'image',
        url: 'https://example.com/first.png',
        fileName: 'result.png',
        mimeType: 'image/png',
      },
      {
        type: 'image',
        url: 'https://example.com/second.png',
        fileName: 'result.png',
        mimeType: 'image/png',
      },
    ],
  };
  expect(
    resolveSummaryArtifactResource(
      [message],
      { kind: 'artifact', artifactId: 'native-image', assistantOnly: true, messageSeq: 12 },
      'result.png',
    ),
  ).toBeNull();
});

it('does not hide an unrelated inline image just because the user also attached a local document', () => {
  const message = {
    role: 'user',
    __openclaw: {
      media: [
        { path: 'E:/project/report.pdf', fileName: 'report.pdf', contentType: 'application/pdf' },
      ],
    },
    content: [
      {
        type: 'attachment',
        attachment: {
          kind: 'image',
          url: 'data:image/png;base64,YWJj',
          label: 'first.png',
          mimeType: 'image/png',
        },
      },
    ],
  };
  const { sources } = projectSessionSummaryResources([message], []);
  expect(sources).toHaveLength(2);
  expect(sources.map(item => item.target.kind).sort()).toEqual(['attachment', 'file']);
});

it('keeps a delivery fragment in its target while using a fragment-free resource key', () => {
  const url = 'https://example.com/#/reports/42';
  const { outputs } = projectSessionSummaryResources(
    [
      {
        role: 'assistant',
        content: [{ type: 'attachment', attachment: { kind: 'document', url, label: 'Report' } }],
      },
    ],
    [],
  );
  expect(outputs[0]).toMatchObject({
    id: 'url:https://example.com/',
    target: { kind: 'url', url },
  });
});

it('uses the native original delivery path and deduplicates its managed artifact without a download', () => {
  const message = {
    role: 'assistant',
    __openclaw: {
      id: 'reply',
      seq: 12,
      media: [
        { path: 'E:/output/report.pdf', fileName: 'report.pdf', contentType: 'application/pdf' },
      ],
    },
    content: [
      {
        type: 'attachment',
        attachment: {
          url: '/api/chat/media/outgoing/session/report/full',
          artifactId: 'delivered',
          label: 'report.pdf',
          kind: 'document',
          mimeType: 'application/pdf',
        },
      },
    ],
  };
  const target = {
    kind: 'artifact' as const,
    artifactId: 'delivered',
    assistantOnly: true,
    messageSeq: 12,
  };
  expect(resolveSummaryArtifactResource([message], target, 'report.pdf')?.target).toEqual({
    kind: 'file',
    path: 'E:/output/report.pdf',
  });
  const projection = projectSessionSummaryResources([message], [{ ...artifact, messageSeq: 12 }]);
  expect(projection.outputs).toHaveLength(1);
  expect(projection.outputs[0].target).toEqual({ kind: 'file', path: 'E:/output/report.pdf' });
});

it('does not guess a file by name in another message or reuse a user artifact as assistant output', () => {
  const target = {
    kind: 'artifact' as const,
    artifactId: 'delivered',
    assistantOnly: true,
    messageSeq: 12,
  };
  expect(
    resolveSummaryArtifactResource(
      [
        {
          role: 'assistant',
          __openclaw: { seq: 11, media: [{ path: 'E:/other/report.pdf' }] },
          content: 'report.pdf',
        },
        {
          role: 'user',
          __openclaw: { seq: 12 },
          content: [
            {
              type: 'attachment',
              attachment: {
                kind: 'document',
                artifactId: 'delivered',
                url: 'E:/input/report.pdf',
                label: 'report.pdf',
              },
            },
          ],
        },
      ],
      target,
      'report.pdf',
    ),
  ).toBeNull();
});

it('does not match another explicit artifact identity by message sequence and filename', () => {
  const message = {
    role: 'assistant',
    __openclaw: { seq: 12 },
    content: [
      {
        type: 'attachment',
        attachment: {
          kind: 'document',
          artifactId: 'other',
          url: 'E:/other/report.pdf',
          label: 'report.pdf',
        },
      },
    ],
  };
  expect(
    resolveSummaryArtifactResource(
      [message],
      { kind: 'artifact', artifactId: 'delivered', assistantOnly: true, messageSeq: 12 },
      'report.pdf',
    ),
  ).toBeNull();
});

it.each([
  { url: 'E:/output/report.pdf', target: { kind: 'file', path: 'E:/output/report.pdf' } },
  {
    url: 'https://example.com/report.pdf',
    target: { kind: 'url', url: 'https://example.com/report.pdf' },
  },
])(
  'prefers the explicit attachment delivery $url over a different same-name media file',
  ({ url, target }) => {
    const message = {
      role: 'assistant',
      __openclaw: { seq: 12, media: [{ path: 'E:/input/report.pdf', fileName: 'report.pdf' }] },
      content: [
        {
          type: 'attachment',
          attachment: { kind: 'document', artifactId: 'delivered', url, label: 'report.pdf' },
        },
      ],
    };
    expect(
      resolveSummaryArtifactResource(
        [message],
        { kind: 'artifact', artifactId: 'delivered', assistantOnly: true, messageSeq: 12 },
        'report.pdf',
      )?.target,
    ).toEqual(target);
    expect(
      projectSessionSummaryResources([message], [{ ...artifact, messageSeq: 12 }]).outputs,
    ).toHaveLength(2);
  },
);

it('keeps distinct same-name original and inline attachments separate', () => {
  const message = {
    role: 'assistant',
    __openclaw: { seq: 12, media: [{ path: 'E:/output/report.pdf', fileName: 'report.pdf' }] },
    content: [
      {
        type: 'attachment',
        attachment: {
          kind: 'document',
          artifactId: 'original',
          label: 'report.pdf',
          url: 'E:/output/report.pdf',
        },
      },
      {
        type: 'attachment',
        attachment: {
          kind: 'document',
          artifactId: 'inline',
          label: 'report.pdf',
          url: 'data:application/pdf;base64,YQ==',
          mimeType: 'application/pdf',
        },
      },
    ],
  };
  const resolved = resolveSummaryArtifactResource(
    [message],
    { kind: 'artifact', artifactId: 'inline', assistantOnly: true, messageSeq: 12 },
    'report.pdf',
  );
  expect(resolved?.target).toMatchObject({ kind: 'attachment', index: 1 });
  expect(JSON.stringify(resolved)).not.toContain('YQ==');
  const { outputs } = projectSessionSummaryResources(
    [message],
    [
      { ...artifact, id: 'original', messageSeq: 12 },
      { ...artifact, id: 'inline', messageSeq: 12 },
    ],
  );
  expect(outputs).toHaveLength(2);
  expect(outputs.map(item => item.target)).toEqual(
    expect.arrayContaining([
      { kind: 'file', path: 'E:/output/report.pdf' },
      expect.objectContaining({ kind: 'attachment', index: 1 }),
    ]),
  );
});

it('matches an attachment without a declared artifact identity only within its native message sequence', () => {
  expect(
    resolveSummaryArtifactResource(
      [
        {
          role: 'assistant',
          __openclaw: { seq: 12 },
          content: [
            {
              type: 'attachment',
              attachment: { kind: 'document', url: 'E:/output/report.pdf', label: 'report.pdf' },
            },
          ],
        },
      ],
      { kind: 'artifact', artifactId: 'delivered', assistantOnly: true, messageSeq: 12 },
      'report.pdf',
    )?.target,
  ).toEqual({ kind: 'file', path: 'E:/output/report.pdf' });
});
const frame = (text: string) =>
  `<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\nSource: Web Search\n---\n${text}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>`;
const web = (payload: unknown, name = 'web_search') => ({
  role: 'toolResult',
  toolName: name,
  content: [{ type: 'text', text: JSON.stringify(payload) }],
});
const evidence = { source: 'web_search', untrusted: true, wrapped: true };
const nestedWeb = (payload: unknown, name = 'web_fetch') => ({
  role: 'custom',
  customType: 'openclaw.nested-tool.v1',
  display: true,
  excludeFromContext: true,
  content: [
    {
      type: 'toolCall',
      id: `nested:${name}`,
      name,
      arguments: { url: 'https://example.com/unconfirmed-input' },
      parentToolCallId: 'outer-call',
    },
    {
      ...web(payload, name),
      type: 'toolResult',
      toolCallId: `nested:${name}`,
      parentToolCallId: 'outer-call',
      isError: false,
    },
  ],
});
const truncatedWebContent = (payload: unknown) => [
  { type: 'text', text: `${JSON.stringify(payload, null, 2).slice(0, 8000)}\n…(truncated)…` },
];

describe('session summary resources', () => {
  it('separates uploaded inputs and delivered files, without listing tool-written paths or citation links as outputs', () => {
    const projection = projectSessionSummaryResources(
      [
        {
          role: 'user',
          __openclaw: { media: [{ path: 'E:/project/input.pdf', fileName: 'input.pdf' }] },
          content: 'Use this file',
        },
        {
          role: 'assistant',
          content:
            '[Report](./report.md) and [reference](https://example.com/guide)\n```md\n[Example](./fake.md)\n```',
        },
        { role: 'toolResult', toolName: 'write', content: 'Wrote E:/project/private.txt' },
      ],
      [artifact],
    );
    expect(projection.sources.map(item => item.title)).toEqual(['input.pdf']);
    expect(projection.outputs.map(item => item.title)).toEqual(['Report', 'report.pdf']);
    expect(projection.outputs.find(item => item.id === 'artifact:delivered')?.target).toEqual({
      kind: 'artifact',
      artifactId: 'delivered',
      assistantOnly: true,
    });
  });

  it('deduplicates native attachment identities and keeps inline uploaded documents clickable', () => {
    const projection = projectSessionSummaryResources(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'attachment',
              attachment: {
                kind: 'document',
                label: 'report.pdf',
                url: '/api/chat/media/outgoing/report',
                artifactId: 'delivered',
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'attachment',
              attachment: {
                kind: 'document',
                label: 'notes.txt',
                url: 'data:text/plain;base64,YQ==',
              },
            },
          ],
        },
      ],
      [artifact],
    );
    expect(projection.outputs).toHaveLength(1);
    expect(projection.sources[0]).toMatchObject({
      title: 'notes.txt',
      target: { kind: 'attachment', index: 0 },
    });
  });

  it('keeps inline bytes with the native history owner and resolves only the exact attachment revision on click', () => {
    const message = {
      role: 'user',
      __openclaw: { id: 'entry-one' },
      content: [
        {
          type: 'attachment',
          attachment: { kind: 'document', label: 'notes.txt', url: 'data:text/plain;base64,YQ==' },
        },
      ],
    };
    const resource = projectSessionSummaryResources([message], []).sources[0];
    expect(JSON.stringify(resource)).not.toContain('YQ==');
    if (resource.target.kind !== 'attachment') throw new Error('Expected attachment reference');
    expect(resolveSummaryAttachment([message], resource.target)?.url).toBe(
      'data:text/plain;base64,YQ==',
    );
    expect(resolveSummaryAttachment([{ ...message }], resource.target)).toBeNull();
    expect(resolveSummaryAttachment([], resource.target)).toBeNull();
  });

  it('reads native search results, provider citations and successful fetches, deduplicating URL fragments', () => {
    const projection = projectSessionSummaryResources(
      [
        web({
          kind: 'results',
          externalContent: evidence,
          results: [{ url: 'https://example.com/page#one', title: frame('Reference page') }],
        }),
        web({
          kind: 'answer',
          externalContent: evidence,
          citations: [{ url: 'https://example.com/other' }],
        }),
        web(
          {
            status: 200,
            url: 'https://example.com/page',
            finalUrl: 'https://example.com/page#two',
            externalContent: { ...evidence, source: 'web_fetch' },
          },
          'web_fetch',
        ),
        web(
          {
            status: 404,
            url: 'https://example.com/missing',
            externalContent: { ...evidence, source: 'web_fetch' },
          },
          'web_fetch',
        ),
        web({ results: [{ url: 'https://unverified.example/' }] }),
      ],
      [],
    );
    expect(projection.sources.map(item => item.id).sort()).toEqual([
      'url:https://example.com/other',
      'url:https://example.com/page',
    ]);
    expect(projection.outputs).toEqual([]);
    expect(
      projection.sources.find(item => item.id === 'url:https://example.com/page')?.target,
    ).toEqual({ kind: 'url', url: 'https://example.com/page#one' });
  });

  it('extracts successful nested webpage reads when the outer dispatcher output is truncated', () => {
    const projection = projectSessionSummaryResources(
      [
        nestedWeb({
          status: 200,
          url: 'https://example.com/news-feed',
          finalUrl: 'https://example.com/news-feed',
          externalContent: { ...evidence, source: 'web_fetch' },
          truncated: true,
          text: frame('Bounded webpage content'),
        }),
        nestedWeb({
          status: 200,
          url: 'https://other.example/news',
          finalUrl: 'https://other.example/news',
          title: frame('News homepage'),
          externalContent: { ...evidence, source: 'web_fetch' },
        }),
        {
          role: 'toolResult',
          toolName: 'tool_call',
          content: [{ type: 'text', text: '{"tool":"openclaw:core:web_fetch","result":' }],
          __openclaw: { truncated: true, reason: 'max_chars' },
          isError: false,
        },
      ],
      [],
    );
    expect(projection.sources.map(item => [item.title, item.target])).toEqual([
      ['News homepage', { kind: 'url', url: 'https://other.example/news' }],
      ['example.com', { kind: 'url', url: 'https://example.com/news-feed' }],
    ]);
    expect(projection.outputs).toEqual([]);
  });

  it.each(['direct', 'nested'] as const)(
    'keeps both fetched sources when the %s result JSON is cut inside the webpage body',
    kind => {
      const payload = {
        url: 'https://example.com/news',
        finalUrl: 'https://example.com/news#headlines',
        status: 200,
        title: frame('News homepage'),
        externalContent: { ...evidence, source: 'web_fetch' },
        text: `${'Webpage content '.repeat(1000)} https://unconfirmed.example/`,
      };
      const activity = nestedWeb(payload);
      const message =
        kind === 'direct'
          ? { ...web(payload, 'web_fetch'), content: truncatedWebContent(payload) }
          : {
              ...activity,
              content: [
                activity.content[0],
                { ...activity.content[1], content: truncatedWebContent(payload) },
              ],
            };

      const projection = projectSessionSummaryResources(
        [
          message,
          nestedWeb({
            url: 'https://other.example/news',
            status: 200,
            externalContent: { ...evidence, source: 'web_fetch' },
            text: 'Short webpage',
          }),
        ],
        [],
      );

      expect(projection.sources.map(item => [item.title, item.target])).toEqual([
        ['other.example', { kind: 'url', url: 'https://other.example/news' }],
        ['News homepage', { kind: 'url', url: 'https://example.com/news#headlines' }],
      ]);
      expect(projection.outputs).toEqual([]);
    },
  );

  it.each([
    { status: 404 },
    { externalContent: undefined },
    { externalContent: { ...evidence, source: 'web_search' } },
    { externalContent: { ...evidence, source: 'web_fetch', wrapped: false } },
    { url: 'javascript:alert(1)' },
    { url: 'https://user:password@example.com/' },
  ])('rejects unconfirmed fetch metadata before a truncated body: %j', overrides => {
    const payload = {
      url: 'https://example.com/news',
      status: 200,
      externalContent: { ...evidence, source: 'web_fetch' },
      ...overrides,
      text: 'Webpage content '.repeat(1000),
    };
    const message = { ...web(payload, 'web_fetch'), content: truncatedWebContent(payload) };

    expect(projectSessionSummaryResources([message], []).sources).toEqual([]);
  });

  it('does not recover malformed JSON, incomplete provenance or links inside the truncated body', () => {
    const payload = {
      url: 'https://example.com/news',
      status: 200,
      externalContent: { ...evidence, source: 'web_fetch' },
      text: 'Webpage content '.repeat(1000),
    };
    const truncated = truncatedWebContent(payload);
    const { text, ...metadata } = payload;
    const messages = [
      {
        ...web(payload, 'web_fetch'),
        content: [{ type: 'text', text: truncated[0].text.slice(0, 8000) }],
      },
      {
        ...web(payload, 'web_fetch'),
        content: truncatedWebContent({ text, ...metadata }),
      },
      {
        ...web(payload, 'web_fetch'),
        content: truncatedWebContent({
          ...payload,
          externalContent: { ...payload.externalContent, text: payload.text },
        }),
      },
      { ...web(payload, 'web_fetch'), role: 'assistant', content: truncated },
      { ...web(payload, 'web_fetch'), role: 'user', content: truncated },
      { ...web(payload, 'web_fetch'), isError: true, content: truncated },
    ];

    expect(projectSessionSummaryResources(messages, []).sources).toEqual([]);
  });

  it('deduplicates nested search results and citations against direct native web results', () => {
    const results = {
      kind: 'results',
      externalContent: evidence,
      results: [{ url: 'https://example.com/page#one', title: frame('Reference page') }],
    };
    const projection = projectSessionSummaryResources(
      [
        web(results),
        nestedWeb(results, 'web_search'),
        nestedWeb(
          {
            kind: 'answer',
            externalContent: evidence,
            citations: [{ url: 'https://example.com/other' }],
          },
          'web_search',
        ),
      ],
      [],
    );
    expect(projection.sources.map(item => item.id).sort()).toEqual([
      'url:https://example.com/other',
      'url:https://example.com/page',
    ]);
  });

  it('rejects failed, unconfirmed, and user-authored nested web evidence', () => {
    const payload = {
      status: 200,
      url: 'https://example.com/page',
      externalContent: { ...evidence, source: 'web_fetch' },
    };
    const activity = nestedWeb(payload);
    const failed = {
      ...activity,
      content: [activity.content[0], { ...activity.content[1], isError: true }],
    };
    const projection = projectSessionSummaryResources(
      [
        { ...activity, role: 'assistant' },
        { ...activity, role: 'user' },
        { ...activity, customType: 'unrelated-custom-entry' },
        { ...activity, display: false },
        { ...activity, excludeFromContext: false },
        { ...activity, content: [activity.content[0]] },
        { ...activity, content: [{ ...activity.content[1], role: 'assistant' }] },
        { ...web(payload, 'web_fetch'), role: 'assistant' },
        { ...web(payload, 'web_fetch'), role: 'user' },
        nestedWeb({ ...payload, status: 404 }),
        nestedWeb({ ...payload, externalContent: undefined }),
        failed,
      ],
      [],
    );
    expect(projection.sources).toEqual([]);
  });

  it('admits explicit local links with spaces and Chinese names, while rejecting unsafe URL protocols and credentials', () => {
    const projection = projectSessionSummaryResources(
      [
        {
          role: 'assistant',
          content:
            '[文档](file:///E:/work/%E6%8A%A5%E5%91%8A%20one.pdf) [bad](javascript:alert(1))',
        },
      ],
      [],
    );
    expect(projection.outputs[0]?.target).toEqual({ kind: 'file', path: 'E:/work/报告 one.pdf' });
    expect(projection.outputs).toHaveLength(1);
    expect(summaryWebUrl('https://user:password@example.com/')).toBeNull();
    expect(summaryWebUrl('javascript:alert(1)')).toBeNull();
  });
});
