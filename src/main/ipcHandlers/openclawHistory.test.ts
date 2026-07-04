import { expect, test } from 'vitest';

import { collectToolInputsFromValue } from './openclawHistory';

test('collects and parses nested OpenClaw tool inputs', () => {
  const found: Record<string, { name?: string; input: unknown }> = {};

  collectToolInputsFromValue(
    {
      message: {
        content: [
          {
            type: 'tool_call',
            toolCallId: 'call-1',
            name: 'shell',
            arguments: '{"command":"pwd"}',
          },
        ],
      },
    },
    new Set(['call-1']),
    found,
  );

  expect(found).toEqual({
    'call-1': {
      name: 'shell',
      input: { command: 'pwd' },
    },
  });
});

test('ignores unrelated and empty tool inputs', () => {
  const found: Record<string, { name?: string; input: unknown }> = {};

  collectToolInputsFromValue(
    {
      messages: [
        { type: 'tool_call', id: 'other', input: { value: true } },
        { type: 'tool_call', id: 'call-2', input: '{}' },
      ],
    },
    new Set(['call-2']),
    found,
  );

  expect(found).toEqual({});
});
