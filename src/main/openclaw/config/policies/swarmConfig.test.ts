import { describe, expect, test } from 'vitest';

import { createDefaultAgentRuntimeSettings } from '../../../../shared/agents/agentRuntimeSettings';
import { buildLoginScopedOpenClawConfig } from '../models/authScopedProjection';
import { mergeManagedOpenClawSwarmConfig } from './executionPolicyProjection';

describe('managed Swarm capacity', () => {
  test('overwrites managed capacity without mutating or losing unknown settings', () => {
    const settings = createDefaultAgentRuntimeSettings();
    settings.swarm.enabled = false;
    settings.swarm.maxConcurrent = 12;
    const existing = { maxConcurrent: 2, futureOption: { enabled: true } };
    expect(mergeManagedOpenClawSwarmConfig(existing, settings)).toEqual({
      ...settings.swarm,
      futureOption: { enabled: true },
    });
    expect(existing.maxConcurrent).toBe(2);
  });

  test('refreshes managed Swarm values on login while preserving per-agent overrides', () => {
    const swarm = createDefaultAgentRuntimeSettings().swarm;
    const override = { swarm: { enabled: false, maxConcurrent: 2 } };
    const result = buildLoginScopedOpenClawConfig(
      {
        agents: { entries: { main: {}, researcher: { tools: override } } },
        tools: { swarm: { maxConcurrent: 1, futureOption: true }, custom: true },
      },
      { tools: { swarm } },
    );
    expect(result.tools).toMatchObject({ swarm: { ...swarm, futureOption: true }, custom: true });
    expect(result.agents).toMatchObject({ entries: { researcher: { tools: override } } });
  });
});
