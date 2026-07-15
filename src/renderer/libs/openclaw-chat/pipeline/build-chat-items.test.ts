import { expect, test } from 'vitest';

import { buildChatItems } from '@/libs/openclaw-chat/pipeline/build-chat-items';
import { extractToolCards } from '@/libs/openclaw-chat/pipeline/tool-cards';
import type { ChatItem, MessageGroup } from '@/libs/openclaw-chat/types';

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

test('keeps a persisted thinking-only assistant message after history refresh', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'user',
        content: 'start',
        timestamp: 900,
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'I should inspect the available skills.' }],
        timestamp: 1000,
      },
      {
        role: 'toolresult',
        toolCallId: 'tool-1',
        toolName: 'read',
        content: 'ok',
        timestamp: 1100,
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

  expect(assistantMessages).toHaveLength(1);
  expect(assistantMessages[0]).toEqual(
    expect.objectContaining({
      content: [{ type: 'thinking', thinking: 'I should inspect the available skills.' }],
    }),
  );
});

test('keeps reasoning visible when hiding tool calls', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should inspect the generated files.' },
          {
            type: 'toolcall',
            toolCallId: 'tool-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
        ],
        timestamp: 1000,
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: false,
  });

  const assistantMessages = firstAssistantMessages(items);

  expect(assistantMessages).toHaveLength(1);
  expect(assistantMessages[0]).toEqual(
    expect.objectContaining({
      content: expect.arrayContaining([
        { type: 'reasoning', text: 'I should inspect the generated files.' },
      ]),
    }),
  );
});

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
  expect(assistantGroups).toHaveLength(1);

  const firstMessage = assistantGroups[0]?.messages[0]?.message;
  expect(attachedToolMessages(firstMessage)).toHaveLength(1);
  const liveStream = streamItems(items)[0];
  expect(liveStream?.thinkingText).toBe('Thinking 2');
  expect(liveStream?.text).toBe('Content');
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
  expect(attachedToolMessages(firstMessage)).toHaveLength(2);
  const liveStream = streamItems(items)[0];
  expect(liveStream?.thinkingText).toBe('Thinking 2');
  expect(liveStream?.text).toBe('Content');
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

test('attaches live thinking to the following content stream during incremental updates', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking before content' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: 'Content',
    streamStartedAt: 1100,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessages = firstAssistantMessages(items);
  const liveStream = streamItems(items)[0];

  expect(assistantMessages).toHaveLength(0);
  expect(liveStream?.thinkingText).toBe('Thinking before content');
  expect(liveStream?.text).toBe('Content');
});

test('merges committed live thinking with the following committed content segment', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking before segment' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
    ],
    toolMessages: [],
    streamSegments: [
      {
        text: 'Segment content',
        ts: 1100,
      },
    ],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessages = firstAssistantMessages(items);

  expect(assistantMessages).toHaveLength(1);
  expect(assistantMessages[0]).toEqual(
    expect.objectContaining({
      content: [
        { type: 'thinking', thinking: 'Thinking before segment' },
        { type: 'text', text: 'Segment content' },
      ],
    }),
  );
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

test('hides unreliable zero goal usage from the live assistant stream', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: 'Goal complete: Write a poem\nTokens used: 0',
    streamStartedAt: 1100,
    queue: [],
    showToolCalls: true,
  });

  expect(streamItems(items)[0]?.text).toBe('Goal complete: Write a poem');
});

test('groups committed stream segments as assistant content during incremental updates', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'user',
        content: 'Hello',
        timestamp: 1000,
      },
    ],
    toolMessages: [],
    streamSegments: [
      {
        text: 'First content',
        ts: 1100,
      },
      {
        text: 'First content\nSecond content',
        ts: 1200,
      },
    ],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantGroups = groups(items).filter(group => group.role === 'assistant');

  expect(assistantGroups).toHaveLength(1);
  expect(assistantGroups[0]?.messages).toHaveLength(2);
  expect(streamItems(items)).toHaveLength(0);
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

