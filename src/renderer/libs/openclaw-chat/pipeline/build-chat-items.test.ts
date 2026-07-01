import { expect, test } from 'vitest';

import type { ChatItem, MessageGroup } from '../types';
import { buildChatItems } from './build-chat-items';

function groups(items: ReturnType<typeof buildChatItems>): MessageGroup[] {
  return items.filter((item): item is MessageGroup => item.kind === 'group');
}

function attachedToolMessages(message: unknown): unknown[] {
  const attached = (message as Record<string, unknown>).__justdoAttachedToolMessages;
  return Array.isArray(attached) ? attached : [];
}

function toolTimelineIsOpen(message: unknown): boolean {
  return (message as Record<string, unknown>).__justdoToolTimelineOpen === true;
}

function firstAssistantMessages(items: ReturnType<typeof buildChatItems>): unknown[] {
  return groups(items)
    .filter(group => group.role === 'assistant')
    .flatMap(group => group.messages.map(entry => entry.message));
}

function streamItems(items: ReturnType<typeof buildChatItems>): Extract<ChatItem, { kind: 'stream' }>[] {
  return items.filter((item): item is Extract<ChatItem, { kind: 'stream' }> => item.kind === 'stream');
}

function historyToolUse(timestamp = 1100): Record<string, unknown> {
  return {
    role: 'assistant',
    id: `tool-use-${timestamp}`,
    timestamp,
    content: [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'README.md' },
      },
    ],
  };
}

function historyToolResult(timestamp = 1200): Record<string, unknown> {
  return {
    role: 'toolresult',
    id: `tool-result-${timestamp}`,
    tool_call_id: 'tool-1',
    tool_use_id: 'tool-1',
    toolName: 'Read',
    timestamp,
    content: 'ok',
  };
}

function liveToolMessage(timestamp = 1100): Record<string, unknown> {
  return {
    role: 'assistant',
    toolCallId: 'tool-1',
    toolName: 'Read',
    timestamp,
    __justdoToolActive: false,
    content: [
      {
        type: 'toolcall',
        toolCallId: 'tool-1',
        name: 'Read',
        arguments: { file_path: 'README.md' },
      },
      {
        type: 'toolresult',
        toolCallId: 'tool-1',
        name: 'Read',
        text: 'ok',
      },
    ],
  };
}

test('keeps a live tool attached to the preceding thinking message during incremental updates', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 1' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 2' }],
        timestamp: 1200,
        __openclawLiveThinking: true,
      },
    ],
    toolMessages: [
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        timestamp: 1100,
        content: [
          {
            type: 'toolcall',
            toolCallId: 'tool-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
          {
            type: 'toolresult',
            toolCallId: 'tool-1',
            name: 'Read',
            text: 'ok',
          },
        ],
      },
    ],
    streamSegments: [],
    stream: 'Content',
    streamStartedAt: 1300,
    queue: [],
    showToolCalls: true,
  });

  const assistantGroups = groups(items).filter(group => group.role === 'assistant');
  expect(assistantGroups).toHaveLength(2);

  const firstMessage = assistantGroups[0]?.messages[0]?.message;
  const secondMessage = assistantGroups[1]?.messages[0]?.message;
  expect(attachedToolMessages(firstMessage)).toHaveLength(1);
  expect(attachedToolMessages(secondMessage)).toHaveLength(0);
  expect(items.some(item => item.kind === 'stream')).toBe(true);
});

test('keeps split live tool start and result attached to the first tool location', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 1' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 2' }],
        timestamp: 1200,
        __openclawLiveThinking: true,
      },
    ],
    toolMessages: [
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        timestamp: 1100,
        content: [
          {
            type: 'toolcall',
            toolCallId: 'tool-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
        ],
      },
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        timestamp: 1250,
        content: [
          {
            type: 'toolresult',
            toolCallId: 'tool-1',
            name: 'Read',
            text: 'ok',
          },
        ],
      },
    ],
    streamSegments: [],
    stream: 'Content',
    streamStartedAt: 1300,
    queue: [],
    showToolCalls: true,
  });

  const assistantGroups = groups(items).filter(group => group.role === 'assistant');
  const firstMessage = assistantGroups[0]?.messages[0]?.message;
  const secondMessage = assistantGroups[1]?.messages[0]?.message;
  expect(attachedToolMessages(firstMessage)).toHaveLength(2);
  expect(attachedToolMessages(secondMessage)).toHaveLength(0);
});

test('keeps Thinking Tool Content order during incremental updates', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
    ],
    toolMessages: [liveToolMessage(1100)],
    streamSegments: [],
    stream: 'Content',
    streamStartedAt: 1200,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessages = firstAssistantMessages(items);
  expect(assistantMessages).toHaveLength(1);
  expect(attachedToolMessages(assistantMessages[0])).toHaveLength(1);
  expect(items[items.length - 1]?.kind).toBe('stream');
});

