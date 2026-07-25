import { describe, expect, test } from 'vitest';

import { projectPersistedTimeline } from './project-history-timeline';

describe('projectPersistedTimeline', () => {
  test('flattens mixed persisted assistant content around hard Content boundaries', () => {
    const result = projectPersistedTimeline([
      { role: 'user', content: 'go', id: 'user-1' },
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolcall', toolCallId: 'call-1', name: 'read' },
          { type: 'toolresult', toolCallId: 'call-1', text: 'ok' },
          { type: 'text', text: 'first content' },
          { type: 'thinking', thinking: 'more' },
          { type: 'text', text: 'second content' },
        ],
      },
    ]);

    expect(result.map(item => item.kind)).toEqual([
      'history-message',
      'process-summary',
      'history-message',
      'process-summary',
      'history-message',
    ]);
    expect(result[1]).toMatchObject({ thinkingCount: 1, toolCount: 1 });
  });

  test('uses deterministic keys for cold history', () => {
    const messages = [{ role: 'assistant', content: 'answer', id: 'message-1' }];
    expect(projectPersistedTimeline(messages)[0].key).toBe(
      projectPersistedTimeline(messages)[0].key,
    );
  });

  test('keeps a failed persisted Tool visible and records it in the summary', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          { type: 'toolcall', toolCallId: 'call-1', name: 'run_tests' },
          {
            type: 'toolresult',
            toolCallId: 'call-1',
            isError: true,
            text: 'Process exited with code 1',
          },
        ],
      },
    ]);

    expect(result.map(item => item.kind)).toEqual(['process-summary', 'tool']);
    expect(result[0]).toMatchObject({ toolCount: 1, errorCount: 1 });
    expect(result[1]).toMatchObject({
      kind: 'tool',
      item: { status: 'failed', output: 'Process exited with code 1' },
    });
  });

  test('keeps result-before-start and object Tool output inspectable', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          {
            type: 'toolresult',
            toolCallId: 'call-1',
            name: 'inspect',
            output: { ok: true, count: 2 },
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      toolCount: 1,
      items: [
        {
          name: 'inspect',
          output: '{\n  "ok": true,\n  "count": 2\n}',
          status: 'completed',
        },
      ],
    });
  });

  test('joins an OpenClaw toolResult message with array content to its Tool call', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'exec',
            arguments: { command: 'npm test' },
          },
        ],
      },
      {
        role: 'toolResult',
        id: 'result-1',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: '761 tests passed' }],
        isError: false,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      toolCount: 1,
      items: [
        {
          toolCallId: 'call-1',
          name: 'exec',
          input: { command: 'npm test' },
          output: '761 tests passed',
          status: 'completed',
        },
      ],
    });
  });

  test('keeps an array-content OpenClaw Tool failure visible with updated summary state', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'exec', arguments: {} }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: 'Process exited with code 1' }],
        isError: true,
      },
    ]);

    expect(result.map(item => item.kind)).toEqual(['process-summary', 'tool']);
    expect(result[0]).toMatchObject({
      errorCount: 1,
      items: [{ status: 'failed', output: 'Process exited with code 1' }],
    });
    expect(result[1]).toMatchObject({
      kind: 'tool',
      item: { status: 'failed', output: 'Process exited with code 1' },
    });
  });

  test('hydrates an enveloped Tool call with partialArgs before a standalone result', () => {
    const result = projectPersistedTimeline([
      {
        type: 'message',
        id: 'assistant-envelope',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'cleaning up' },
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'exec',
              arguments: {},
              partialArgs: '{"command":"Remove-Item tmp.js","timeout":5}',
            },
          ],
        },
      } as unknown as never,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'nearby text' }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: '(no output)' }],
      },
    ]);

    const summary = result.find(item => item.kind === 'process-summary');
    expect(summary).toMatchObject({
      items: [
        {
          toolCallId: 'call-1',
          input: { command: 'Remove-Item tmp.js', timeout: 5 },
          output: '(no output)',
        },
      ],
    });
  });

  test('hydrates standalone tool_use metadata and its result', () => {
    const result = projectPersistedTimeline([
      {
        role: 'tool_use',
        toolCallId: 'call-1',
        metadata: {
          toolUseId: 'call-1',
          toolName: 'Read',
          toolInput: { file_path: 'README.md' },
        },
        content: 'Read',
      },
      {
        role: 'tool_result',
        tool_call_id: 'call-1',
        metadata: { toolUseId: 'call-1', toolName: 'Read' },
        content: 'ok',
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      items: [
        {
          name: 'Read',
          input: { file_path: 'README.md' },
          output: 'ok',
        },
      ],
    });
  });

  test('merges attached Tool call and empty result compatibility messages', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'working' }],
        __justdoAttachedToolMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolcall',
                toolCallId: 'call-1',
                name: 'exec',
                arguments: { command: 'npm test' },
              },
              {
                type: 'toolresult',
                toolCallId: 'call-1',
                name: 'exec',
                text: '',
              },
            ],
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      thinkingCount: 1,
      toolCount: 1,
      items: [
        { type: 'thinking' },
        {
          type: 'tool',
          input: { command: 'npm test' },
          output: '',
          status: 'completed',
        },
      ],
    });
  });

  test('matches a result without an id to the first unmatched Tool with the same name', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
          {
            type: 'toolResult',
            name: 'Read',
            text: 'contents',
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      toolCount: 1,
      items: [
        {
          toolCallId: 'call-1',
          input: { file_path: 'README.md' },
          output: 'contents',
        },
      ],
    });
  });
});
