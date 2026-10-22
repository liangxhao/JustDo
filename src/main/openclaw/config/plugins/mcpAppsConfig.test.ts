import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_RUNTIME_SETTINGS } from '../../../../shared/agents/agentRuntimeSettings';
import { buildManagedMcpConfig } from './mcpAppsConfig';

describe('managed MCP Apps configuration', () => {
  it('preserves unrelated native options', () => {
    const native = {
      sessionIdleTtlMs: 123,
      apps: { enabled: true, sandboxPort: 4567, sandboxOrigin: 'https://apps.internal' },
      servers: { old: {} },
    };
    expect(buildManagedMcpConfig(native, { current: {} }, DEFAULT_AGENT_RUNTIME_SETTINGS.mcp))
      .toEqual({ ...native, servers: { current: {} } });
    expect(native.servers).toEqual({ old: {} });
  });

  it('defaults to enabled and projects explicit choices while preserving sandbox settings', () => {
    expect(buildManagedMcpConfig(undefined, {}, DEFAULT_AGENT_RUNTIME_SETTINGS.mcp))
      .toEqual({ servers: {}, apps: { enabled: true } });
    expect(buildManagedMcpConfig({ apps: { enabled: false } }, {}, DEFAULT_AGENT_RUNTIME_SETTINGS.mcp))
      .toEqual({ servers: {}, apps: { enabled: true } });
    expect(buildManagedMcpConfig({ apps: { enabled: true, sandboxPort: 4567 } }, {}, {
      ...DEFAULT_AGENT_RUNTIME_SETTINGS.mcp, appsEnabled: false,
    })).toEqual({ servers: {}, apps: { enabled: false, sandboxPort: 4567 } });
  });
});
