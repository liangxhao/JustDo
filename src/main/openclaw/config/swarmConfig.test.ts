import { describe, expect, test } from 'vitest';

import { createDefaultAgentRuntimeSettings } from '../../../shared/openclaw/agentRuntimeSettings';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import {
  buildAuthScopedOpenClawConfig,
  mergeManagedOpenClawSwarmConfig,
} from './openclawConfigBuilders';

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

  test.each([BuiltinModelSyncReason.AuthLogin, BuiltinModelSyncReason.AuthLogout])(
    'refreshes managed Swarm values on %s while preserving per-agent overrides',
    reason => {
      const swarm = createDefaultAgentRuntimeSettings().swarm;
      const override = { swarm: { enabled: false, maxConcurrent: 2 } };
      const result = buildAuthScopedOpenClawConfig(
        {
          agents: { entries: { main: {}, researcher: { tools: override } } },
          tools: { swarm: { maxConcurrent: 1, futureOption: true }, custom: true },
        },
        { tools: { swarm } },
        reason,
      );
      expect(result.tools).toMatchObject({ swarm: { ...swarm, futureOption: true }, custom: true });
      expect(result.agents).toMatchObject({ entries: { researcher: { tools: override } } });
    },
  );
});
