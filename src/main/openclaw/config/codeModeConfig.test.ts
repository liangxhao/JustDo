import { describe, expect, test } from 'vitest';

import { createDefaultAgentRuntimeSettings } from '../../../shared/agents/agentRuntimeSettings';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import {
  buildAuthScopedOpenClawConfig,
  mergeManagedOpenClawCodeModeConfig,
} from './openclawConfigBuilders';

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

  test.each([BuiltinModelSyncReason.AuthLogin, BuiltinModelSyncReason.AuthLogout])(
    'retains model and agent overrides on %s',
    reason => {
      const codeMode = mergeManagedOpenClawCodeModeConfig(undefined);
      const agents = {
        defaults: { models: { 'custom/model': { codeMode: false } } },
        entries: { main: {}, researcher: { tools: { codeMode: { enabled: false } } } },
      };
      const result = buildAuthScopedOpenClawConfig(
        { agents, tools: { codeMode: { executor: 'node', timeoutMs: 20000 }, custom: true } },
        { tools: { codeMode } },
        reason,
      );
      expect(result.tools).toMatchObject({
        codeMode: { ...codeMode, timeoutMs: 20000 },
        custom: true,
      });
      expect(result.agents).toMatchObject(agents);
    },
  );
});
