import { describe, expect, test } from 'vitest';

import {
  createDefaultExternalAgentSettings,
  parseExternalAgentSettings,
  validateExternalAgentSettings,
} from './externalAgents';

describe('external agent settings', () => {
  test('defaults every build-time registered agent to its safe setting', () => {
    expect(createDefaultExternalAgentSettings()).toEqual({
      version: 1,
      permissionMode: 'read-only',
      readOnlyViolationBehavior: 'continue',
      operationTimeoutSeconds: 120,
      pluginToolsMcpBridge: false,
      openClawToolsMcpBridge: false,
      shareConfiguredMcpServers: false,
      agents: {
        claude: { enabled: false },
        codex: { enabled: false },
        opencode: { enabled: false },
        'deepseek-harness': { enabled: false },
        hermes: { enabled: false },
      },
    });
  });

  test('normalizes known entries and discards stale catalog ids', () => {
    expect(
      validateExternalAgentSettings({
        version: 1,
        permissionMode: 'full-access',
        readOnlyViolationBehavior: 'continue',
        operationTimeoutSeconds: 120,
        pluginToolsMcpBridge: false,
        openClawToolsMcpBridge: false,
        shareConfiguredMcpServers: false,
        agents: {
          claude: { enabled: true },
          retired: { enabled: true },
        },
      }),
    ).toEqual({
      ok: true,
      settings: {
        version: 1,
        permissionMode: 'full-access',
        readOnlyViolationBehavior: 'continue',
        operationTimeoutSeconds: 120,
        pluginToolsMcpBridge: false,
        openClawToolsMcpBridge: false,
        shareConfiguredMcpServers: false,
        agents: {
          claude: { enabled: true },
          codex: { enabled: false },
          opencode: { enabled: false },
          'deepseek-harness': { enabled: false },
          hermes: { enabled: false },
        },
      },
    });
  });

  test('rejects malformed settings for a registered agent', () => {
    const input = createDefaultExternalAgentSettings();
    (input.agents.claude as { enabled: unknown }).enabled = 'yes';
    expect(validateExternalAgentSettings(input).ok).toBe(false);
  });

  test('accepts all ACPX permission modes and supported operation timeouts', () => {
    for (const permissionMode of ['deny-all', 'read-only', 'full-access'] as const) {
      const input = {
        ...createDefaultExternalAgentSettings(),
        permissionMode,
        readOnlyViolationBehavior: 'fail-task' as const,
        operationTimeoutSeconds: 300 as const,
      };
      expect(validateExternalAgentSettings(input)).toEqual({ ok: true, settings: input });
    }
  });

  test('fills new safe defaults when loading an earlier version 1 payload', () => {
    const defaults = createDefaultExternalAgentSettings();
    const {
      readOnlyViolationBehavior: _behavior,
      operationTimeoutSeconds: _timeout,
      pluginToolsMcpBridge: _pluginTools,
      openClawToolsMcpBridge: _openClawTools,
      shareConfiguredMcpServers: _configuredMcp,
      ...legacy
    } = defaults;

    expect(parseExternalAgentSettings(legacy)).toEqual(defaults);
  });

  test('rejects malformed MCP bridge flags', () => {
    expect(
      validateExternalAgentSettings({
        ...createDefaultExternalAgentSettings(),
        pluginToolsMcpBridge: 'yes',
      }).ok,
    ).toBe(false);
  });

  test('falls back atomically when persisted settings are malformed', () => {
    expect(parseExternalAgentSettings({ version: 1, agents: {} })).toEqual(
      createDefaultExternalAgentSettings(),
    );
  });
});
