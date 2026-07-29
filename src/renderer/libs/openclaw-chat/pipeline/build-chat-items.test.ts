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

function groups(items: ReturnType<typeof buildChatItems>): MessageGroup[] {
  return items.filter((item): item is MessageGroup => item.kind === 'group');
}

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
      label: 'Context compacted',
      summary: 'Automatic compaction preserved the active task.',
      expandable: true,
    }),
  );
  expect(divider?.action).toBeUndefined();
});

test('builds an English in-progress divider for local compaction status', () => {
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
      label: 'Compacting...',
      expandable: false,
    }),
  );
});
