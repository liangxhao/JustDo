import { expect, test } from 'vitest';

import { buildChatItems } from '@/libs/openclaw-chat/pipeline/build-chat-items';
import type { ChatItem, MessageGroup } from '@/libs/openclaw-chat/types';

function build(overrides: Partial<Parameters<typeof buildChatItems>[0]> = {}) {
  return buildChatItems({
    sessionKey: 'session-1',
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  });
}

test.each([
  ['failed', '上下文压缩失败'],
  ['skipped', '上下文压缩已跳过'],
  ['aborted', '上下文压缩已取消'],
])(
  'renders the %s compaction outcome without a success label or unfinished summary',
  (phase, label) => {
    const items = build({
      messages: [
        {
          role: 'system',
          timestamp: 1,
          __openclaw: {
            kind: 'compaction-status',
            id: 'compact-1',
            phase,
            reason: 'native reason',
            summary: 'Partial model output',
            tokensBefore: 100,
            tokensAfter: 20,
          },
        },
      ],
    });
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'divider',
        label,
        description: 'native reason',
        inProgress: false,
        expandable: false,
        summary: undefined,
      }),
    );
  },
);

function groups(items: ReturnType<typeof buildChatItems>): MessageGroup[] {
  return items.filter((item): item is MessageGroup => item.kind === 'group');
}

test('keeps identical messages from different collaborating agents separate and attributed', () => {
  const items = build({
    peerPerspective: true,
    messages: ['review', 'writer'].map((agentId, index) => ({
      role: 'user',
      timestamp: index + 1,
      content: 'Done.',
      provenance: {
        kind: 'inter_session',
        sourceSessionKey: `agent:${agentId}:justdo:peer-${index}`,
        sourceTool: 'collaboration_send',
      },
    })),
  });

  const result = groups(items);
  expect(result).toHaveLength(2);
  expect(result[0].senderLabel).toContain('review');
  expect(result[1].senderLabel).toContain('writer');
  expect(result.map(group => group.senderId)).toEqual(['review', 'writer']);
  expect(result.map(group => group.messages.length)).toEqual([1, 1]);
  expect(result.every(group => !group.messages[0].duplicateCount)).toBe(true);
});

test('places every collaborating sender on the input side regardless of its native role', () => {
  const result = groups(
    build({
      peerPerspective: true,
      messages: [
        {
          role: 'assistant',
          timestamp: 1,
          content: 'Please incorporate this review.',
          provenance: {
            kind: 'inter_session',
            sourceSessionKey: 'agent:review:justdo:peer',
            sourceTool: 'sessions_send',
          },
        },
        { role: 'assistant', timestamp: 2, content: 'I incorporated the review.' },
      ],
    }),
  );

  expect(result.map(group => [group.role, group.senderId])).toEqual([
    ['user', 'review'],
    ['assistant', null],
  ]);
});

test('hides trusted peer transport messages outside member-history perspective', () => {
  const result = groups(
    build({
      messages: [
        {
          role: 'assistant',
          timestamp: 1,
          content: 'Internal peer result.',
          provenance: {
            kind: 'inter_session',
            sourceSessionKey: 'agent:review:justdo:peer',
            sourceTool: 'sessions_send',
          },
        },
        { role: 'assistant', timestamp: 2, content: 'User-facing synthesis.' },
      ],
    }),
  );

  expect(result).toHaveLength(1);
  expect(result[0].messages[0].message).toMatchObject({ content: 'User-facing synthesis.' });
});

