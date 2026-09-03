import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { BrowserMode, type BrowserMode as BrowserModeValue } from '../../../shared/browser';
import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
import { createDefaultAgentRuntimeSettings } from '../../../shared/openclaw/agentRuntimeSettings';
import { setStoreGetter } from '../../cowork/providerApiConfig';
import {
  OpenClawConfigSync,
  type OpenClawConfigSyncResult,
  verifyLoggedOutOpenClawConfig,
} from './openclawConfigSync';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
}));

const temporaryDirectories: string[] = [];

afterEach(() => {
  setStoreGetter(() => null);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const writeExistingBuiltinConfig = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-auth-logout-config-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'openclaw.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { mode: 'local' },
      customFeature: {
        enabled: true,
        nested: { value: 'preserve-me' },
      },
      models: {
        pricing: {
          enabled: true,
        },
        providers: {
          builtin_models: {
            apiKey: '${JUSTDO_APIKEY_BUILTIN_MODELS}',
            baseUrl: 'http://127.0.0.1:4000/v1',
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: 'builtin_models/chat-model' },
          timeoutSeconds: 120,
          compaction: {
            mode: 'safeguard',
            keepRecentTokens: 20_000,
          },
        },
        list: [
          {
            id: 'main',
            default: true,
            model: { primary: 'builtin_models/chat-model' },
            reasoningDefault: 'stream',
          },
        ],
      },
      plugins: {
        entries: {
          custom_plugin: {
            enabled: true,
            config: { mode: 'keep-me' },
          },
        },
      },
      skills: {
        entries: {
          docx: { enabled: false },
        },
      },
    }),
    'utf8',
  );
  return configPath;
};

const writeExistingMixedProviderConfig = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-auth-mixed-config-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'openclaw.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { mode: 'local', customSetting: 'keep-me' },
      customFeature: { enabled: true },
      models: {
        mode: 'replace',
        pricing: { enabled: true },
        providers: {
          builtin_models: {
            apiKey: '${JUSTDO_APIKEY_BUILTIN_MODELS}',
            models: [{ id: 'builtin-model' }],
          },
          'custom-provider': {
            apiKey: '${JUSTDO_APIKEY_CUSTOM_1}',
            models: [{ id: 'custom-model' }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: 'custom-provider/custom-model' },
          timeoutSeconds: 120,
        },
        list: [
          {
            id: 'main',
            default: true,
            model: { primary: 'custom-provider/custom-model' },
          },
          {
            id: 'worker',
            model: { primary: 'builtin_models/builtin-model' },
          },
        ],
      },
    }),
    'utf8',
  );
  return configPath;
};

const writeMinimalConfig = (
  configPath: string,
  reason: string,
  permissionMode: 'ask' | 'auto' | 'full' = 'ask',
  browserMode: BrowserModeValue = BrowserMode.Isolated,
  agents: Array<{ id: string; enabled: boolean }> = [],
  runtimeSettings = createDefaultAgentRuntimeSettings(),
): OpenClawConfigSyncResult => {
  const sync = new OpenClawConfigSync({
    engineManager: {
      getDesiredVersion: () => '2026.6.11',
      getStateDir: () => path.dirname(configPath),
    },
    getCoworkConfig: () => ({
      workingDirectory: '',
      executionMode: 'local',
      agentEngine: 'openclaw',
      permissionMode,
    }),
    getBrowserMode: () => browserMode,
    getAgents: () => agents,
    getAgentRuntimeSettings: () => runtimeSettings,
  } as never);
  return (
    sync as unknown as {
      writeMinimalConfig: (path: string, syncReason: string) => OpenClawConfigSyncResult;
    }
  ).writeMinimalConfig(configPath, reason);
};

