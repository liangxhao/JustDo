import { expect, test } from 'vitest';

import type { ToolItem } from './chat-transcript-state';
import { spawnedAgentSessionKey } from './spawn-tool-target';

const tool = (overrides: Partial<ToolItem> = {}): ToolItem => ({
  type: 'tool',
  id: 't',
  toolCallId: 't',
  runId: 'r',
  firstSeq: 1,
  lastSeq: 2,
  startedAt: 1,
  updatedAt: 2,
  name: 'sessions_spawn',
  status: 'completed',
  output: '{"status":"accepted","childSessionKey":"agent:main:subagent:child"}',
  ...overrides,
});

test('opens only the child key returned by an accepted spawn', () => {
  expect(spawnedAgentSessionKey(tool())).toBe('agent:main:subagent:child');
  expect(
    spawnedAgentSessionKey(tool({ input: { agentId: 'other' }, output: '{"status":"accepted"}' })),
  ).toBeNull();
});

test('supports the core tool wrapper without matching third party names', () => {
  expect(
    spawnedAgentSessionKey(
      tool({ name: 'tool_call', input: { id: 'openclaw:core:sessions_spawn' } }),
    ),
  ).toBe('agent:main:subagent:child');
  expect(
    spawnedAgentSessionKey(tool({ name: 'tool_call', input: { id: 'third:sessions_spawn' } })),
  ).toBeNull();
});

test('does not link waiting, failed, partial or invalid results', () => {
  for (const overrides of [
    { name: 'sessions_yield' },
    { status: 'running' as const },
    { error: 'failed' },
    { presentation: { partial: true } },
    { output: 'Skipped' },
    { output: '{"status":"error","childSessionKey":"child"}' },
    { output: '{"status":"accepted","childSessionKey":" "}' },
    { output: 'x'.repeat(120001) },
  ])
    expect(spawnedAgentSessionKey(tool(overrides))).toBeNull();
});
