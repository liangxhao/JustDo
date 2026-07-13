import { expect, test } from 'vitest';

import { collectToolInputsFromValue, fetchPagedHistoryFromGateway } from './history';

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

test('fetches paged gateway history in chronological order', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const body = url.includes('cursor=2')
      ? { messages: [{ role: 'user', content: 'older' }], hasMore: false }
      : {
          messages: [{ role: 'assistant', content: 'recent' }],
          hasMore: true,
          nextCursor: '2',
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const messages = await fetchPagedHistoryFromGateway({
    sessionKey: 'agent:main:justdo:session-1',
    port: 42871,
    token: 'token-1',
    fetchImpl: fetchImpl as typeof fetch,
  });

  expect(calls).toEqual([
    'http://127.0.0.1:42871/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=1000',
    'http://127.0.0.1:42871/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=1000&cursor=2',
  ]);
  expect(messages).toEqual([
    { role: 'user', content: 'older' },
    { role: 'assistant', content: 'recent' },
  ]);
});
