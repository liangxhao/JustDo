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
      agent: {
        thinking: null,
      },
      askUserQuestion: {
        timeoutMinutes: 10,
      },
      approvals: {
        timeoutMinutes: 30,
      },
      mcp: {
        requestTimeoutSeconds: 60,
      },
      sessions: {
        visibility: 'tree',
      },
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

  test('migrates version 1 settings saved before AskUserQuestion preferences', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { askUserQuestion: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      askUserQuestion: { timeoutMinutes: 10 },
    });
  });

  test('migrates version 1 settings saved before main Agent thinking preferences', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { agent: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      agent: { thinking: null },
    });
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

  test('migrates version 1 settings saved before approval wait preferences', () => {
    const input = createDefaultAgentRuntimeSettings();
    input.subagents.maxConcurrent = 7;
    const { approvals: _removed, ...legacyInput } = input;

    expect(parseAgentRuntimeSettings(legacyInput)).toEqual({
      ...input,
      approvals: { timeoutMinutes: 30 },
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

  test.each([0, 10, 20, 30, 60])('accepts approval wait timeout %s', timeoutMinutes => {
    const input = createDefaultAgentRuntimeSettings();
    input.approvals.timeoutMinutes = timeoutMinutes;

    expect(validateAgentRuntimeSettings(input)).toEqual({ ok: true, settings: input });
  });

  test.each([-1, 1, 15, 61, 1.5])('rejects unsupported approval wait timeout %s', timeoutMinutes => {
    const input = createDefaultAgentRuntimeSettings();
    input.approvals.timeoutMinutes = timeoutMinutes;

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

  test.each([0, 1441, 1.5])('rejects invalid AskUserQuestion timeout %s', timeoutMinutes => {
    const input = createDefaultAgentRuntimeSettings();
    input.askUserQuestion.timeoutMinutes = timeoutMinutes;

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
