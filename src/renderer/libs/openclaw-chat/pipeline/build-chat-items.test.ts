import { expect, test } from 'vitest';

import type { MessageGroup } from '../types';
import { buildChatItems } from './build-chat-items';

function groups(items: ReturnType<typeof buildChatItems>): MessageGroup[] {
  return items.filter((item): item is MessageGroup => item.kind === 'group');
}

function attachedToolMessages(message: unknown): unknown[] {
  const attached = (message as Record<string, unknown>).__justdoAttachedToolMessages;
  return Array.isArray(attached) ? attached : [];
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
