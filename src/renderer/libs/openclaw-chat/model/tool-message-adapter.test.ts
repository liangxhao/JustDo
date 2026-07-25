import { describe, expect, test } from 'vitest';

import {
  readToolCallId,
  readToolError,
  readToolInput,
  readToolName,
  readToolOutput,
  unwrapToolMessage,
} from './tool-message-adapter';

describe('tool message adapter', () => {
  test('ports legacy Tool id and metadata aliases', () => {
    expect(readToolCallId({ toolUseId: 'camel' })).toBe('camel');
    expect(readToolCallId({ tool_use_id: 'snake' })).toBe('snake');
    expect(readToolCallId({ callId: 'call' })).toBe('call');
    expect(readToolCallId({ metadata: { toolUseId: 'metadata' } })).toBe('metadata');
    expect(readToolName({ metadata: { toolName: 'Read' } })).toBe('Read');
  });

  test('prefers complete partialArgs over empty normalized arguments', () => {
    expect(
      readToolInput({
        arguments: {},
        partialArgs: '{"command":"Get-Location","timeout":5}',
      }),
    ).toEqual({ command: 'Get-Location', timeout: 5 });
  });

  test('extracts text blocks and serializes object Tool results', () => {
    expect(
      readToolOutput({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\nsecond');
    expect(readToolOutput({ result: { ok: true } })).toBe('{\n  "ok": true\n}');
  });

  test('ports structured error detection without matching benign prose', () => {
    expect(readToolError({}, '{"error":"permission denied"}').failed).toBe(true);
    expect(readToolError({}, 'Completed with 0 errors').failed).toBe(false);
    expect(readToolError({ status: 'timeout' }, '').failed).toBe(true);
  });

  test('unwraps OpenClaw history envelopes', () => {
    expect(
      unwrapToolMessage({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall' }] },
      }),
    ).toMatchObject({ role: 'assistant' });
  });
});