test('hides the native group summary trigger while retaining the actual summary in main history', () => {
  const provenance = {
    kind: 'inter_session',
    sourceSessionKey: 'agent:review:justdo:group-member',
    sourceChannel: 'justdo-team',
    sourceTool: 'team_discussion',
  };
  const input = 'A group discussion has ended. Summarize its available public results.';
  const result = groups(
    build({
      peerPerspective: false,
      historyRenderLimit: 2,
      messages: [
        { role: 'user', timestamp: 1, content: 'Please discuss the design.' },
        { role: 'user', timestamp: 2, content: input, provenance },
        // An assistant output remains visible even if native provenance is carried forward.
        {
          role: 'assistant',
          timestamp: 3,
          content: 'The recommended design is simple.',
          provenance,
        },
      ],
    }),
  );
  expect(result.map(group => group.role)).toEqual(['user', 'assistant']);
  expect(result.flatMap(group => group.messages.map(item => item.message))).toEqual([
    expect.objectContaining({ content: 'Please discuss the design.' }),
    expect.objectContaining({ content: 'The recommended design is simple.' }),
  ]);
});

test('retains group dispatch input under a separate identity in member history', () => {
  const input = {
    role: 'user',
    timestamp: 1,
    content: 'Group thread round 2. Add something new only; otherwise reply NO_REPLY.',
    provenance: {
      kind: 'inter_session',
      sourceSessionKey: 'agent:main:team-discussion:room',
      sourceChannel: 'justdo-team',
      sourceTool: 'team_discussion',
    },
  };
  const result = groups(build({ peerPerspective: true, messages: [input] }));
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ role: 'user', senderId: 'team-discussion:dispatcher' });
  expect(result[0].senderLabel).toBeTruthy();
  expect(result[0].messages[0].message).toBe(input);
  expect(input).not.toHaveProperty('senderId');
});

test.each([
  undefined,
  { kind: 'external_user', sourceChannel: 'justdo-team', sourceTool: 'team_discussion' },
  { kind: 'inter_session', sourceChannel: 'webchat', sourceTool: 'team_discussion' },
  { kind: 'inter_session', sourceChannel: 'justdo-team', sourceTool: 'another-tool' },
])('does not hide a user-authored summary prompt or another origin (%j)', provenance => {
  const content = 'A group discussion has ended. Summarize its available public results.';
  const result = groups(build({ messages: [{ role: 'user', content, provenance }] }));
  expect(result).toHaveLength(1);
  expect(result[0].messages[0].message).toMatchObject({ role: 'user', content });
});

function streams(
  items: ReturnType<typeof buildChatItems>,
): Extract<ChatItem, { kind: 'stream' }>[] {
  return items.filter((item): item is Extract<ChatItem, { kind: 'stream' }> => {
    return item.kind === 'stream';
  });
}

test('keeps persisted Thinking data available for the canonical history projection', () => {
  const items = build({
    messages: [
      {
        role: 'assistant',
        timestamp: 1,
        content: [{ type: 'thinking', thinking: 'Inspect the repository.' }],
      },
    ],
  });

  expect(JSON.stringify(items)).toContain('Inspect the repository.');
});

test('keeps Content stream ordering without attaching legacy Tool metadata', () => {
  const items = build({
    messages: [
      {
        role: 'assistant',
        timestamp: 1,
        content: [{ type: 'thinking', thinking: 'Inspect first.' }],
        __openclawLiveThinking: true,
      },
    ],
    toolMessages: [
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        __justdoToolActive: true,
      },
    ],
    streamSegments: [{ text: 'Visible answer', ts: 2 }],
  });
  const serialized = JSON.stringify(items);

  expect(serialized).toContain('Visible answer');
  expect(serialized).not.toContain('__justdoAttachedToolMessages');
  expect(serialized).not.toContain('__justdoToolTimelineOpen');
  expect(serialized).not.toContain('assistant-tools:');
});

test('drops standalone Tool history from the legacy content pipeline', () => {
  const items = build({
    messages: [
      {
        role: 'toolresult',
        tool_call_id: 'tool-1',
        toolName: 'Read',
        timestamp: 1,
        content: 'ok',
      },
    ],
  });

  expect(groups(items)).toHaveLength(0);
  expect(JSON.stringify(items)).not.toContain('__justdoAttachedToolMessages');
});

