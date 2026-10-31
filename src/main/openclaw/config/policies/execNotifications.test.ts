import { describe, expect, test } from 'vitest';

import { BuiltinModelSyncReason } from '../../../../shared/providers/builtinModels';
import { buildAuthScopedOpenClawConfig } from '../models/authScopedProjection';
import {
  buildManagedOpenClawExecutionToolConfig,
  projectManagedOpenClawExecNotifications,
} from './executionPolicyProjection';

const configuration = () => ({
  tools: { exec: { notifyOnExit: true, backgroundMs: 900, timeoutSec: 37 }, deny: ['write'] },
  agents: { entries: {
    main: { tools: { exec: { notifyOnExit: true, host: 'gateway', timeoutSec: 41 }, deny: ['read'] } },
    researcher: { tools: { exec: { backgroundMs: 50 } } },
    external: {
      runtime: { type: 'acp', acp: { agent: 'external' } },
      tools: { exec: { notifyOnExit: true, timeoutSec: 51, host: 'node' } },
    },
  } },
  service: { notifyOnExit: true },
});

describe('managed exec completion notification policy', () => {
  test('disables global and per-agent wake-ups without mutating limits or unrelated policy', () => {
    const existing = configuration();
    const snapshot = structuredClone(existing);
    expect(projectManagedOpenClawExecNotifications(existing)).toEqual({
      ...existing,
      tools: { ...existing.tools, exec: { ...existing.tools.exec, notifyOnExit: false } },
      agents: { entries: {
        ...existing.agents.entries,
        main: { tools: { ...existing.agents.entries.main.tools,
          exec: { ...existing.agents.entries.main.tools.exec, notifyOnExit: false } } },
        researcher: { tools: { exec: { backgroundMs: 50, notifyOnExit: false } } },
      } },
    });
    expect(existing).toEqual(snapshot);
  });

  test('normalizes missing or invalid global exec configuration', () => {
    expect(projectManagedOpenClawExecNotifications({ tools: { exec: 'invalid' } }))
      .toEqual({ tools: { exec: { notifyOnExit: false } } });
    expect(buildManagedOpenClawExecutionToolConfig('local', configuration().tools).exec)
      .toMatchObject({ notifyOnExit: false, backgroundMs: 900, timeoutSec: 37 });
  });

  test.each([BuiltinModelSyncReason.AuthLogin, BuiltinModelSyncReason.AuthLogout])(
    'prevents existing per-agent overrides from restoring notifications on %s', reason => {
      const existing = configuration();
      const snapshot = structuredClone(existing);
      const result = buildAuthScopedOpenClawConfig(existing, {}, reason);
      expect(result.tools).toMatchObject({
        exec: { notifyOnExit: false, backgroundMs: 900, timeoutSec: 37 },
      });
      expect(result.agents).toMatchObject({ entries: {
        main: { tools: { exec: { notifyOnExit: false, timeoutSec: 41 } } },
        researcher: { tools: { exec: { notifyOnExit: false, backgroundMs: 50 } } },
        external: existing.agents.entries.external,
      } });
      expect(result.service).toEqual({ notifyOnExit: true });
      expect(existing).toEqual(snapshot);
    },
  );
});