describe('OpenClaw auth logout config sync', () => {
  test('writes the managed safeguard compaction policy before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-compaction-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.compaction).toMatchObject({
      mode: 'safeguard',
      timeoutSeconds: 30 * 60,
      memoryFlush: {
        enabled: false,
      },
      midTurnPrecheck: {
        enabled: true,
      },
    });
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
  });

  test('writes the configured MCP request timeout before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-mcp-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const runtimeSettings = createDefaultAgentRuntimeSettings();
    runtimeSettings.mcp.requestTimeoutSeconds = 300;
    const sync = new OpenClawConfigSync({
      engineManager: {
        getDesiredVersion: () => '2026.6.11',
        getStateDir: () => directory,
      },
      getCoworkConfig: () => ({
        workingDirectory: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'ask',
      }),
      getAgentRuntimeSettings: () => runtimeSettings,
      getMcpServers: () => [
        {
          id: 'docs-id',
          name: 'docs',
          description: '',
          enabled: true,
          transportType: 'http',
          url: 'https://example.com/mcp',
          isBuiltIn: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as never);

    const result = (
      sync as unknown as {
        writeMinimalConfig: (path: string, reason: string) => OpenClawConfigSyncResult;
      }
    ).writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcp.servers.docs).toMatchObject({
      timeout: 300,
      url: 'https://example.com/mcp',
    });
  });

  test('updates and removes the main Agent thinking default in an existing minimal config', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-thinking-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const configured = createDefaultAgentRuntimeSettings();
    configured.agent.thinking = 'high';

    expect(
      writeMinimalConfig(
        configPath,
        BuiltinModelSyncReason.ManualRefresh,
        'ask',
        BrowserMode.Isolated,
        [],
        configured,
      ).ok,
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).agents.defaults.thinkingDefault).toBe(
      'high',
    );

    expect(writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).agents.defaults).not.toHaveProperty(
      'thinkingDefault',
    );
  });

  test('minimal config uses a restricted fallback before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-policy-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    const result = writeMinimalConfig(configPath, 'startup');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['action-approval']).toBeUndefined();
    expect(config.plugins.entries['file-permission-policy']).toBeUndefined();
    expect(config.tools.fs.mode).toBeUndefined();
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.tools.exec.mode).toBe('ask');
    expect(config.tools.sessions).toEqual({ visibility: 'tree' });
    expect(config.agents.defaults.systemAgent).toEqual({ agentId: 'main' });
    expect(config.session).toEqual({
      dmScope: 'per-account-channel-peer',
      reset: { mode: 'none' },
      maintenance: {
        mode: 'enforce',
        pruneAfter: '365d',
        maxEntries: 500,
      },
    });
  });

  test('writes the selected session visibility before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-session-visibility-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const runtimeSettings = createDefaultAgentRuntimeSettings();
    runtimeSettings.sessions.visibility = 'agent';

    const result = writeMinimalConfig(
      configPath,
      BuiltinModelSyncReason.ManualRefresh,
      'ask',
      BrowserMode.Isolated,
      [],
      runtimeSettings,
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).tools.sessions).toEqual({
      visibility: 'agent',
    });
  });

  test('updates the selected session visibility in an existing minimal config', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'justdo-minimal-session-visibility-update-'),
    );
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const runtimeSettings = createDefaultAgentRuntimeSettings();

    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).tools.sessions).toEqual({
      visibility: 'tree',
    });

    runtimeSettings.sessions.visibility = 'self';
    expect(
      writeMinimalConfig(
        configPath,
        BuiltinModelSyncReason.CoworkConfigChange,
        'ask',
        BrowserMode.Isolated,
        [],
        runtimeSettings,
      ).ok,
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).tools.sessions).toEqual({
      visibility: 'self',
    });
  });

  test('writes the AskUserQuestion timeout without callback transport and disables native ask_user', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-ask-user-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const runtimeSettings = createDefaultAgentRuntimeSettings();
    runtimeSettings.askUserQuestion.timeoutMinutes = 45;

    expect(
      writeMinimalConfig(
        configPath,
        BuiltinModelSyncReason.CoworkConfigChange,
        'ask',
        BrowserMode.Isolated,
        [],
        runtimeSettings,
      ).ok,
    ).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['ask-user-question']).toEqual({
      enabled: true,
      config: { timeoutMinutes: 45 },
    });
    expect(config.tools.deny).toContain('ask_user');
    expect(JSON.stringify(config.plugins.entries['ask-user-question'])).not.toContain('callback');
    expect(JSON.stringify(config.plugins.entries['ask-user-question'])).not.toContain('secret');
  });

  test('a second no-model sync restores AskUserQuestion and removes retired permission plugins', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-policy-switch-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const retiredInstalledDir = path.join(directory, 'extensions', 'ask-user-question');
    fs.mkdirSync(retiredInstalledDir, { recursive: true });
    fs.writeFileSync(
      path.join(retiredInstalledDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'ask-user-question' }),
      'utf8',
    );

    expect(writeMinimalConfig(configPath, 'startup', 'ask').ok).toBe(true);
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.plugins.enabled = false;
    existing.plugins.entries['file-permission-policy'] = { enabled: true };
    existing.plugins.entries['ask-user-question'] = { enabled: true };
    existing.plugins.allow = ['custom-plugin', 'ask-user-question', 'file-permission-policy'];
    existing.plugins.deny = ['action-approval', 'other-denied-plugin'];
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    const result = writeMinimalConfig(configPath, 'cowork-config-change', 'full');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tools.exec.mode).toBe('ask');
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.plugins.enabled).toBe(true);
    expect(config.plugins.allow).toEqual([
      'ask-user-question',
      'browser',
      'automation-permission',
      'justdo-runtime-bridge',
    ]);
    expect(config.plugins.deny).toBeUndefined();
    expect(config.plugins.entries['action-approval']).toBeUndefined();
    expect(config.plugins.entries['ask-user-question']).toEqual({
      enabled: true,
      config: { timeoutMinutes: 10 },
    });
    expect(config.plugins.entries['file-permission-policy']).toBeUndefined();
    expect(config.plugins.entries.browser).toEqual({ enabled: true });
  });

  test('preserves discoverable custom plugins while removing stale registrations', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-plugin-inventory-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const externalPluginDir = path.join(directory, 'external-plugin');
    const workspacePluginDir = path.join(
      directory,
      'workspace',
      '.openclaw',
      'extensions',
      'workspace-plugin',
    );
    const agentWorkspacePluginDir = path.join(
      directory,
      'workspace',
      'worker_one',
      '.openclaw',
      'extensions',
      'agent-workspace-plugin',
    );
    fs.mkdirSync(externalPluginDir);
    fs.mkdirSync(workspacePluginDir, { recursive: true });
    fs.mkdirSync(agentWorkspacePluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(externalPluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'external-plugin' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacePluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'workspace-plugin' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentWorkspacePluginDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'agent-workspace-plugin' }),
      'utf8',
    );

    const agents = [{ id: 'Worker_ONE', enabled: true }];
    expect(
      writeMinimalConfig(configPath, 'startup', 'ask', BrowserMode.Isolated, agents).ok,
    ).toBe(true);
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.plugins.load = { paths: [externalPluginDir] };
    existing.plugins.entries['external-plugin'] = { enabled: false };
    existing.plugins.entries['workspace-plugin'] = { enabled: true };
    existing.plugins.entries['agent-workspace-plugin'] = { enabled: true };
    existing.plugins.entries['removed-plugin'] = { enabled: true };
    existing.plugins.allow = [
      'external-plugin',
      'workspace-plugin',
      'agent-workspace-plugin',
      'removed-plugin',
    ];
    existing.plugins.deny = ['removed-plugin'];
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    expect(
      writeMinimalConfig(
        configPath,
        'cowork-config-change',
        'ask',
        BrowserMode.Isolated,
        agents,
      ).ok,
    ).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.load).toEqual({ paths: [externalPluginDir] });
    expect(config.plugins.entries['external-plugin']).toEqual({ enabled: false });
    expect(config.plugins.entries['workspace-plugin']).toEqual({ enabled: true });
    expect(config.plugins.entries['agent-workspace-plugin']).toEqual({ enabled: true });
    expect(config.plugins.entries['removed-plugin']).toBeUndefined();
    expect(config.plugins.allow).toEqual([
      'external-plugin',
      'workspace-plugin',
      'agent-workspace-plugin',
      'browser',
      'ask-user-question',
      'automation-permission',
      'justdo-runtime-bridge',
    ]);
    expect(config.plugins.deny).toBeUndefined();
  });

  test('skips cleanup when an installed extension candidate cannot be inventoried', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-plugin-fail-safe-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);
    const opaqueExtensionDir = path.join(directory, 'extensions', 'opaque-extension');
    fs.mkdirSync(opaqueExtensionDir, { recursive: true });
    fs.writeFileSync(path.join(opaqueExtensionDir, 'package.json'), '{}', 'utf8');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.plugins.entries['unverified-plugin'] = { enabled: false };
    existing.plugins.allow = ['unverified-plugin'];
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    expect(writeMinimalConfig(configPath, 'cowork-config-change').ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['unverified-plugin']).toEqual({ enabled: false });
    expect(config.plugins.allow).toContain('unverified-plugin');
  });

  test('skips cleanup for a compatible bundle used as a direct load path', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-compatible-plugin-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const bundleDir = path.join(directory, 'compatible-bundle');
    fs.mkdirSync(path.join(bundleDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'compatible-plugin' }),
      'utf8',
    );

    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.plugins.load = { paths: [bundleDir] };
    existing.plugins.entries['compatible-plugin'] = { enabled: true };
    existing.plugins.allow = ['compatible-plugin'];
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    expect(writeMinimalConfig(configPath, 'cowork-config-change').ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['compatible-plugin']).toEqual({ enabled: true });
    expect(config.plugins.allow).toContain('compatible-plugin');
  });

  test('a second no-model sync replaces the managed browser profile', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-browser-switch-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    expect(writeMinimalConfig(configPath, 'startup')).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).browser).toMatchObject({
      defaultProfile: 'openclaw',
    });

    const result = writeMinimalConfig(
      configPath,
      'browser-mode-change',
      'ask',
      BrowserMode.User,
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).browser).toMatchObject({
      defaultProfile: 'user',
      profiles: {
        user: {
          driver: 'existing-session',
          attachOnly: true,
        },
      },
    });
  });

  test('a second no-model sync removes the retired skill_workshop deny entry', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-tool-deny-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    expect(writeMinimalConfig(configPath, 'startup')).toMatchObject({ ok: true });
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.tools.deny = ['skill_workshop', 'custom-denied-tool'];
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    expect(writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh)).toMatchObject({
      ok: true,
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).tools.deny).toEqual([
      'custom-denied-tool',
    ]);
  });

  test('minimal config explicitly trusts extensions installed in app-managed state', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-plugin-trust-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const extensionDir = path.join(directory, 'extensions', 'justdo-skill-only-example');
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, 'openclaw.plugin.json'),
      "{ id: 'justdo-skill-only-example', // JSON5 manifest\n}",
      'utf8',
    );

    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.allow).toEqual([
      'justdo-skill-only-example',
      'browser',
      'ask-user-question',
      'automation-permission',
      'justdo-runtime-bridge',
    ]);
    expect(config.plugins.entries.browser).toEqual({ enabled: true });
    expect(config.plugins.bundledDiscovery).toBe('compat');
  });

  test('removes the built-in provider placeholder before its environment variable is revoked', () => {
    const configPath = writeExistingBuiltinConfig();

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogout);

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).not.toContain('JUSTDO_APIKEY_BUILTIN_MODELS');
    const config = JSON.parse(content);
    expect(config.models.providers).toBeUndefined();
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.agents.defaults).not.toHaveProperty('memorySearch');
    expect(config.memory.search).toEqual({ enabled: false });
    expect(config.agents.defaults.timeoutSeconds).toBe(120);
    expect(config.agents.defaults.systemAgent).toEqual({ agentId: 'main' });
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
    expect(config.agents.ownership).toBe('explicit');
    expect(config.agents.entries.main).toEqual({
      reasoningDefault: 'stream',
      workspace: path.join(path.dirname(configPath), 'workspace'),
    });
    expect(config.agents.entries).toHaveProperty('justdo-scheduler');
    expect(config.plugins.entries.custom_plugin).toEqual({
      enabled: true,
      config: { mode: 'keep-me' },
    });
    expect(config.skills.entries.docx).toEqual({ enabled: false });
    expect(config.session.maintenance).toEqual({
      mode: 'enforce',
      pruneAfter: '365d',
      maxEntries: 500,
    });
    expect(verifyLoggedOutOpenClawConfig(configPath)).toEqual({ ok: true });
  });

  test('auth-scoped sync removes the retired skill_workshop deny entry', () => {
    const configPath = writeExistingBuiltinConfig();
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.tools = { deny: ['skill_workshop', 'custom-denied-tool'] };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    expect(writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogout)).toMatchObject({
      ok: true,
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).tools.deny).toEqual([
      'custom-denied-tool',
    ]);
  });

  test('keeps the existing preservation behavior for non-logout minimal syncs', () => {
    const configPath = writeExistingBuiltinConfig();

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh);

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('JUSTDO_APIKEY_BUILTIN_MODELS');
    expect(JSON.parse(content).agents.defaults.compaction).not.toHaveProperty(
      'keepRecentTokens',
    );
  });

  test('minimal logout removes only built-in model config and preserves custom selections', () => {
    const configPath = writeExistingMixedProviderConfig();

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogout);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers).toEqual({
      'custom-provider': {
        apiKey: '${JUSTDO_APIKEY_CUSTOM_1}',
        models: [{ id: 'custom-model' }],
      },
    });
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.agents.defaults.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.defaults.timeoutSeconds).toBe(120);
    expect(config.agents.entries.main.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.entries.worker.model.primary).toBe('custom-provider/custom-model');
    expect(config.gateway).toEqual({ mode: 'local', customSetting: 'keep-me' });
    expect(config.customFeature).toEqual({ enabled: true });
    expect(verifyLoggedOutOpenClawConfig(configPath)).toEqual({ ok: true });
  });

  test('minimal login without fetched models preserves custom config and removes stale built-in refs', () => {
    const configPath = writeExistingMixedProviderConfig();
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.agents.defaults.model = { primary: 'builtin_models/builtin-model' };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogin);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers).toEqual({
      'custom-provider': {
        apiKey: '${JUSTDO_APIKEY_CUSTOM_1}',
        models: [{ id: 'custom-model' }],
      },
    });
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.agents.entries.main.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.entries.worker.model).toBeUndefined();
    expect(config.gateway).toEqual({ mode: 'local', customSetting: 'keep-me' });
    expect(config.customFeature).toEqual({ enabled: true });
  });

  test('rejects a logout config that still contains the built-in provider', () => {
    const configPath = writeExistingBuiltinConfig();

    expect(verifyLoggedOutOpenClawConfig(configPath)).toEqual({
      ok: false,
      error: expect.stringContaining('built-in API key placeholder remains'),
    });
  });

  test('rejects stale built-in agent model references after provider removal', () => {
    const configPath = writeExistingBuiltinConfig();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.models = { pricing: { enabled: false } };
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

    expect(verifyLoggedOutOpenClawConfig(configPath)).toEqual({
      ok: false,
      error: expect.stringContaining('default built-in model reference remains'),
    });
  });

  test('builds canonical Agent entries with a custom fallback', () => {
    const sync = new OpenClawConfigSync({
      engineManager: {
        getDesiredVersion: () => '2026.6.11',
      },
      getCoworkConfig: () => ({}),
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'builtin_models/chat-model',
          icon: '',
          skillIds: [],
          enabled: true,
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    } as never);

    const result = (
      sync as unknown as {
        buildAgentsEntries: (
          fallback: string,
          available: ReadonlySet<string>,
          workspace: string,
        ) => { ownership: 'explicit'; entries: Record<string, Record<string, unknown>> };
      }
    ).buildAgentsEntries(
      'custom-provider/custom-model',
      new Set(['custom-provider/custom-model']),
      'E:/workspace/project',
    );

    expect(result.ownership).toBe('explicit');
    expect(result.entries.main).toMatchObject({
      workspace: 'E:/workspace/project',
      model: {
        primary: 'custom-provider/custom-model',
      },
    });
    expect(result.entries['justdo-scheduler']).toEqual(
      expect.objectContaining({
        workspace: 'E:/workspace/project',
        tools: {
          fs: { workspaceOnly: false },
          exec: { host: 'gateway', mode: 'full' },
        },
      }),
    );
  });

  test('rejects a plugin-colliding display-name provider without changing config', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-full-auth-logout-'));
    temporaryDirectories.push(directory);
    const stateDir = path.join(directory, 'state');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: 'local' },
        customFeature: {
          enabled: true,
          nested: { value: 'preserve-me' },
        },
        models: {
          mode: 'replace',
          pricing: { enabled: true },
          providers: {
            builtin_models: {
              apiKey: '${JUSTDO_APIKEY_BUILTIN_MODELS}',
              models: [{ id: 'chat-model' }],
            },
            opencode: {
              apiKey: '${JUSTDO_APIKEY_CUSTOM_1}',
              models: [{ id: 'custom-model' }],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: 'builtin_models/chat-model' },
          },
          list: [
            {
              id: 'main',
              default: true,
              model: { primary: 'builtin_models/chat-model' },
            },
          ],
        },
      }),
      'utf8',
    );
    const appConfig = {
      model: {
        defaultModel: 'custom-model',
        defaultModelProvider: 'custom_1',
      },
      providers: {
        custom_1: {
          enabled: true,
          apiKey: 'custom-secret',
          baseUrl: 'https://custom.example/v1',
          apiFormat: 'openai' as const,
          displayName: 'OpenCode',
          models: [{ id: 'custom-model', name: 'Custom Model' }],
        },
      },
    };
    setStoreGetter(
      () =>
        ({
          get: () => appConfig,
        }) as never,
    );
    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getStateDir: () => stateDir,
        getDesiredVersion: () => '2026.6.11',
      },
      getCoworkConfig: () => ({
        workingDirectory: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
      }),
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'builtin_models/chat-model',
          icon: '',
          skillIds: [],
          enabled: true,
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    } as never);

    const result = sync.sync(BuiltinModelSyncReason.AuthLogout);

    expect(result.ok).toBe(false);
    expect(result.configChanged).toBe(false);
    expect(result.error).toContain('custom provider name "OpenCode" is reserved by OpenClaw');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models).toHaveProperty('pricing');
    expect(config.models.providers.builtin_models).toBeDefined();
    expect(config.models.providers.opencode).toBeDefined();
    expect(config.agents.defaults.model.primary).toBe('builtin_models/chat-model');
    expect(config.customFeature).toEqual({
      enabled: true,
      nested: { value: 'preserve-me' },
    });
  });

  test('login adds the built-in provider and preserves validated custom provider ids', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-auth-login-sync-'));
    temporaryDirectories.push(stateDir);
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: 'local', customSetting: 'keep-me' },
        customFeature: { enabled: true },
        models: {
          mode: 'replace',
          pricing: { enabled: true },
          providers: {
            'custom-provider': {
              apiKey: '${JUSTDO_APIKEY_CUSTOM_1}',
              models: [{ id: 'custom-model' }],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: 'custom-provider/custom-model' },
            thinkingDefault: 'high',
            compaction: {
              mode: 'safeguard',
              keepRecentTokens: 20_000,
            },
          },
        },
      }),
      'utf8',
    );
    const appConfig = {
      model: {
        defaultModel: 'custom-model',
        defaultModelProvider: 'custom_1',
      },
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: 'builtin-secret',
          baseUrl: 'http://127.0.0.1:4000/v1',
          apiFormat: 'openai' as const,
          models: [{ id: 'builtin-model', name: 'Built-in Model' }],
        },
        custom_1: {
          enabled: true,
          apiKey: 'custom-secret',
          baseUrl: 'https://custom.example/v1',
          apiFormat: 'openai' as const,
          displayName: 'Custom-Provider',
          models: [{ id: 'custom-model', name: 'Custom Model' }],
        },
      },
    };
    setStoreGetter(
      () =>
        ({
          get: () => appConfig,
        }) as never,
    );
    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getStateDir: () => stateDir,
        getDesiredVersion: () => '2026.6.11',
      },
      getCoworkConfig: () => ({
        workingDirectory: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
      }),
      getAgents: () => [],
    } as never);

    const result = sync.sync(BuiltinModelSyncReason.AuthLogin);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers.builtin_models.apiKey).toBe(
      '${JUSTDO_APIKEY_BUILTIN_MODELS}',
    );
    expect(config.models.providers['custom-provider'].apiKey).toBe(
      '${JUSTDO_APIKEY_CUSTOM_1}',
    );
    expect(config.models.providers.custom_1).toBeUndefined();
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.agents.defaults.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.defaults).not.toHaveProperty('thinkingDefault');
    expect(config.agents.defaults.compaction.memoryFlush).toEqual({ enabled: false });
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
    expect(config.gateway).toEqual({ mode: 'local', customSetting: 'keep-me' });
    expect(config.customFeature).toEqual({ enabled: true });
  });
});
