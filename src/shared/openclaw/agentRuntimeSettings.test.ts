import { describe, expect, test } from 'vitest';

import {
  AgentRuntimeDelegationMode,
  createDefaultAgentRuntimeSettings,
  parseAgentRuntimeSettings,
  validateAgentRuntimeSettings,
} from './agentRuntimeSettings';

describe('Agent runtime settings', () => {
  test('keeps the JustDo managed defaults stable', () => {
    expect(createDefaultAgentRuntimeSettings()).toEqual({
      version: 1,
      subagents: {
        delegationMode: 'suggest',
        model: null,
        thinking: null,
        maxConcurrent: 3,
        maxChildrenPerAgent: 5,
        runTimeoutSeconds: 7200,
        maxSpawnDepth: 1,
      },
    });
  });

  test('normalizes model whitespace and accepts bounded advanced settings', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents = {
      ...input.subagents,
      delegationMode: AgentRuntimeDelegationMode.Prefer,
      model: '  provider/model  ',
      thinking: 'high',
      maxConcurrent: 16,
      maxChildrenPerAgent: 20,
      runTimeoutSeconds: 0,
      maxSpawnDepth: 2,
    };

    expect(validateAgentRuntimeSettings(input)).toEqual({
      ok: true,
      settings: {
        ...input,
        subagents: { ...input.subagents, model: 'provider/model' },
      },
    });
  });

  test.each([
    ['concurrency', { maxConcurrent: 0 }],
    ['children', { maxChildrenPerAgent: 21 }],
    ['nesting', { maxSpawnDepth: 3 }],
    ['timeout', { runTimeoutSeconds: 59 }],
    ['thinking', { thinking: 'unbounded' }],
  ])('rejects invalid %s values', (_name, update) => {
    const input = createDefaultAgentRuntimeSettings();
    Object.assign(input.subagents, update);

    expect(validateAgentRuntimeSettings(input).ok).toBe(false);
  });

  test('falls back as a unit when persisted data is corrupt', () => {
    expect(parseAgentRuntimeSettings({ version: 1, subagents: { maxConcurrent: 999 } })).toEqual(
      createDefaultAgentRuntimeSettings(),
    );
  });
});
