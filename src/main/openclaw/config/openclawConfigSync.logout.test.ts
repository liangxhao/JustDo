import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { BrowserMode, type BrowserMode as BrowserModeValue } from '../../../shared/browser/browser';
import { createDefaultAgentRuntimeSettings } from '../../../shared/openclaw/agentRuntimeSettings';
import { BuiltinModelSyncReason } from '../../../shared/providers/builtinModels';
import {
  clearActiveBuiltinModelCredential,
  setActiveBuiltinModelCredential,
} from '../../providers/builtinModelCredential';
import { setStoreGetter } from '../../providers/providerApiConfig';
import {
  listManagedOpenClawPluginIds,
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

test('allows users to toggle agent-team independently of required extensions', () => {
  expect(listManagedOpenClawPluginIds()).not.toContain('agent-team');
});

const setActiveJwt = (): string => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const accessToken = [
    encode({ alg: 'RS256', kid: 'login-key-1' }),
    encode({
      iss: 'https://login.example.test',
      aud: 'justdo-litellm',
      sub: 'user@example.com',
      iat: nowSeconds,
      exp: nowSeconds + 300,
      jti: 'token-1',
    }),
    'test-signature',
  ].join('.');
  setActiveBuiltinModelCredential({
    accessToken,
    userAccount: 'user@example.com',
    expiresAt: nowSeconds + 300,
  });
  return accessToken;
};
test('keeps both browser providers under browser-mode ownership', () => {
  expect(listManagedOpenClawPluginIds()).toEqual(
    expect.arrayContaining(['browser', 'embedded-browser']),
  );
});

afterEach(() => {
  clearActiveBuiltinModelCredential();
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
      secrets: {
        providers: {
          justdo_login: {
            source: 'file',
            path: path.join(directory, 'user_info.json'),
            mode: 'json',
          },
          operator_secrets: {
            source: 'file',
            path: path.join(directory, 'operator-secrets.json'),
            mode: 'json',
          },
        },
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
          modelSelectionScope: 'global',
          timeoutSeconds: 120,
          subagents: {
            allowAgents: ['worker'],
            announceTimeoutMs: 90_000,
            requireAgentId: true,
          },
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
      secrets: {
        providers: {
          justdo_login: {
            source: 'file',
            path: path.join(directory, 'user_info.json'),
            mode: 'json',
          },
          operator_secrets: {
            source: 'file',
            path: path.join(directory, 'operator-secrets.json'),
            mode: 'json',
          },
        },
      },
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
  localTtsConfig: Record<string, unknown> | null = null,
  executionMode: 'local' | 'sandbox' = 'local',
): OpenClawConfigSyncResult => {
  const sync = new OpenClawConfigSync({
    engineManager: {
      getDesiredVersion: () => '2026.6.11',
      getStateDir: () => path.dirname(configPath),
    },
    getCoworkConfig: () => ({
      workingDirectory: '',
      executionMode,
      agentEngine: 'openclaw',
      permissionMode,
    }),
    getBrowserMode: () => browserMode,
    getAgents: () => agents.map(agent => ({ model: '', ...agent })),
    getAgentRuntimeSettings: () => runtimeSettings,
    getLocalTtsConfig: () => localTtsConfig,
    getSpeechOutputState: () => ({
      enabled: true,
      mode: localTtsConfig ? 'local' : 'online',
    }),
  } as never);
  return (
    sync as unknown as {
      writeMinimalConfig: (path: string, syncReason: string) => OpenClawConfigSyncResult;
    }
  ).writeMinimalConfig(configPath, reason);
};

test.each([true, false])('preserves cold storage through minimal startup and subsequent runtime saves (enabled=%s)', enabled => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-storage-config-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'openclaw.json');
  const maintenance = { coldStorage: { enabled, afterDays: 47 }, maxDiskBytes: 104857600 };
  fs.writeFileSync(configPath, JSON.stringify({ session: { maintenance } }));
  for (const reason of ['startup', 'agent-runtime-settings-change', BuiltinModelSyncReason.AuthLogout]) {
    const result = writeMinimalConfig(configPath, reason);
    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).session.maintenance).toMatchObject(maintenance);
  }
});

