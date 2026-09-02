import { describe, expect, test } from 'vitest';

import type { CoworkSession } from '@/features/cowork/coworkTypes';
import {
  buildSessionExportFileName,
  createSessionExportDocument,
  SESSION_EXPORT_SCHEMA,
} from '@/features/cowork/sessionExport';

const session: CoworkSession = {
  id: 'session-1',
  title: 'Export example',
  status: 'completed',
  pinned: false,
  cwd: 'C:\\workspace',
  executionMode: 'auto',
  permissionMode: 'full',
  activeSkillIds: [],
  agentId: 'main',
  createdAt: Date.parse('2026-07-20T01:00:00.000Z'),
  updatedAt: Date.parse('2026-07-20T02:00:00.000Z'),
};

describe('createSessionExportDocument', () => {
  test('converts text and tool messages to OpenAI-compatible messages', () => {
    const rawMessages = [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should inspect it.' },
          { type: 'text', text: 'I will read it.' },
          { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'toolresult',
        tool_call_id: 'call-1',
        toolName: 'read_file',
        content: 'hello',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The file says hello.' }] },
    ];

    const result = createSessionExportDocument({
      session,
      messages: rawMessages,
      model: 'gpt-test',
      runtimeSessionId: 'runtime-1',
      includeRawData: true,
      exportedAt: new Date('2026-07-21T00:00:00.000Z'),
    });

    expect(result.schema).toBe(SESSION_EXPORT_SCHEMA);
    expect(result.model).toBe('gpt-test');
    expect(result.messages).toEqual([
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: 'I will read it.',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'hello' },
      { role: 'assistant', content: 'The file says hello.' },
    ]);
    expect(result.extensions?.justdo.messages).toEqual(rawMessages);
    expect(result.extensions?.justdo.runtime_session_id).toBe('runtime-1');
  });

  test('omits raw runtime history when the option is disabled', () => {
    const result = createSessionExportDocument({
      session,
      messages: [{ role: 'user', content: 'Hello' }],
      includeRawData: false,
    });

    expect(result.extensions).toBeUndefined();
  });

  test('extracts an inline tool result as a separate tool message', () => {
    const result = createSessionExportDocument({
      session,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'toolcall', toolCallId: 'call-1', name: 'exec', arguments: { command: 'pwd' } },
            { type: 'toolresult', toolCallId: 'call-1', name: 'exec', text: 'C:\\workspace' },
          ],
        },
      ],
      includeRawData: false,
    });

    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'exec', arguments: '{"command":"pwd"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'C:\\workspace' },
    ]);
  });

  test('keeps attached tool results without duplicating the assistant tool call', () => {
    const result = createSessionExportDocument({
      session,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'exec', arguments: {} }],
          __justdoAttachedToolMessages: [
            {
              role: 'assistant',
              content: [
                { type: 'toolcall', toolCallId: 'call-1', name: 'exec', arguments: {} },
                { type: 'toolresult', toolCallId: 'call-1', name: 'exec', text: 'done' },
              ],
            },
          ],
        },
      ],
      includeRawData: false,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'done',
    });
  });

  test('uses complete partial arguments when the normalized tool arguments are empty', () => {
    const result = createSessionExportDocument({
      session,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'exec',
              arguments: {},
              partialArgs: '{"command":"Get-Location"}',
            },
          ],
        },
      ],
      includeRawData: false,
    });

    expect(result.messages[0].tool_calls?.[0].function.arguments).toBe(
      '{"command":"Get-Location"}',
    );
  });

  test('renames internal runtime metadata in included raw messages', () => {
    const result = createSessionExportDocument({
      session,
      messages: [
        {
          role: 'assistant',
          content: 'Done',
          __openclaw: { kind: 'compaction', nested: { __openclaw: true } },
          __openclawStreamFallback: true,
        },
      ],
      includeRawData: true,
    });

    expect(result.extensions?.justdo.messages).toEqual([
      {
        role: 'assistant',
        content: 'Done',
        __justdo_runtime: { kind: 'compaction', nested: { __justdo_runtime: true } },
        __justdoStreamFallback: true,
      },
    ]);
    expect(JSON.stringify(result.extensions)).not.toMatch(/openclaw/i);
  });
});

test('buildSessionExportFileName removes invalid file-name characters', () => {
  expect(buildSessionExportFileName(' Roadmap: Q3 / Q4? ')).toBe('Roadmap Q3 Q4.json');
});