test('keeps an existing collapsed tool timeline closed when a new live tool is appended', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tool-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
          {
            type: 'toolCall',
            id: 'tool-2',
            name: 'Write',
            arguments: { file_path: 'out.txt', content: 'ok' },
          },
        ],
        timestamp: 1000,
      },
    ],
    toolMessages: [
      {
        role: 'assistant',
        toolCallId: 'tool-3',
        toolName: 'Bash',
        timestamp: 1100,
        __justdoToolActive: true,
        content: [
          {
            type: 'toolcall',
            toolCallId: 'tool-3',
            name: 'Bash',
            arguments: { command: 'npm test' },
          },
        ],
      },
    ],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessage = groups(items).find(group => group.role === 'assistant')?.messages[0]
    ?.message;
  expect(attachedToolMessages(assistantMessage).length).toBeGreaterThan(0);
  expect(toolTimelineIsOpen(assistantMessage)).toBe(false);
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

test('hydrates standalone tool result input from standalone tool use metadata', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking' }],
        timestamp: 1000,
        __openclawLiveThinking: true,
      },
      {
        role: 'tool_use',
        id: 'tool-use-1',
        timestamp: 1100,
        content: 'Read',
        toolCallId: 'tool-1',
        metadata: {
          toolUseId: 'tool-1',
          toolName: 'Read',
          toolInput: { file_path: 'README.md' },
        },
      },
      {
        role: 'tool_result',
        id: 'tool-result-1',
        timestamp: 1200,
        content: 'ok',
        toolCallId: 'tool-1',
        metadata: {
          toolUseId: 'tool-1',
          toolName: 'Read',
        },
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessage = firstAssistantMessages(items)[0];
  const attached = attachedToolMessages(assistantMessage);
  expect(attached).toHaveLength(2);
  expect(extractToolCards(attached[1])[0]?.args).toEqual({ file_path: 'README.md' });
});

test('hydrates standalone tool result input from an enveloped assistant tool call', () => {
  const toolCallId = 'call_00_iIMN8XpMcvtg9VBlJxGo2769';
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        type: 'message',
        id: 'assistant-envelope',
        timestamp: '2026-07-01T03:37:32.824Z',
        message: {
          role: 'assistant',
          timestamp: 1782877052824,
          content: [
            { type: 'thinking', thinking: 'The document is generated.' },
            { type: 'text', text: '现在清理一下临时文件~' },
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'exec',
              arguments: {
                command: 'Remove-Item "E:\\workspace\\examples\\1111\\create_doc.js" -Force 2>&1',
                timeout: 5,
              },
              partialArgs:
                '{"command":"Remove-Item \\"E:\\\\workspace\\\\examples\\\\1111\\\\create_doc.js\\" -Force 2>&1","timeout":5}',
            },
          ],
        },
      },
      {
        role: 'assistant',
        timestamp: 1782877052825,
        content: [{ type: 'text', text: 'visible message near the tool result' }],
      },
      {
        role: 'toolResult',
        toolCallId,
        toolName: 'exec',
        timestamp: 1782877057723,
        content: [{ type: 'text', text: '(no output)' }],
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantMessage = firstAssistantMessages(items).find(message =>
    JSON.stringify(message).includes('visible message near the tool result'),
  );
  const attached = attachedToolMessages(assistantMessage);
  expect(attached).toHaveLength(1);
  expect(extractToolCards(attached[0])[0]?.args).toEqual({
    command: 'Remove-Item "E:\\workspace\\examples\\1111\\create_doc.js" -Force 2>&1',
    timeout: 5,
  });
});