describe('OpenClaw auth logout config sync', () => {
  test.each(['full', 'minimal'] as const)(
    '%s sync refreshes local STT configuration without overriding speech extension toggles',
    mode => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-toggle-sync-'));
      temporaryDirectories.push(stateDir);
      const configPath = path.join(stateDir, 'openclaw.json');
      const appConfig = mode === 'full' ? {
        model: { defaultModel: 'custom-model', defaultModelProvider: 'custom-provider' },
        providers: {
          'custom-provider': {
            enabled: true,
            apiKey: 'test-secret',
            baseUrl: 'https://custom.example.test/v1',
            apiFormat: 'openai',
            models: [{ id: 'custom-model' }],
          },
        },
      } : {};
      setStoreGetter(() => ({ get: () => appConfig }) as never);
      let sttConfig = { command: 'sherpa.exe', args: ['--model=first.onnx'], modelId: 'first' };
      const sync = new OpenClawConfigSync({
        engineManager: {
          getConfigPath: () => configPath,
          getStateDir: () => stateDir,
          getDesiredVersion: () => '2026.9.2',
        },
        getCoworkConfig: () => ({ workingDirectory: '', executionMode: 'local', agentEngine: 'openclaw' }),
        getAgents: () => [],
        getLocalSttConfig: () => sttConfig,
        getLocalTtsConfig: () => ({
          enabled: true,
          provider: 'tts-local-cli',
          providers: { 'tts-local-cli': { command: 'sherpa-tts.exe' } },
        }),
        getSpeechOutputState: () => ({ enabled: true, mode: 'local' }),
      } as never);
      const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

      expect(sync.sync('settings').ok).toBe(true);
      let config = readConfig();
      // Assert that the public entry point exercised the intended provider branch.
      expect(Boolean(config.models.providers?.['custom-provider'])).toBe(mode === 'full');
      for (const pluginId of ['tts-local-cli', 'stt-local-cli']) {
        expect(config.plugins.entries[pluginId].enabled).toBe(true);
        config.plugins.entries[pluginId].enabled = false;
      }
      fs.writeFileSync(configPath, JSON.stringify(config));
      sttConfig = { command: 'new-sherpa.exe', args: ['--model=second.onnx'], modelId: 'second' };

      expect(sync.sync('local-speech-model-installed').ok).toBe(true);
      config = readConfig();
      expect(config.plugins.entries['stt-local-cli']).toEqual({ enabled: false, config: sttConfig });
      expect(config.plugins.entries['tts-local-cli'].enabled).toBe(false);
      for (const pluginId of ['tts-local-cli', 'stt-local-cli']) {
        config.plugins.entries[pluginId].enabled = true;
      }
      fs.writeFileSync(configPath, JSON.stringify(config));

      expect(sync.sync('settings').ok).toBe(true);
      config = readConfig();
      expect(config.plugins.entries['stt-local-cli']).toEqual({ enabled: true, config: sttConfig });
      expect(config.plugins.entries['tts-local-cli'].enabled).toBe(true);
    },
  );

  test.each([
    BuiltinModelSyncReason.ManualRefresh,
    BuiltinModelSyncReason.AuthLogin,
    BuiltinModelSyncReason.AuthLogout,
  ])('forces the managed heartbeat off in the final no-model config for %s', reason => {
    const configPath = writeExistingBuiltinConfig();
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.agents.defaults.heartbeat = { every: '2h' };
    existing.agents.list[0].heartbeat = { every: '2h' };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    expect(writeMinimalConfig(configPath, reason)).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.heartbeat).toEqual({ every: '0m' });
    expect(config.agents.entries.main.heartbeat).toEqual({ every: '0m' });
  });

  test('writes a fail-closed native sandbox minimal config before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-sandbox-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    expect(
      writeMinimalConfig(
        configPath,
        'startup',
        'ask',
        BrowserMode.Isolated,
        [],
        createDefaultAgentRuntimeSettings(),
        null,
        'sandbox',
      ).ok,
    ).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.sandbox).toEqual({
      mode: 'all',
      backend: 'mxc',
      scope: 'session',
      workspaceAccess: 'rw',
    });
    expect(config.tools.exec.host).toBe('sandbox');
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.tools.sandbox).toEqual({
      tools: { alsoAllow: ['task_assistants', 'assistants_create'] },
    });
  });

  test('creates and updates independent roles before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-agents-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const agents = [
      { id: 'main', enabled: true, name: 'Main', isDefault: true },
      { id: 'research', enabled: true, name: 'Research', isDefault: false },
    ];
    expect(writeMinimalConfig(configPath, 'agent-profile-change', 'ask', BrowserMode.Isolated, agents).ok).toBe(true);
    let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.entries.research.workspace).toBe(path.join(directory, 'agent-workspaces', 'research'));
    expect(config.agents.entries.research.model).toBeUndefined();
    agents[0].isDefault = false;
    agents[1].isDefault = true;
    agents[1].name = 'Reviewer';
    expect(writeMinimalConfig(configPath, 'agent-profile-change', 'ask', BrowserMode.Isolated, agents).ok).toBe(true);
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.entries.research).toMatchObject({ identity: { name: 'Reviewer' } });
    expect(config.agents.entries.main.identity.name).toBe('Main');
  });

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
    expect(config.agents.defaults.modelSelectionScope).toBe('session');
  });

  test('enables the local speech extension when offline TTS assets are available', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-tts-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const tts = {
      enabled: true,
      auto: 'off',
      provider: 'tts-local-cli',
      providers: { 'tts-local-cli': { command: 'sherpa-onnx-offline-tts' } },
    };

    expect(
      writeMinimalConfig(
        configPath,
        BuiltinModelSyncReason.ManualRefresh,
        'ask',
        BrowserMode.Isolated,
        [],
        createDefaultAgentRuntimeSettings(),
        tts,
      ),
    ).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tts).toEqual(tts);
    expect(config.plugins.entries['tts-local-cli']).toEqual({ enabled: true });
    expect(config.plugins.allow).toContain('tts-local-cli');
  });

  test('projects Agent and SubAgent runtime controls before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-runtime-config-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const runtimeSettings = createDefaultAgentRuntimeSettings();
    runtimeSettings.agent.runTimeoutSeconds = 5400;
    runtimeSettings.agent.maxConcurrent = 6;
    runtimeSettings.subagents.archiveAfterMinutes = 1440;
    runtimeSettings.subagents.maxSpawnDepth = 5;

    expect(
      writeMinimalConfig(
        configPath,
        BuiltinModelSyncReason.ManualRefresh,
        'ask',
        BrowserMode.Isolated,
        [],
        runtimeSettings,
      ),
    ).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.timeoutSeconds).toBe(5400);
    expect(config.agents.defaults.maxConcurrent).toBe(6);
    expect(config.agents.defaults.subagents).toMatchObject({
      archiveAfterMinutes: 1440,
      maxSpawnDepth: 5,
    });
    expect(config.agents.defaults.subagents).not.toHaveProperty('delegationMode');
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
      requestTimeoutMs: 300_000,
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
    expect(config.tools.fs.mode).toBeUndefined();
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.tools.exec.mode).toBe('ask');
    expect(config.tools.sessions).toEqual({ visibility: 'tree' });
    expect(config.agents.defaults.systemAgent).toEqual({ agentId: 'main' });
    expect(config.agents.defaults.modelSelectionScope).toBe('session');
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
    runtimeSettings.automation.approvalTimeoutMinutes = 10;

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
    expect(config.plugins.entries['automation-permission']).toEqual({
      enabled: true,
      config: {
        approvalTimeoutMinutes: 10,
      },
    });
    expect(config.tools.deny).toContain('ask_user');
    expect(JSON.stringify(config.plugins.entries['ask-user-question'])).not.toContain('callback');
    expect(JSON.stringify(config.plugins.entries['ask-user-question'])).not.toContain('secret');
  });

  test('a second no-model sync restores AskUserQuestion and removes unavailable plugins', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-policy-switch-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const installedExtensionDir = path.join(directory, 'extensions', 'ask-user-question');
    fs.mkdirSync(installedExtensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedExtensionDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'ask-user-question' }),
      'utf8',
    );

    expect(writeMinimalConfig(configPath, 'startup', 'ask').ok).toBe(true);
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.plugins.enabled = false;
    existing.plugins.entries['unavailable-extension'] = { enabled: true };
    existing.plugins.entries['ask-user-question'] = { enabled: true };
    existing.plugins.allow = ['custom-plugin', 'ask-user-question', 'unavailable-extension'];
    existing.plugins.deny = ['other-unavailable-extension'];
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    const result = writeMinimalConfig(configPath, 'cowork-config-change', 'full');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tools.exec.mode).toBe('ask');
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.plugins.enabled).toBe(true);
    expect(config.plugins.allow).toEqual([
      'ask-user-question',
      'workboard',
      'agent-team',
      'memory-core',
      'code-mode-quickjs',
      'github',
      'browser',
      'stt-local-cli',
      'acpx',
      'automation-permission',
      'runtime-services',
      'plan-mode',
      'embedded-browser',
      'mxc',
    ]);
    expect(config.plugins.deny).toBeUndefined();
    expect(config.plugins.entries['ask-user-question']).toEqual({
      enabled: true,
      config: { timeoutMinutes: 10 },
    });
    expect(config.plugins.entries['unavailable-extension']).toBeUndefined();
    expect(config.plugins.entries.browser).toEqual({ enabled: true });
    expect(config.plugins.entries['embedded-browser']).toEqual({ enabled: false });
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
      'workboard',
      'agent-team',
      'memory-core',
      'code-mode-quickjs',
      'github',
      'browser',
      'stt-local-cli',
      'acpx',
      'ask-user-question',
      'automation-permission',
      'runtime-services',
      'plan-mode',
      'embedded-browser',
      'mxc',
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

  test.each(
    (['full', 'minimal'] as const).flatMap(configMode =>
      [BrowserMode.Isolated, BrowserMode.User, BrowserMode.Extension].map(nativeMode => ({
        configMode,
        nativeMode,
      })),
    ),
  )('hot switches $nativeMode and embedded in $configMode config', ({ configMode, nativeMode }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-switch-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    const appConfig = configMode === 'full' ? {
      model: { defaultModel: 'custom-model', defaultModelProvider: 'custom-provider' },
      providers: {
        'custom-provider': {
          enabled: true,
          apiKey: 'test-secret',
          baseUrl: 'https://custom.example.test/v1',
          apiFormat: 'openai',
          models: [{ id: 'custom-model' }],
        },
      },
    } : {};
    setStoreGetter(() => ({ get: () => appConfig }) as never);
    let browserMode: BrowserModeValue = nativeMode;
    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getStateDir: () => directory,
        getDesiredVersion: () => '2026.9.2',
      },
      getCoworkConfig: () => ({ workingDirectory: '', executionMode: 'local', agentEngine: 'openclaw' }),
      getAgents: () => [],
      getBrowserMode: () => browserMode,
    } as never);
    const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(sync.sync('startup').ok).toBe(true);
    const nativeConfig = readConfig();
    expect(Boolean(nativeConfig.models.providers?.['custom-provider'])).toBe(configMode === 'full');

    browserMode = BrowserMode.Embedded;
    expect(sync.sync('browser-mode-change')).toMatchObject({
      ok: true, configChanged: true, requiresGatewayRestart: false,
    });
    const config = readConfig();
    expect(config.browser.enabled).toBe(true);
    expect(config.plugins.entries.browser).toEqual({ enabled: false });
    expect(config.plugins.entries['embedded-browser']).toEqual({ enabled: true });

    browserMode = nativeMode;
    expect(sync.sync('browser-mode-change')).toMatchObject({
      ok: true, configChanged: true, requiresGatewayRestart: false,
    });
    const restoredConfig = readConfig();
    expect(restoredConfig.browser).toEqual(nativeConfig.browser);
    expect(restoredConfig.plugins.entries.browser).toEqual({ enabled: true });
    expect(restoredConfig.plugins.entries['embedded-browser']).toEqual({ enabled: false });
    expect(sync.sync('browser-mode-change')).toMatchObject({
      ok: true, configChanged: false, requiresGatewayRestart: false,
    });
  });

  test('minimal startup defaults skill automation off and preserves an explicit opt-in on subsequent sync', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-skill-default-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.skills.workshop.autonomous.mode).toBe('off');
    config.skills.workshop.autonomous.mode = 'auto';
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    expect(writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).skills.workshop.autonomous.mode).toBe('auto');
  });

  test.each([undefined, 'off', 'auto', 'propose'])('auth sync defaults only missing skill mode (%s)', mode => {
    const configPath = writeExistingBuiltinConfig();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.skills = { workshop: { autonomous: mode ? { mode } : {} } };
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
    expect(writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogout).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).skills.workshop.autonomous.mode).toBe(mode ?? 'off');
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
      'workboard',
      'agent-team',
      'memory-core',
      'code-mode-quickjs',
      'github',
      'browser',
      'stt-local-cli',
      'acpx',
      'ask-user-question',
      'automation-permission',
      'runtime-services',
      'plan-mode',
      'embedded-browser',
      'mxc',
    ]);
    expect(config.plugins.entries.browser).toEqual({ enabled: true });
    expect(config.plugins.bundledDiscovery).toBeUndefined();
  });

  test('a no-model sync preserves an explicitly disabled Workboard plugin', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-workboard-disabled-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');
    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(existing.plugins.entries.workboard).toEqual({ enabled: true });
    existing.plugins.entries.workboard = { enabled: false };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    expect(writeMinimalConfig(configPath, BuiltinModelSyncReason.CoworkConfigChange).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.entries.workboard).toEqual({
      enabled: false,
    });
    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.entries.workboard).toEqual({
      enabled: false,
    });
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
    expect(config.agents.defaults.timeoutSeconds).toBe(
      createDefaultAgentRuntimeSettings().agent.runTimeoutSeconds,
    );
    expect(config.agents.defaults.maxConcurrent).toBeUndefined();
    expect(config.agents.defaults.subagents).toMatchObject({
      allowAgents: ['worker'],
      announceTimeoutMs: 90_000,
      requireAgentId: true,
    });
    expect(config.agents.defaults.systemAgent).toEqual({ agentId: 'main' });
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
    expect(config.agents.ownership).toBe('explicit');
    expect(config.agents.entries.main).toEqual({
      reasoningDefault: 'stream',
      heartbeat: { every: '0m' },
      workspace: path.join(path.dirname(configPath), 'workspace'),
    });
    expect(Object.keys(config.agents.entries)).toEqual(['main']);
    expect(config.plugins.entries.custom_plugin).toEqual({
      enabled: true,
      config: { mode: 'keep-me' },
    });
    expect(config.skills.entries.docx).toEqual({ enabled: false });
    expect(config.secrets.providers).toEqual({
      operator_secrets: {
        source: 'file',
        path: path.join(path.dirname(configPath), 'operator-secrets.json'),
        mode: 'json',
      },
    });
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
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.models.catalogRefresh = { enabled: true };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh);

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('JUSTDO_APIKEY_BUILTIN_MODELS');
    const config = JSON.parse(content);
    expect(config.models.catalogRefresh).toEqual({ enabled: false });
    expect(config.agents.defaults.compaction).not.toHaveProperty(
      'keepRecentTokens',
    );
    expect(config.agents.defaults.modelSelectionScope).toBe('session');
    expect(config.agents.defaults.subagents).toMatchObject({
      allowAgents: ['worker'],
      announceTimeoutMs: 90_000,
      requireAgentId: true,
    });
  });

  test('minimal logout removes obsolete legacy custom provider config', () => {
    const configPath = writeExistingMixedProviderConfig();

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogout);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers).toBeUndefined();
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.agents.defaults.timeoutSeconds).toBe(
      createDefaultAgentRuntimeSettings().agent.runTimeoutSeconds,
    );
    expect(config.agents.entries.main.model).toBeUndefined();
    expect(config.agents.entries.worker.model).toBeUndefined();
    expect(config.gateway).toEqual({ mode: 'local', customSetting: 'keep-me' });
    expect(config.customFeature).toEqual({ enabled: true });
    expect(config.secrets.providers).toEqual({
      operator_secrets: {
        source: 'file',
        path: path.join(path.dirname(configPath), 'operator-secrets.json'),
        mode: 'json',
      },
    });
    expect(verifyLoggedOutOpenClawConfig(configPath)).toEqual({ ok: true });
  });

  test('minimal login without fetched models removes obsolete provider refs', () => {
    const configPath = writeExistingMixedProviderConfig();
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.agents.defaults.model = { primary: 'builtin_models/builtin-model' };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogin);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers).toBeUndefined();
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.agents.entries.main.model).toBeUndefined();
    expect(config.agents.entries.worker.model).toBeUndefined();
    expect(config.gateway).toEqual({ mode: 'local', customSetting: 'keep-me' });
    expect(config.customFeature).toEqual({ enabled: true });
  });

  test('rejects a logout config that still contains the built-in provider', () => {
    const configPath = writeExistingBuiltinConfig();

    expect(verifyLoggedOutOpenClawConfig(configPath)).toEqual({
      ok: false,
      error: expect.stringContaining('built-in authentication placeholder remains'),
    });
  });

  test('rejects stale built-in agent model references after provider removal', () => {
    const configPath = writeExistingBuiltinConfig();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.models = { pricing: { enabled: false } };
    delete config.secrets;
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
    expect(Object.keys(result.entries)).toEqual(['main']);
  });

  test('rejects an application-reserved display-name provider without changing config', () => {
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
          displayName: 'JustDo',
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
    expect(result.error).toContain(
      'custom provider name "JustDo" conflicts with an application-managed provider id',
    );
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

  test('never places the built-in JWT in the Gateway launch environment', () => {
    const accessToken = setActiveJwt();
    setStoreGetter(
      () =>
        ({
          get: () => ({
            providers: {
              builtin_models: {
                enabled: true,
                apiKey: '',
                baseUrl: 'https://models.example.test/v1',
                models: [{ id: 'builtin-model' }],
              },
              custom_1: {
                enabled: true,
                apiKey: 'custom-secret',
                baseUrl: 'https://custom.example.test/v1',
                models: [{ id: 'custom-model' }],
              },
            },
          }),
        }) as never,
    );
    const sync = new OpenClawConfigSync({
      engineManager: {},
      getCoworkConfig: () => ({}),
      getAgentRuntimeSettings: createDefaultAgentRuntimeSettings,
    } as never);

    const environment = sync.collectGatewayLaunchEnvVars();

    expect(environment).not.toHaveProperty('JUSTDO_APIKEY_BUILTIN_MODELS');
    expect(environment).not.toHaveProperty('JUSTDO_APIKEY_CUSTOM_1');
    expect(JSON.stringify(environment)).not.toContain(accessToken);
  });

  test('login adds the built-in provider and preserves validated custom provider ids', () => {
    const accessToken = setActiveJwt();
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
        defaultModelProvider: 'custom-provider',
      },
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: '',
          baseUrl: 'http://127.0.0.1:4000/v1',
          apiFormat: 'openai' as const,
          models: [{ id: 'builtin-model', name: 'Built-in Model' }],
        },
        'custom-provider': {
          enabled: true,
          apiKey: 'custom-secret',
          baseUrl: 'https://custom.example/v1',
          apiFormat: 'openai' as const,
          displayName: 'Custom-Provider',
          identity: 'custom-provider-identity',
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
    expect(config.models.providers.builtin_models.apiKey).toEqual({
      source: 'exec',
      provider: 'justdo_login',
      id: 'X-ACCESS-JWT',
    });
    expect(config.models.providers.builtin_models.headers).toEqual({
      'X-ACCESS-JWT': {
        source: 'exec',
        provider: 'justdo_login',
        id: 'X-ACCESS-JWT',
      },
      'X-User-Account': {
        source: 'exec',
        provider: 'justdo_login',
        id: 'X-User-Account',
      },
    });
    expect(config.secrets.providers.justdo_login).toMatchObject({ source: 'exec' });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain(accessToken);
    expect(config.models.providers['custom-provider'].apiKey).toEqual({
      source: 'file', provider: 'justdo-model-providers', id: '/custom-provider',
    });
    expect(config.models.providers.custom_1).toBeUndefined();
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.agents.defaults.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.defaults).not.toHaveProperty('thinkingDefault');
    expect(config.agents.defaults.compaction.memoryFlush).toEqual({ enabled: false });
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
    expect(config.gateway).toEqual({ mode: 'local', customSetting: 'keep-me' });
    expect(config.customFeature).toEqual({ enabled: true });

    // Ordinary sync establishes the steady-state config. Adding another
    // supplier must change only the native config/secret file, not launch env.
    expect(sync.sync('settings').ok).toBe(true);
    const launchEnvironment = sync.collectGatewayLaunchEnvVars();
    expect(launchEnvironment).not.toHaveProperty('JUSTDO_APIKEY_CUSTOM_1');
    const providersWithSecond = {
      ...appConfig.providers,
      'second-provider': {
        ...appConfig.providers['custom-provider'],
        displayName: 'Second-Provider',
        identity: 'second-provider-identity',
        apiKey: 'second-provider-fixture-key',
        baseUrl: 'https://second.example/v1',
      },
    };
    setStoreGetter(() => ({ get: () => ({ ...appConfig, providers: providersWithSecond }) }) as never);
    expect(sync.sync('provider-add')).toMatchObject({
      ok: true, configChanged: true, secretsChanged: true, requiresGatewayRestart: false,
    });
    expect(sync.collectGatewayLaunchEnvVars()).toEqual(launchEnvironment);

    providersWithSecond['second-provider'].apiKey = 'rotated-provider-fixture-key';
    expect(sync.sync('provider-key-change')).toMatchObject({
      ok: true, changed: true, configChanged: false, secretsChanged: true,
    });
    expect(sync.collectGatewayLaunchEnvVars()).toEqual(launchEnvironment);

    const beforeRename = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    beforeRename.agents.entries.worker = {
      id: 'worker',
      model: { primary: 'custom-provider/custom-model' },
    };
    fs.writeFileSync(configPath, JSON.stringify(beforeRename), 'utf8');
    const { ['custom-provider']: renamedProvider, ...providersWithoutRenamed } =
      providersWithSecond;
    const renamedProviders = {
      ...providersWithoutRenamed,
      'renamed-provider': { ...renamedProvider, displayName: 'Renamed-Provider' },
    };
    setStoreGetter(
      () =>
        ({
          get: () => ({
            ...appConfig,
            model: { ...appConfig.model, defaultModelProvider: 'renamed-provider' },
            providers: renamedProviders,
          }),
        }) as never,
    );
    expect(sync.sync(BuiltinModelSyncReason.AuthLogin).ok).toBe(true);
    const renamed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(renamed.models.providers['custom-provider']).toBeUndefined();
    expect(renamed.models.providers['renamed-provider'].apiKey).toEqual({
      source: 'file', provider: 'justdo-model-providers', id: '/renamed-provider',
    });
    expect(renamed.agents.defaults.model.primary).toBe('renamed-provider/custom-model');
    expect(renamed.agents.entries.worker.model.primary).toBe(
      'renamed-provider/custom-model',
    );

    setStoreGetter(
      () =>
        ({
          get: () => ({
            ...appConfig,
            model: { defaultModel: 'builtin-model', defaultModelProvider: 'builtin_models' },
            providers: { builtin_models: appConfig.providers.builtin_models },
          }),
        }) as never,
    );
    expect(sync.sync(BuiltinModelSyncReason.AuthLogin).ok).toBe(true);
    const customProvidersRemoved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(Object.keys(customProvidersRemoved.models.providers)).toEqual(['builtin_models']);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, 'model-provider-secrets.json'), 'utf8')),
    ).toEqual({});
  });
});


test.each([true, false])('keeps the optional agent-team enabled=%s across full minimal config synchronization', enabled => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-agent-team-config-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'openclaw.json');
  expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(config.plugins.entries['agent-team']).toEqual({ enabled: false });
  config.plugins.entries['agent-team'] = { enabled };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  expect(writeMinimalConfig(configPath, 'cowork-config-change').ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.entries['agent-team']).toEqual({ enabled });
});
