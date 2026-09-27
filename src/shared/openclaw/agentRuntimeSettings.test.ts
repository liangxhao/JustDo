import { describe, expect, test } from 'vitest';

import {
  AgentRuntimeDelegationMode,
  AgentRuntimeSessionVisibility,
  createDefaultAgentRuntimeSettings,
  parseAgentRuntimeSettings,
  validateAgentRuntimeSettings,
} from './agentRuntimeSettings';

describe('Agent runtime settings', () => {
  test('keeps the JustDo managed defaults stable', () => {
    expect(createDefaultAgentRuntimeSettings()).toEqual({
      version: 1,
      swarm: { enabled: true, maxConcurrent: 8, maxChildrenPerGroup: 50, maxTotalPerGroup: 200 },
      agent: {
        thinking: null,
        runTimeoutSeconds: 0,
        maxConcurrent: null,
      },
      askUserQuestion: {
        timeoutMinutes: 10,
      },
      automation: {
        approvalTimeoutMinutes: 2,
      },
      mcp: {
        requestTimeoutSeconds: 60,
      },
      sessions: {
        visibility: 'tree',
      },
      subagents: {
        delegationMode: null,
        model: null,
        thinking: null,
        maxConcurrent: 3,
        maxChildrenPerAgent: 5,
        runTimeoutSeconds: 7200,
        maxSpawnDepth: 1,
        archiveAfterMinutes: 0,
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
      maxSpawnDepth: 5,
      archiveAfterMinutes: 10_080,
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
    ['nesting', { maxSpawnDepth: 6 }],
    ['timeout', { runTimeoutSeconds: 59 }],
    ['thinking', { thinking: 'unbounded' }],
  ])('rejects invalid %s values', (_name, update) => {
    const input = createDefaultAgentRuntimeSettings();
    Object.assign(input.subagents, update);

    expect(validateAgentRuntimeSettings(input).ok).toBe(false);
  });

  test('migrates version 1 settings saved before main Agent thinking preferences', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { agent: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      agent: { thinking: null, runTimeoutSeconds: 0, maxConcurrent: null },
    });
  });

  test('migrates version 1 settings saved before the latest runtime controls', () => {
    const input = createDefaultAgentRuntimeSettings();
    const legacyInput = {
      ...input,
      agent: { thinking: input.agent.thinking },
      subagents: {
        ...input.subagents,
        delegationMode: undefined,
        archiveAfterMinutes: undefined,
      },
    };

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual(input);
  });

  test('migrates version 1 settings saved before MCP preferences', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { mcp: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      mcp: { requestTimeoutSeconds: 60 },
    });
  });

  test('migrates version 1 settings saved before session visibility preferences', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { sessions: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      sessions: { visibility: AgentRuntimeSessionVisibility.Tree },
    });
  });

  test('preserves AskUserQuestion timeout preferences', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.askUserQuestion.timeoutMinutes = 45;

    expect(parseAgentRuntimeSettings(input)).toEqual(input);
  });

  test('restores the AskUserQuestion default for profiles saved while the field was absent', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { askUserQuestion: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      askUserQuestion: { timeoutMinutes: 10 },
    });
  });

  test('drops the removed approval timeout from persisted version 1 profiles', () => {
    const input = createDefaultAgentRuntimeSettings();
    const legacyInput = {
      ...input,
      approvals: { timeoutMinutes: 0 },
    };

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual(input);
  });

  test('adds the scheduled task approval timeout to older version 1 profiles', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { automation: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      automation: { approvalTimeoutMinutes: 2 },
    });
  });

  test.each([2, 5, 10])(
    'accepts scheduled task approval timeout %s minutes',
    approvalTimeoutMinutes => {
      const input = createDefaultAgentRuntimeSettings();
      input.automation.approvalTimeoutMinutes = approvalTimeoutMinutes as 2 | 5 | 10;

      expect(validateAgentRuntimeSettings(input)).toEqual({ ok: true, settings: input });
    },
  );

  test.each([0, 1, 3, 11])(
    'rejects unsupported scheduled task approval timeout %s',
    approvalTimeoutMinutes => {
      const input = createDefaultAgentRuntimeSettings();
      input.automation.approvalTimeoutMinutes = approvalTimeoutMinutes as 2;

      expect(validateAgentRuntimeSettings(input).ok).toBe(false);
    },
  );

  test.each(Object.values(AgentRuntimeSessionVisibility))(
    'accepts session visibility %s',
    visibility => {
      const input = createDefaultAgentRuntimeSettings();
      input.sessions.visibility = visibility;

      expect(validateAgentRuntimeSettings(input)).toEqual({ ok: true, settings: input });
    },
  );

  test('rejects an unsupported session visibility', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.sessions.visibility = 'siblings' as never;

    expect(validateAgentRuntimeSettings(input).ok).toBe(false);
  });

  test('accepts and validates the main Agent thinking preference', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.agent.thinking = 'high';

    expect(validateAgentRuntimeSettings(input)).toEqual({ ok: true, settings: input });

    const invalid = createDefaultAgentRuntimeSettings();
    invalid.agent.thinking = 'unbounded' as never;
    expect(validateAgentRuntimeSettings(invalid).ok).toBe(false);
  });

  test.each([
    ['timeout', { runTimeoutSeconds: 59 }],
    ['timeout ceiling', { runTimeoutSeconds: 86_401 }],
    ['concurrency', { maxConcurrent: 0 }],
    ['concurrency ceiling', { maxConcurrent: 17 }],
  ])('rejects invalid main Agent %s', (_name, update) => {
    const input = createDefaultAgentRuntimeSettings();
    Object.assign(input.agent, update);

    expect(validateAgentRuntimeSettings(input).ok).toBe(false);
  });

  test.each([-1, 525_601, 1.5])('rejects invalid archive delay %s', archiveAfterMinutes => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.archiveAfterMinutes = archiveAfterMinutes;

    expect(validateAgentRuntimeSettings(input).ok).toBe(false);
  });

  test.each([0, 86_401, 1.5])('rejects invalid MCP request timeout %s', timeoutSeconds => {
    const input = createDefaultAgentRuntimeSettings();
    input.mcp.requestTimeoutSeconds = timeoutSeconds;

    expect(validateAgentRuntimeSettings(input).ok).toBe(false);
  });

  test('falls back as a unit when persisted data is corrupt', () => {
    expect(parseAgentRuntimeSettings({ version: 1, subagents: { maxConcurrent: 999 } })).toEqual(
      createDefaultAgentRuntimeSettings(),
    );
  });
});

test('fills missing Swarm settings for existing profiles and rejects invalid capacities', () => {
  const settings = createDefaultAgentRuntimeSettings();
  const { swarm, ...legacy } = settings;
  expect(parseAgentRuntimeSettings(legacy).swarm).toEqual(swarm);
  for (const value of [0, -1, 1.5, 65]) {
    expect(
      validateAgentRuntimeSettings({ ...settings, swarm: { ...swarm, maxConcurrent: value } }).ok,
    ).toBe(false);
  }
  settings.swarm.enabled = false;
  settings.swarm.maxConcurrent = 12;
  expect(parseAgentRuntimeSettings(settings).swarm).toEqual(settings.swarm);
  expect(parseAgentRuntimeSettings(settings).subagents.maxConcurrent).toBe(3);
});