test('attaches a tool result to the preceding assistant message that owns the tool call after text', () => {
  const toolCallId = 'call_00_iIMN8XpMcvtg9VBlJxGo2769';
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        timestamp: 1782877052810,
        content: [
          { type: 'thinking', thinking: 'Previous thinking' },
          {
            type: 'toolCall',
            id: 'previous-tool',
            name: 'exec',
            arguments: { command: 'previous' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'previous-tool',
        toolName: 'exec',
        timestamp: 1782877052818,
        content: [{ type: 'text', text: 'previous output' }],
      },
      {
        role: 'assistant',
        timestamp: 1782877052824,
        content: [
          { type: 'thinking', thinking: 'The document is generated.' },
          { type: 'text', text: '现在清理一下临时文件~' },
          {
            type: 'toolCall',
            id: toolCallId,
            name: 'exec',
            arguments: {},
            partialArgs:
              '{"command":"Remove-Item \\"E:\\\\workspace\\\\examples\\\\1111\\\\create_doc.js\\" -Force 2>&1","timeout":5}',
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId,
        toolName: 'exec',
        timestamp: 1782877057723,
        content: [{ type: 'text', text: '(no output)' }],
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
  const cleanupMessage = assistantMessages.find(message =>
    JSON.stringify(message).includes('现在清理一下临时文件'),
  );
  expect(cleanupMessage).toBeDefined();
  const attached = attachedToolMessages(cleanupMessage);
  expect(attached).toHaveLength(1);
  expect(extractToolCards(cleanupMessage)[0]?.args).toMatchObject({ timeout: 5 });
  expect(extractToolCards(attached[0])[0]?.outputText).toBe('(no output)');
});

test('prefers the assistant message that owns the matching tool call over a nearby assistant', () => {
  const toolCallId = 'tool-cleanup';
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        timestamp: 1000,
        content: [
          { type: 'text', text: 'content before cleanup' },
          {
            type: 'toolCall',
            id: toolCallId,
            name: 'exec',
            arguments: { command: 'Remove-Item tmp.js' },
          },
        ],
      },
      {
        role: 'assistant',
        timestamp: 1001,
        content: [{ type: 'text', text: 'final text after cleanup' }],
      },
      {
        role: 'toolResult',
        toolCallId,
        toolName: 'exec',
        timestamp: 1002,
        content: [{ type: 'text', text: '(no output)' }],
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
  const ownerMessage = assistantMessages.find(message =>
    JSON.stringify(message).includes('content before cleanup'),
  );
  const nearbyMessage = assistantMessages.find(message =>
    JSON.stringify(message).includes('final text after cleanup'),
  );
  expect(attachedToolMessages(ownerMessage)).toHaveLength(1);
  expect(attachedToolMessages(nearbyMessage)).toHaveLength(0);
});

test('preserves assistant model name on grouped messages', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Content' }],
        timestamp: 1000,
        modelName: 'gpt-4.1',
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  const assistantGroup = groups(items).find(group => group.role === 'assistant');
  expect(assistantGroup?.modelName).toBe('gpt-4.1');
});

test('builds an expandable compaction divider with token counts and summary', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'system',
        timestamp: 2000,
        __openclaw: {
          kind: 'compaction',
          id: 'checkpoint-1',
          tokensBefore: 25_329,
          tokensAfter: 1_069,
          summary: 'The compacted conversation summary.',
        },
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  expect(items).toEqual([
    expect.objectContaining({
      kind: 'divider',
      key: 'divider:compaction:checkpoint-1',
      label: '25,329 → 1,069 tokens',
      summary: 'The compacted conversation summary.',
    }),
  ]);
});

test('renders an incomplete compaction marker as not needing compaction', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'system',
        timestamp: 2000,
        __openclaw: {
          kind: 'compaction',
          id: 'checkpoint-1',
        },
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  expect(items).toEqual([
    expect.objectContaining({
      kind: 'divider',
      key: 'divider:compaction:checkpoint-1',
      label: 'No context compaction needed',
      expandable: false,
    }),
  ]);
});

test('builds a non-expandable divider when compaction is not needed', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'system',
        timestamp: 2000,
        __openclaw: {
          kind: 'compaction-skipped',
          reason: 'not enough history',
        },
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  expect(items).toEqual([
    expect.objectContaining({
      kind: 'divider',
      label: 'No context compaction needed',
      description: 'not enough history',
      expandable: false,
    }),
  ]);
});

test('treats OpenClaw empty-conversation summaries as not needing compaction', () => {
  const items = buildChatItems({
    sessionKey: 'session-1',
    messages: [
      {
        role: 'system',
        timestamp: 2000,
        __openclaw: {
          kind: 'compaction',
          id: 'checkpoint-1',
          tokensBefore: 1200,
          tokensAfter: 200,
          summary: `## Goal
No conversation provided. Unable to determine user goal.

## Progress
### Done
- (none)

### Blocked
- No conversation to summarize.`,
        },
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
  });

  expect(items).toEqual([
    expect.objectContaining({
      kind: 'divider',
      label: 'No context compaction needed',
      expandable: false,
    }),
  ]);
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
