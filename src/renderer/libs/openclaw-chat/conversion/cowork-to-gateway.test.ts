import { describe, expect, test } from 'vitest';

import type { CoworkMessage } from '@/features/cowork/coworkTypes';
import {
  coworkMessagesToGateway,
  coworkMessageToGateway,
  resolveChatDisplayMessages,
} from '@/libs/openclaw-chat/conversion/cowork-to-gateway';
import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';

describe('coworkMessageToGateway', () => {
  test('uses raw Gateway messages without applying the Cowork field projection', () => {
    const gatewayMessages = [
      {
        role: 'assistant',
        content: [{ type: 'future_content', value: 'preserved' }],
        futureGatewayField: { retained: true },
      },
    ];

    expect(resolveChatDisplayMessages([], gatewayMessages)).toBe(gatewayMessages);
  });

  test('converts user image metadata into renderable base64 attachments', () => {
    const message: CoworkMessage = {
      id: 'message-1',
      type: 'user',
      content: '看看这张图',
      timestamp: 1,
      metadata: {
        attachments: [
          {
            name: 'example.png',
            mimeType: 'image/png',
            base64Data: 'YWJj',
          },
        ],
      },
    };

    expect(coworkMessageToGateway(message).content).toEqual([
      { type: 'text', text: '看看这张图' },
      {
        type: 'attachment',
        attachment: {
          url: 'data:image/png;base64,YWJj',
          kind: 'image',
          label: 'example.png',
          mimeType: 'image/png',
        },
      },
    ]);
  });

  test('keeps plain user messages as strings', () => {
    const message: CoworkMessage = {
      id: 'message-2',
      type: 'user',
      content: 'hello',
      timestamp: 2,
    };

    expect(coworkMessageToGateway(message).content).toBe('hello');
  });

  test('keeps assistant thinking before text when both are on one message', () => {
    const message: CoworkMessage = {
      id: 'message-3',
      type: 'assistant',
      content: 'Now I can continue.',
      thinkingContent: 'I should wait for the subagent result.',
      timestamp: 3,
    };

    expect(coworkMessageToGateway(message).content).toEqual([
      { type: 'thinking', thinking: 'I should wait for the subagent result.' },
      { type: 'text', text: 'Now I can continue.' },
    ]);
  });

  test('keeps the assistant model name for static message rendering', () => {
    const message: CoworkMessage = {
      id: 'message-4',
      type: 'assistant',
      content: 'Done.',
      timestamp: 4,
      metadata: { modelName: 'hdp/MiniMax-M2.7' },
    };

    expect(coworkMessageToGateway(message).modelName).toBe('hdp/MiniMax-M2.7');
  });

  test('renders persisted tool names and arguments in the process summary', () => {
    const messages: CoworkMessage[] = [
      {
        id: 'tool-use-1',
        type: 'tool_use',
        content: '{"path":"result.txt"}',
        timestamp: 5,
        metadata: {
          toolName: 'read',
          toolInput: { path: 'result.txt' },
          toolUseId: 'call-1',
        },
      },
      {
        id: 'tool-result-1',
        type: 'tool_result',
        content: 'file contents',
        timestamp: 6,
        metadata: {
          toolName: 'read',
          toolResult: 'file contents',
          toolUseId: 'call-1',
        },
      },
    ];

    expect(projectPersistedTimeline(coworkMessagesToGateway(messages))).toEqual([
      expect.objectContaining({
        kind: 'process-summary',
        items: [
          expect.objectContaining({
            toolCallId: 'call-1',
            name: 'read',
            input: { path: 'result.txt' },
            output: 'file contents',
          }),
        ],
      }),
    ]);
  });
});