test('does not add live Tool messages to stream items', () => {
  const items = build({
    toolMessages: [
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        __justdoToolActive: true,
      },
    ],
    stream: 'Visible answer',
    streamStartedAt: 1,
  });
  const stream = streams(items)[0];

  expect(stream?.text).toBe('Visible answer');
  expect(stream).not.toHaveProperty('toolMessages');
});

test.each([
  'Logs: openclaw logs --follow',
  'To view logs, run `openclaw logs --follow` in a terminal.',
])('removes the OpenClaw log hint from the legacy assistant stream: %s', hint => {
  const items = build({
    stream: `Task failed\n${hint}`,
    streamStartedAt: 1,
  });

  expect(streams(items)[0]?.text).toBe('Task failed');
});

test('preserves assistant model names on ordinary Content groups', () => {
  const items = build({
    messages: [
      {
        role: 'assistant',
        model: 'openai/gpt-5',
        timestamp: 1,
        content: [{ type: 'text', text: 'Answer' }],
      },
    ],
  });

  expect(groups(items)[0]?.modelName).toBe('openai/gpt-5');
});

test('builds a compaction divider with token counts and summary', () => {
  const items = build({
    messages: [
      {
        role: 'system',
        timestamp: 1,
        content: '',
        __openclaw: {
          kind: 'compaction',
          id: 'compact-1',
          tokensBefore: 12000,
          tokensAfter: 4000,
          summary: 'Earlier work was compacted.',
        },
      },
    ],
  });
  const divider = items.find(
    (item): item is Extract<ChatItem, { kind: 'divider' }> => item.kind === 'divider',
  );

  expect(divider?.label).toContain('12,000');
  expect(divider?.label).toContain('4,000');
  expect(divider?.summary).toBe('Earlier work was compacted.');
});

test('keeps an automatic compaction summary expandable without token or checkpoint metadata', () => {
  const items = build({
    messages: [
      {
        role: 'system',
        timestamp: 1,
        content: '',
        __openclaw: {
          kind: 'compaction',
          id: 'automatic-compact-1',
          summary: 'Automatic compaction preserved the active task.',
        },
      },
    ],
  });
  const divider = items.find(
    (item): item is Extract<ChatItem, { kind: 'divider' }> => item.kind === 'divider',
  );

  expect(divider).toEqual(
    expect.objectContaining({
      label: '上下文已压缩',
      summary: 'Automatic compaction preserved the active task.',
      expandable: true,
    }),
  );
  expect(divider).not.toHaveProperty('action');
});

test('builds a localized in-progress divider for local compaction status', () => {
  const items = build({
    messages: [
      {
        role: 'system',
        timestamp: 1,
        __openclaw: {
          kind: 'compaction-status',
          id: 'local-compact-1',
          phase: 'in-progress',
        },
      },
    ],
  });
  const divider = items.find(
    (item): item is Extract<ChatItem, { kind: 'divider' }> => item.kind === 'divider',
  );

  expect(divider).toEqual(
    expect.objectContaining({
      key: 'divider:compaction-status:local-compact-1',
      label: '正在压缩上下文…',
      expandable: false,
      inProgress: true,
    }),
  );
});

test('makes a streamed in-progress compaction summary expandable', () => {
  const items = build({
    messages: [
      {
        role: 'system',
        timestamp: 1,
        __openclaw: {
          kind: 'compaction-status',
          id: 'local-compact-streaming',
          phase: 'in-progress',
          summary: 'Preserved decisions and current implementation state.',
        },
      },
    ],
  });
  const divider = items.find(
    (item): item is Extract<ChatItem, { kind: 'divider' }> => item.kind === 'divider',
  );

  expect(divider).toEqual(
    expect.objectContaining({
      label: '正在压缩上下文…',
      summary: 'Preserved decisions and current implementation state.',
      expandable: true,
      inProgress: true,
    }),
  );
});
