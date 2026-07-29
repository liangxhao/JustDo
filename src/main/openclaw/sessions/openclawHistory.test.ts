import { describe, expect, test } from 'vitest';

import {
  buildScheduledReminderSystemMessage,
  extractGatewayHistoryEntries,
  extractGatewayHistoryEntry,
  extractGatewayMessageText,
} from './openclawHistory';

describe('openclawHistory', () => {
  test('extracts plain text content blocks', () => {
    expect(
      extractGatewayMessageText({
        content: [{ type: 'text', text: 'hello world' }],
      })
    ).toBe('hello world');
  });

  test('extracts output_text style content blocks', () => {
    expect(
      extractGatewayMessageText({
        content: [{ type: 'output_text', text: 'gemini output' }],
      })
    ).toBe('gemini output');
  });

  test('extracts nested parts content blocks', () => {
    expect(
      extractGatewayMessageText({
        content: {
          parts: [
            { text: 'first line' },
            { type: 'toolCall', name: 'message', arguments: { action: 'send' } },
            { text: 'second line' },
          ],
        },
      })
    ).toBe('first line\nsecond line');
  });

  test('builds history entry from assistant message with non-anthropic text shape', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'assistant',
        content: [{ type: 'output_text', text: 'final answer' }],
      })
    ).toEqual({
      role: 'assistant',
      text: 'final answer',
    });
  });

  test('keeps assistant thinking and model name from persisted history', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'assistant',
        provider: 'builtin_models',
        model: 'hdp/MiniMax-M2.7',
        content: [
          { type: 'thinking', thinking: 'I should inspect the saved result.' },
          { type: 'text', text: 'Final answer' },
        ],
      }),
    ).toEqual({
      role: 'assistant',
      text: 'Final answer',
      thinking: 'I should inspect the saved result.',
      modelName: 'hdp/MiniMax-M2.7',
    });
  });

  test('keeps thinking-only assistant turns before tool calls', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'assistant',
        model: 'test-model',
        content: [
          { type: 'reasoning', thinking: 'I need to read the file first.' },
          { type: 'toolCall', name: 'read', arguments: { path: 'result.txt' } },
        ],
      }),
    ).toEqual({
      role: 'assistant',
      text: '',
      thinking: 'I need to read the file first.',
      modelName: 'test-model',
    });
  });

  test('does not duplicate reasoning text into visible assistant content', () => {
    expect(
      extractGatewayHistoryEntry({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'text', text: 'visible answer' },
        ],
      }),
    ).toEqual({
      role: 'assistant',
      text: 'visible answer',
      thinking: 'private reasoning',
    });
  });

  test('joins text content blocks separated by toolCall blocks', () => {
    const text = extractGatewayMessageText({
      content: [
        { type: 'text', text: 'First line' },
        { type: 'toolCall', name: 'cron', arguments: { action: 'add' } },
        { type: 'text', text: 'Second line' },
      ],
    });
    expect(text).toBe('First line\nSecond line');
  });

  test('expands embedded assistant tool calls with their name, arguments, and ID', () => {
    const entries = extractGatewayHistoryEntries([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Read the file first.' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'read',
            arguments: { path: 'result.txt', offset: 10 },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
      },
    ]);

    expect(entries).toEqual([
      {
        role: 'assistant',
        text: '',
        thinking: 'Read the file first.',
      },
      {
        role: 'tool_use',
        text: '{"path":"result.txt","offset":10}',
        metadata: {
          toolName: 'read',
          toolInput: { path: 'result.txt', offset: 10 },
          toolUseId: 'call-1',
        },
      },
      {
        role: 'tool_result',
        text: 'file contents',
        metadata: {
          toolUseId: 'call-1',
          isError: false,
          toolResult: 'file contents',
          toolName: 'read',
          toolInput: {},
        },
      },
    ]);
  });

  test('keeps system messages', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'system',
      content: [{ type: 'text', text: 'Reminder fired' }],
    });
    expect(entry).toEqual({ role: 'system', text: 'Reminder fired' });
  });

  test('filters synthetic tool failure system notices', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'system',
      content:
        '⚠️ 🛠️ `Get-ChildItem ~\\justdo\\project\\memory\\* -Er…MEMORY.md -ErrorAction SilentlyContinue` failed',
    });
    expect(entry).toBeNull();
  });

  test('filters unsupported roles and empty messages', () => {
    const entries = extractGatewayHistoryEntries([
      { role: 'user', content: 'Set a reminder' },
      { role: 'system', content: [{ type: 'text', text: 'Reminder fired' }] },
      { role: 'tool', content: 'ignored' },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'cron', arguments: {} }] },
      { role: 'assistant', content: 'Done' },
    ]);
    expect(entries).toEqual([
      { role: 'user', text: 'Set a reminder' },
      { role: 'system', text: 'Reminder fired' },
      {
        role: 'tool_use',
        text: '{}',
        metadata: {
          toolName: 'cron',
          toolInput: {},
        },
      },
      { role: 'assistant', text: 'Done' },
    ]);
  });

  test('remaps scheduled reminder prompts to system messages', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: `A scheduled reminder has been triggered. The reminder content is:

⏰ 提醒：该去买菜了！

Handle this reminder internally. Do not relay it to the user unless explicitly requested.
Current time: Sunday, March 15th, 2026 — 11:27 (Asia/Shanghai)`,
    });
    expect(entry).toEqual({ role: 'system', text: '⏰ 提醒：该去买菜了！' });
  });

  test('remaps plain scheduled reminder text to a system message', () => {
    const entry = extractGatewayHistoryEntry({
      role: 'user',
      content: '⏰ 提醒：该去钉钉打卡啦！别忘了打卡哦～',
    });
    expect(entry).toEqual({ role: 'system', text: '⏰ 提醒：该去钉钉打卡啦！别忘了打卡哦～' });
  });

  test('buildScheduledReminderSystemMessage returns null for regular user text', () => {
    expect(buildScheduledReminderSystemMessage('普通聊天消息')).toBeNull();
  });
});
