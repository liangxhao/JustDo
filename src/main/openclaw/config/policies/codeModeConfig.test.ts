import { describe, expect, test } from 'vitest';

import { createDefaultAgentRuntimeSettings } from '../../../../shared/agents/agentRuntimeSettings';
import {
  buildLoginScopedOpenClawConfig,
  mergeManagedOpenClawCodeModeConfig,
} from '../openclawConfigBuilders';

describe('managed Code Mode configuration', () => {
  test.each([
    ['off', false],
    ['auto', 'auto'],
    ['on', true],
  ] as const)(
    'projects %s with the isolated executor and preserves native limits',
    (mode, enabled) => {
      const settings = createDefaultAgentRuntimeSettings();
      settings.codeMode.mode = mode;
      const existing = { enabled: true, executor: 'node', maxPendingToolCalls: 4 };
      expect(mergeManagedOpenClawCodeModeConfig(existing, settings)).toEqual({
        enabled,
        executor: 'quickjs',
        maxPendingToolCalls: 4,
      });
      expect(existing.executor).toBe('node');
    },
  );

  test('retains model and agent overrides on login', () => {
    const codeMode = mergeManagedOpenClawCodeModeConfig(undefined);
    const agents = {
      defaults: { models: { 'custom/model': { codeMode: false } } },
      entries: { main: {}, researcher: { tools: { codeMode: { enabled: false } } } },
    };
    const result = buildLoginScopedOpenClawConfig(
      { agents, tools: { codeMode: { executor: 'node', timeoutMs: 20000 }, custom: true } },
      { tools: { codeMode } },
    );
    expect(result.tools).toMatchObject({
      codeMode: { ...codeMode, timeoutMs: 20000 },
      custom: true,
    });
    expect(result.agents).toMatchObject(agents);
  });
});
