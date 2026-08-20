import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { BrowserMode, type BrowserMode as BrowserModeValue } from '../../../shared/browser';
import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
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
      recentTurnsPreserve: 0,
      memoryFlush: {
        enabled: false,
      },
      qualityGuard: {
        enabled: false,
        maxRetries: 2,
      },
    });
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
  });

  test('minimal config enables the JustDo permission policy before model setup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-policy-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    const result = writeMinimalConfig(configPath, 'startup');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['file-permission-policy']).toEqual({
      enabled: true,
      config: { mode: 'ask', fullAgentIds: ['justdo-scheduler'] },
    });
    expect(config.tools.fs.mode).toBeUndefined();
    expect(config.tools.fs.workspaceOnly).toBe(true);
    expect(config.tools.exec.mode).toBe('ask');
    expect(config.session).toEqual({
      dmScope: 'per-account-channel-peer',
      reset: { mode: 'idle' },
      maintenance: {
        mode: 'enforce',
        pruneAfter: '365d',
        maxEntries: 500,
      },
    });
  });

  test('a second no-model sync force-merges the latest managed permission preset', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-minimal-policy-switch-'));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, 'openclaw.json');

    expect(writeMinimalConfig(configPath, 'startup', 'ask').ok).toBe(true);
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.plugins.enabled = false;
    existing.plugins.allow = ['custom-plugin'];
    existing.plugins.deny = ['file-permission-policy', 'other-denied-plugin'];
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    const result = writeMinimalConfig(configPath, 'cowork-config-change', 'full');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tools.exec.mode).toBe('full');
    expect(config.tools.fs.workspaceOnly).toBe(false);
    expect(config.plugins.enabled).toBe(true);
    expect(config.plugins.allow).toEqual([
      'custom-plugin',
      'browser',
      'ask-user-question',
      'file-permission-policy',
    ]);
    expect(config.plugins.deny).toEqual(['other-denied-plugin']);
    expect(config.plugins.entries['file-permission-policy']).toEqual({
      enabled: true,
      config: { mode: 'full', fullAgentIds: ['justdo-scheduler'] },
    });
    expect(config.plugins.entries.browser).toEqual({ enabled: true });
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
      JSON.stringify({ id: 'justdo-skill-only-example' }),
      'utf8',
    );

    expect(writeMinimalConfig(configPath, 'startup').ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.allow).toEqual([
      'justdo-skill-only-example',
      'browser',
      'ask-user-question',
      'file-permission-policy',
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
    expect(config.models.pricing).toEqual({ enabled: true });
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.agents.defaults.memorySearch).toEqual({ enabled: false });
    expect(config.agents.defaults.timeoutSeconds).toBe(120);
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
    expect(config.agents.list).toEqual([
      {
        id: 'main',
        default: true,
        reasoningDefault: 'stream',
      },
    ]);
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
    expect(config.models.pricing).toEqual({ enabled: true });
    expect(config.agents.defaults.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.defaults.timeoutSeconds).toBe(120);
    expect(config.agents.list[0].model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.list[1].model.primary).toBe('custom-provider/custom-model');
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
    expect(config.models.pricing).toEqual({ enabled: true });
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.agents.list[0].model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.list[1].model).toBeUndefined();
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

  test('builds the Agent list with a custom fallback after the built-in provider is removed', () => {
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
        buildAgentsList: (
          fallback: string,
          available: ReadonlySet<string>,
          workspace: string,
        ) => { list?: Array<Record<string, unknown>> };
      }
    ).buildAgentsList(
      'custom-provider/custom-model',
      new Set(['custom-provider/custom-model']),
      'E:/workspace/project',
    );

    expect(result.list?.[0]).toMatchObject({
      id: 'main',
      model: {
        primary: 'custom-provider/custom-model',
      },
    });
    expect(result.list).toContainEqual(
      expect.objectContaining({
        id: 'justdo-scheduler',
        workspace: 'E:/workspace/project',
        tools: {
          fs: { workspaceOnly: false },
          exec: { host: 'gateway', mode: 'full' },
        },
      }),
    );
  });

  test('syncs the full logout config with a custom provider and stale built-in Agent model', () => {
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
            'custom-provider': {
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

    expect(result.ok).toBe(true);
    expect(result.configChanged).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.pricing).toEqual({ enabled: true });
    expect(config.models.providers.builtin_models).toBeUndefined();
    expect(config.models.providers['custom-provider']).toBeDefined();
    expect(config.agents.defaults.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.list[0].model.primary).toBe('custom-provider/custom-model');
    expect(config.customFeature).toEqual({
      enabled: true,
      nested: { value: 'preserve-me' },
    });
    expect(verifyLoggedOutOpenClawConfig(configPath)).toEqual({ ok: true });
  });

  test('login adds only the built-in provider and preserves unrelated config', () => {
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
    expect(config.models.providers['custom-provider']).toEqual({
      apiKey: '${JUSTDO_APIKEY_CUSTOM_1}',
      models: [{ id: 'custom-model' }],
    });
    expect(config.models.pricing).toEqual({ enabled: true });
    expect(config.agents.defaults.model.primary).toBe('custom-provider/custom-model');
    expect(config.agents.defaults.compaction.memoryFlush).toEqual({ enabled: false });
    expect(config.agents.defaults.compaction).not.toHaveProperty('keepRecentTokens');
    expect(config.gateway).toEqual({ mode: 'local', customSetting: 'keep-me' });
    expect(config.customFeature).toEqual({ enabled: true });
  });
});