test('keeps the waiting indicator and first content delta on the same stream item', () => {
  const baseProps = {
    sessionKey: 'session-1',
    messages: [
      {
        role: 'user',
        content: 'Hello',
        timestamp: 1000,
      },
    ],
    toolMessages: [],
    streamSegments: [],
    streamStartedAt: 1100,
    queue: [],
    showToolCalls: true,
  };

  const waitingItems = buildChatItems({
    ...baseProps,
    stream: '',
  });
  const firstDeltaItems = buildChatItems({
    ...baseProps,
    stream: 'Content',
  });

  const waitingStream = streamItems(waitingItems)[0];
  const firstDeltaStream = streamItems(firstDeltaItems)[0];

  expect(waitingStream).toBeDefined();
  expect(firstDeltaStream).toBeDefined();
  expect(waitingStream?.key).toBe(firstDeltaStream?.key);
  expect(waitingStream?.text).toBe('');
  expect(firstDeltaStream?.text).toBe('Content');
  expect(waitingItems.some(item => item.kind === 'reading-indicator')).toBe(false);
});

test('keeps Thinking Tool order after full refresh', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
      historyToolUse(1100),
      historyToolResult(1200),
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessages = firstAssistantMessages(items);
  expect(assistantMessages).toHaveLength(1);
  expect(attachedToolMessages(assistantMessages[0])).toHaveLength(2);
});

test('renders a Tool only history response as a synthetic assistant tool group', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [historyToolUse(1000), historyToolResult(1100)],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessages = firstAssistantMessages(items);
  expect(assistantMessages).toHaveLength(1);
  expect(attachedToolMessages(assistantMessages[0])).toHaveLength(2);
});

test('keeps Tool Content order after full refresh', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      historyToolUse(1000),
      historyToolResult(1100),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Content' }],
        timestamp: 1200,
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessages = firstAssistantMessages(items);
  expect(assistantMessages).toHaveLength(2);
  expect(attachedToolMessages(assistantMessages[0])).toHaveLength(2);
  expect(attachedToolMessages(assistantMessages[1])).toHaveLength(0);
});

test('collapses a live tool timeline as soon as that tool result arrives', () => {
  const baseProps = {
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
    ],
    streamSegments: [],
    stream: 'Content',
    streamStartedAt: 1300,
    queue: [],
    showToolCalls: true,
  };

  const withStartedTool = buildChatItems({
    ...baseProps,
    toolMessages: [
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        timestamp: 1100,
        __justdoToolActive: true,
        content: [
          {
            type: 'toolcall',
            toolCallId: 'tool-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
        ],
      },
    ],
  });

  const startedMessage = groups(withStartedTool).find(group => group.role === 'assistant')
    ?.messages[0]?.message;
  expect(toolTimelineIsOpen(startedMessage)).toBe(true);

  const withCompletedTool = buildChatItems({
    ...baseProps,
    toolMessages: [
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        timestamp: 1100,
        __justdoToolActive: false,
        content: [
          {
            type: 'toolcall',
            toolCallId: 'tool-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
          {
            type: 'toolresult',
            toolCallId: 'tool-1',
            name: 'Read',
            text: 'ok',
          },
        ],
      },
    ],
  });

  const completedMessage = groups(withCompletedTool).find(group => group.role === 'assistant')
    ?.messages[0]?.message;
  expect(attachedToolMessages(completedMessage)).toHaveLength(1);
  expect(toolTimelineIsOpen(completedMessage)).toBe(false);
});

test('keeps split history tool start and result attached consistently after full refresh', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 1' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        timestamp: 1100,
        content: [
          {
            type: 'toolcall',
            toolCallId: 'tool-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 2' }],
        timestamp: 1200,
        __openclawLiveThinking: true,
      },
      {
        role: 'assistant',
        toolCallId: 'tool-1',
        toolName: 'Read',
        timestamp: 1250,
        content: [
          {
            type: 'toolresult',
            toolCallId: 'tool-1',
            name: 'Read',
            text: 'ok',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Content' }],
        timestamp: 1300,
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantGroups = groups(items).filter(group => group.role === 'assistant');
  expect(assistantGroups).toHaveLength(3);

  const firstMessage = assistantGroups[0]?.messages[0]?.message;
  const secondMessage = assistantGroups[1]?.messages[0]?.message;
  const contentMessage = assistantGroups[2]?.messages[0]?.message;
  expect(attachedToolMessages(firstMessage)).toHaveLength(2);
  expect(attachedToolMessages(secondMessage)).toHaveLength(0);
  expect(attachedToolMessages(contentMessage)).toHaveLength(0);
});

test('treats cowork tool_use history messages as attachable tools after full refresh', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 1' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
      {
        role: 'assistant',
        id: 'message-tool-use-row-id',
        timestamp: 1100,
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking 2' }],
        timestamp: 1200,
        __openclawLiveThinking: true,
      },
      {
        role: 'toolresult',
        id: 'message-tool-result-row-id',
        tool_call_id: 'tool-1',
        tool_use_id: 'tool-1',
        toolName: 'Read',
        timestamp: 1250,
        content: 'ok',
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Content' }],
        timestamp: 1300,
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantGroups = groups(items).filter(group => group.role === 'assistant');
  expect(assistantGroups).toHaveLength(3);

  const firstMessage = assistantGroups[0]?.messages[0]?.message;
  const secondMessage = assistantGroups[1]?.messages[0]?.message;
  expect(attachedToolMessages(firstMessage)).toHaveLength(2);
  expect(attachedToolMessages(secondMessage)).toHaveLength(0);
});
