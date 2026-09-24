import { describe, expect, test } from 'vitest';

import { BrowserMode } from '../../../shared/browser/browser';
import {
  AgentRuntimeDelegationMode,
  AgentRuntimeSessionVisibility,
  createDefaultAgentRuntimeSettings,
} from '../../../shared/openclaw/agentRuntimeSettings';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import { createDefaultExternalAgentSettings } from '../../../shared/openclaw/externalAgents';
import {
  OpenClawApi,
  OpenClawProviderId,
  ProviderName,
  ProviderRegistry,
} from '../../../shared/providers';
import {
  clearActiveBuiltinModelCredential,
  setActiveBuiltinModelDevelopmentApiKey,
} from '../../providers/builtinModelCredential';
import type { ProviderRawConfig } from '../../providers/providerApiConfig';
import {
  applyDefaultOpenClawPluginEntries,
  applyManagedOpenClawHeartbeatConfig,
  buildBuiltinMemorySearchConfig,
  buildDefaultOpenClawPluginEntries,
  buildManagedAcpxPluginEntry,
  buildManagedExternalAgentEntries,
  buildManagedOnlineAsrPluginEntries,
  buildManagedOpenClawAcpConfig,
  buildManagedOpenClawAgentThinkingConfig,
  buildManagedOpenClawCompactionConfig,
  buildManagedOpenClawConnectivityConfig,
  buildManagedOpenClawCronConfig,
  buildManagedOpenClawHeartbeatConfig,
  buildManagedOpenClawModelCatalogConfig,
  buildManagedOpenClawSandboxConfig,
  buildManagedOpenClawSandboxToolConfig,
  buildManagedOpenClawSessionConfig,
  buildManagedOpenClawSubagentConfig,
  buildManagedOpenClawTtsPluginEntries,
  buildOpenClawConfigMeta,
  buildProviderSelection,
  hasOpenClawConfigChanged,
  mergeAgentEntriesWithManagedMainSettings,
  mergeOpenClawPluginConfig,
  mergeOpenClawSkillConfig,
  OPENCLAW_FALLBACK_EXEC_MODE,
  OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY,
  OPENCLAW_MAX_SKILLS_IN_PROMPT,
  OPENCLAW_MAX_SKILLS_PROMPT_CHARS,
  OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS,
  OPENCLAW_SESSION_MAX_ENTRIES,
  OPENCLAW_SESSION_PRUNE_AFTER,
  OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  OPENCLAW_SUBAGENT_MAX_CONCURRENT,
  OpenClawConfigSync,
  removeUnavailableOpenClawPluginRegistrations,
  resolveManagedOpenClawTtsConfig,
  resolveOpenClawExecHost,
  sanitizeOpenClawV2026_9_2Config,
} from './openclawConfigSync';

describe('Windows native sandbox config', () => {
  test('selects the registered backend and sandbox execution host', () => {
    expect(buildManagedOpenClawSandboxConfig('sandbox')).toEqual({
      mode: 'all',
      backend: 'mxc',
      scope: 'session',
      workspaceAccess: 'rw',
    });
    expect(resolveOpenClawExecHost('sandbox')).toBe('sandbox');
  });

  test('does not select the Windows backend for local execution', () => {
    expect(buildManagedOpenClawSandboxConfig('local')).toEqual({ mode: 'off' });
    expect(resolveOpenClawExecHost('local')).toBe('gateway');
    expect(buildManagedOpenClawSandboxConfig('auto')).toEqual({ mode: 'off' });
    expect(resolveOpenClawExecHost('auto')).toBe('gateway');
  });

  test('keeps trusted collaboration tools available inside the sandbox', () => {
    expect(buildManagedOpenClawSandboxToolConfig('sandbox')).toEqual({
      tools: { alsoAllow: ['task_assistants', 'assistants_create'] },
    });
    expect(buildManagedOpenClawSandboxToolConfig('local')).toEqual({
      tools: { alsoAllow: ['task_assistants', 'assistants_create', 'bundle-mcp'] },
    });
  });
});
const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) {
    return normalized.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return normalized;
};

const resolveDescriptor = (providerName: string) => ({
  providerId: providerName || OpenClawProviderId.JustDo,
  api: OpenClawApi.OpenAICompletions,
  normalizeBaseUrl: stripChatCompletionsSuffix,
});

describe('provider registry', () => {
  test('contains only the supported built-in models provider', () => {
    expect(ProviderRegistry.providerIds).toEqual([ProviderName.BuiltinModels]);
  });

  test('maps the built-in models provider to its OpenClaw identifier', () => {
    expect(ProviderRegistry.getOpenClawProviderId(ProviderName.BuiltinModels)).toBe(
      OpenClawProviderId.BuiltinModels,
    );
  });

  test('preserves custom provider identifiers', () => {
    expect(ProviderRegistry.getOpenClawProviderId('custom_3')).toBe('custom_3');
  });
});

describe('default provider descriptor', () => {
  test('uses OpenAI completions and preserves a custom provider identifier', () => {
    const descriptor = resolveDescriptor('custom_2');

    expect(descriptor.providerId).toBe('custom_2');
    expect(descriptor.api).toBe(OpenClawApi.OpenAICompletions);
  });

  test('falls back to the JustDo provider for an empty identifier', () => {
    expect(resolveDescriptor('').providerId).toBe(OpenClawProviderId.JustDo);
  });

  test.each([
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/chat/completions/', 'https://api.example.com/v1'],
    [' https://api.example.com/v1/ ', 'https://api.example.com/v1'],
    ['', ''],
  ])('normalizes provider base URL %s', (input, expected) => {
    expect(resolveDescriptor('custom_0').normalizeBaseUrl(input)).toBe(expected);
  });
});

describe('OpenClaw provider config', () => {
  test('uses the first sorted built-in embedding model for memory search', () => {
    const providers: ProviderRawConfig[] = [
      {
        providerName: ProviderName.BuiltinModels,
        baseURL: 'http://127.0.0.1:4000/v1',
        apiKey: 'justdo-builtin-credential',
        apiType: 'openai',
        models: [{ id: 'chat-model' }],
        embeddingModels: [{ id: 'embedding-z' }, { id: 'embedding-a' }],
      },
    ];

    expect(buildBuiltinMemorySearchConfig(providers)).toEqual({
      enabled: true,
      provider: OpenClawExtensionId.RUNTIME_SERVICES,
      model: 'embedding-a',
      remote: {
        baseUrl: 'http://127.0.0.1:4000/v1',
        apiKey: {
          source: 'exec',
          provider: 'justdo_login',
          id: 'X-ACCESS-JWT',
        },
        headers: {
          'User-Agent': 'OpenAI/JS 6.39.1',
        },
      },
    });
  });

  test('disables memory search without a built-in embedding model', () => {
    expect(
      buildBuiltinMemorySearchConfig([
        {
          providerName: ProviderName.BuiltinModels,
          baseURL: 'http://127.0.0.1:4000/v1',
          apiKey: 'sk-local',
          apiType: 'openai',
          models: [{ id: 'chat-model' }],
          embeddingModels: [],
        },
      ]),
    ).toEqual({ enabled: false });
  });

  test('uses the validated custom provider display name in generated model references', () => {
    const selection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.example.com/v1',
      modelId: 'usage-aware-model',
      apiType: 'openai',
      providerName: 'custom_0',
      displayName: 'AcmeProxy',
      headers: { 'X-Tenant': 'tenant-a' },
    });

    expect(selection.providerId).toBe('acmeproxy');
    expect(selection.primaryModel).toBe('acmeproxy/usage-aware-model');
    expect(selection.providerConfig.apiKey).toEqual({
      source: 'file',
      provider: 'justdo-model-providers',
      id: '/acmeproxy',
    });
    expect(selection.providerConfig.models).toHaveLength(1);
    expect(selection.providerConfig.headers).toEqual({
      'X-Tenant': {
        source: 'file',
        provider: 'justdo-model-providers',
        id: expect.stringMatching(/^\/header:acmeproxy:/),
      },
    });
    expect(selection.providerConfig.models[0]?.compat).toEqual({
      supportsUsageInStreaming: true,
    });
  });

  test('adds JWT identity placeholders only to the built-in provider', () => {
    const selection = buildProviderSelection({
      apiKey: 'access-jwt-auth',
      baseURL: 'https://models.example.test/v1',
      modelId: 'team-model',
      apiType: 'openai',
      providerName: ProviderName.BuiltinModels,
    });

    expect(selection.providerConfig.headers).toEqual({
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
    expect(selection.providerConfig.apiKey).toEqual({
      source: 'exec',
      provider: 'justdo_login',
      id: 'X-ACCESS-JWT',
    });
  });

  test('omits JWT identity headers for a development API key', () => {
    setActiveBuiltinModelDevelopmentApiKey('sk-development');
    try {
      const selection = buildProviderSelection({
        apiKey: 'access-jwt-auth',
        baseURL: 'http://127.0.0.1:9108/v1',
        modelId: 'development-model',
        apiType: 'openai',
        providerName: ProviderName.BuiltinModels,
      });
      expect(selection.providerConfig.headers).toBeUndefined();
      expect(selection.providerConfig.apiKey).toEqual({
        source: 'exec',
        provider: 'justdo_login',
        id: 'X-ACCESS-JWT',
      });
    } finally {
      clearActiveBuiltinModelCredential();
    }
  });

  test('sets a provider idle timeout above the OpenClaw default', () => {
    const selection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.example.com/v1',
      modelId: 'deepseek-v4-flash',
      apiType: 'openai',
      providerName: 'custom',
    });

    expect(selection.providerConfig.timeoutSeconds).toBe(OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS);
    expect(selection.providerConfig.timeoutSeconds).toBeGreaterThan(120);
  });

  test('never projects custom provider headers onto the built-in provider', () => {
    const selection = buildProviderSelection({
      apiKey: 'ignored',
      baseURL: 'https://builtin.example/v1',
      modelId: 'builtin-model',
      apiType: 'openai',
      providerName: ProviderName.BuiltinModels,
      headers: { 'X-Must-Not-Leak': 'value' },
    });

    expect(selection.providerConfig.headers).toEqual({
      'X-ACCESS-JWT': { source: 'exec', provider: 'justdo_login', id: 'X-ACCESS-JWT' },
      'X-User-Account': { source: 'exec', provider: 'justdo_login', id: 'X-User-Account' },
    });
  });
});

describe('OpenClaw managed config metadata', () => {
  test('writes only metadata accepted by OpenClaw v2026.9.2', () => {
    const meta = buildOpenClawConfigMeta('2026.9.2');

    expect(meta).toEqual({
      lastTouchedVersion: '2026.9.2',
    });
  });

  test('treats a retired metadata timestamp as a change so sync removes it', () => {
    const currentContent = JSON.stringify({
      gateway: { mode: 'local' },
      meta: {
        lastTouchedVersion: '2026.9.2',
        lastTouchedAt: '2026-07-13T03:27:00.677Z',
      },
    });
    const nextConfig = {
      meta: {
        lastTouchedVersion: '2026.9.2',
      },
      gateway: { mode: 'local' },
    };

    expect(hasOpenClawConfigChanged(currentContent, nextConfig)).toBe(true);
  });

  test('detects substantive config and version changes', () => {
    const currentContent = JSON.stringify({
      gateway: { mode: 'local' },
      meta: {
        lastTouchedVersion: '2026.6.11',
      },
    });

    expect(
      hasOpenClawConfigChanged(currentContent, {
        gateway: { mode: 'remote' },
        meta: {
          lastTouchedVersion: '2026.6.11',
        },
      }),
    ).toBe(true);
    expect(
      hasOpenClawConfigChanged(currentContent, {
        gateway: { mode: 'local' },
        meta: {
          lastTouchedVersion: '2026.7.1',
        },
      }),
    ).toBe(true);
  });
});

describe('OpenClaw managed model catalog config', () => {
  test('disables the unconfigured hosted model catalog refresh', () => {
    expect(buildManagedOpenClawModelCatalogConfig()).toEqual({
      catalogRefresh: { enabled: false },
    });
  });
});

describe('OpenClaw v2026.9.2 config sanitization', () => {
  test('removes retired fields and converts legacy managed surfaces', () => {
    const config = sanitizeOpenClawV2026_9_2Config({
      meta: {
        lastTouchedVersion: '2026.9.2',
        lastTouchedAt: '2026-09-01T00:00:00.000Z',
      },
      diagnostics: {
        stuckSessionWarnMs: 600_000,
        stuckSessionAbortMs: 2_400_000,
        otel: { enabled: false },
      },
      models: {
        pricing: { enabled: false },
        mode: 'replace',
      },
      browser: {
        color: '#00AA00',
        enabled: true,
        profiles: {
          chrome: {
            driver: 'extension',
            color: '#FF4500',
          },
          remote: {
            cdpUrl: 'http://127.0.0.1:9222',
          },
        },
      },
      mcp: {
        servers: {
          docs: { url: 'https://example.com/mcp', timeout: 60 },
        },
      },
      tools: {
        experimental: { planTool: true },
      },
      agents: {
        defaults: {
          memorySearch: { enabled: false },
          heartbeat: {
            every: '0m',
            includeSystemPromptSection: false,
          },
        },
        list: [
          {
            id: 'Main',
            default: true,
            heartbeat: {
              every: '2h',
              includeSystemPromptSection: false,
            },
          },
        ],
      },
    });

    expect(config).toMatchObject({
      meta: { lastTouchedVersion: '2026.9.2' },
      diagnostics: { otel: { enabled: false } },
      models: { mode: 'replace' },
      browser: {
        enabled: true,
        profiles: {
          chrome: { driver: 'extension' },
          remote: { cdpUrl: 'http://127.0.0.1:9222' },
        },
      },
      mcp: {
        servers: {
          docs: { url: 'https://example.com/mcp', requestTimeoutMs: 60_000 },
        },
      },
      tools: { updatePlan: true },
      memory: { search: { enabled: false } },
      agents: {
        ownership: 'explicit',
        defaults: { heartbeat: { every: '0m' } },
        entries: {
          main: { heartbeat: { every: '2h' } },
        },
      },
    });
    expect(config.meta).not.toHaveProperty('lastTouchedAt');
    expect(config.diagnostics).not.toHaveProperty('stuckSessionWarnMs');
    expect(config.models).not.toHaveProperty('pricing');
    expect(config.browser).not.toHaveProperty('color');
    expect(config.browser.profiles.chrome).not.toHaveProperty('color');
    expect(config.mcp.servers.docs).not.toHaveProperty('timeout');
    expect(config.tools).not.toHaveProperty('experimental');
    expect(config.agents).not.toHaveProperty('list');
    expect(sanitizeOpenClawV2026_9_2Config(config)).toEqual(config);
  });
});

describe('OpenClaw managed compaction config', () => {
  test('keeps only the JustDo safeguards on top of native compaction defaults', () => {
    const compaction = buildManagedOpenClawCompactionConfig();

    expect(compaction).toEqual({
      mode: 'safeguard',
      timeoutSeconds: 30 * 60,
      memoryFlush: {
        enabled: false,
      },
      midTurnPrecheck: {
        enabled: true,
      },
    });
  });
});

describe('OpenClaw managed heartbeat config', () => {
  test('disables recurring heartbeat runs', () => {
    expect(buildManagedOpenClawHeartbeatConfig()).toEqual({
      every: '0m',
    });
  });

  test('prevents the main agent from inheriting OpenClaw heartbeat defaults', () => {
    expect(applyManagedOpenClawHeartbeatConfig({ id: 'main', default: true })).toEqual({
      id: 'main',
      default: true,
      heartbeat: {
        every: '0m',
      },
    });
    expect(applyManagedOpenClawHeartbeatConfig({ id: 'researcher' })).toEqual({
      id: 'researcher',
    });
  });
});

describe('OpenClaw permission policy', () => {
  test('uses a restricted global fallback for sessions without native policy metadata', () => {
    expect(OPENCLAW_FALLBACK_EXEC_MODE).toBe('ask');
    expect(OPENCLAW_FALLBACK_FS_WORKSPACE_ONLY).toBe(true);
  });
});
describe('OpenClaw managed connectivity config', () => {
  test('keeps intranet web tools while disabling unused tools and update checks', () => {
    expect(buildManagedOpenClawConnectivityConfig()).toEqual({
      update: {
        checkOnStart: false,
        auto: {
          enabled: false,
        },
      },
      tools: {
        updatePlan: true,
        toolSearch: {
          enabled: true,
          mode: 'directory',
        },
        sessions: {
          visibility: 'tree',
        },
        deny: [
          'ask_user',
          'web_search',
          'tts',
          'message',
          'nodes',
          'gateway',
          'file_fetch',
          'dir_list',
          'dir_fetch',
          'file_write',
        ],
        web: {
          search: {
            enabled: false,
          },
          fetch: {
            enabled: true,
            useTrustedEnvProxy: true,
            ssrfPolicy: {
              allowRfc2544BenchmarkRange: true,
            },
          },
        },
      },
      browser: {
        enabled: true,
        extensionRelay: {
          allowLegacyAuth: false,
        },
        defaultProfile: 'openclaw',
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
    });
  });

  test('uses the existing user session only after the user opts in', () => {
    expect(buildManagedOpenClawConnectivityConfig(BrowserMode.User).browser).toEqual({
      enabled: true,
      extensionRelay: {
        allowLegacyAuth: false,
      },
      defaultProfile: 'user',
      profiles: {
        user: {
          driver: 'existing-session',
          attachOnly: true,
        },
      },
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  test('uses the Chrome extension profile after the user opts in', () => {
    expect(buildManagedOpenClawConnectivityConfig(BrowserMode.Extension).browser).toEqual({
      enabled: true,
      extensionRelay: {
        allowLegacyAuth: false,
      },
      defaultProfile: 'chrome',
      profiles: {
        chrome: {
          driver: 'extension',
        },
      },
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  test('keeps the root browser switch stable when the embedded plugin owns the tool', () => {
    expect(buildManagedOpenClawConnectivityConfig(BrowserMode.Embedded).browser).toEqual({
      enabled: true,
      extensionRelay: {
        allowLegacyAuth: false,
      },
      defaultProfile: 'openclaw',
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  test.each(Object.values(AgentRuntimeSessionVisibility))(
    'projects the selected session visibility %s',
    visibility => {
      expect(
        buildManagedOpenClawConnectivityConfig(BrowserMode.Isolated, visibility).tools.sessions,
      ).toEqual({ visibility });
    },
  );
});

describe('OpenClaw managed subagent config', () => {
  test('bounds concurrent runs below the per-parent active child limit', () => {
    expect(buildManagedOpenClawSubagentConfig()).toEqual(
      expect.objectContaining({
        maxConcurrent: 3,
        maxChildrenPerAgent: 5,
      }),
    );
    expect(OPENCLAW_SUBAGENT_MAX_CONCURRENT).toBeGreaterThanOrEqual(1);
    expect(OPENCLAW_SUBAGENT_MAX_CONCURRENT).toBeLessThanOrEqual(
      OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT,
    );
    expect(OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT).toBeLessThanOrEqual(20);
  });

  test('maps user-selected runtime defaults without enabling automatic archive', () => {
    const settings = createDefaultAgentRuntimeSettings();
    settings.subagents = {
      ...settings.subagents,
      delegationMode: AgentRuntimeDelegationMode.Prefer,
      model: 'provider/worker-model',
      thinking: 'high',
      maxConcurrent: 7,
      maxChildrenPerAgent: 9,
      runTimeoutSeconds: 1800,
      maxSpawnDepth: 2,
    };

    expect(buildManagedOpenClawSubagentConfig(settings)).toEqual({
      delegationMode: 'prefer',
      maxSpawnDepth: 2,
      maxChildrenPerAgent: 9,
      maxConcurrent: 7,
      runTimeoutSeconds: 1800,
      archiveAfterMinutes: 0,
      model: 'provider/worker-model',
      thinking: 'high',
    });
  });
});

describe('OpenClaw managed ACP config', () => {
  test('enables the bundled backend for enabled external agents', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.agents.claude.enabled = true;
    settings.agents.codex.enabled = true;

    expect(buildManagedOpenClawAcpConfig(settings)).toEqual({
      enabled: true,
      dispatch: { enabled: true },
      backend: OpenClawExtensionId.ACPX,
      allowedAgents: ['claude', 'codex'],
      defaultAgent: 'claude',
    });
  });

  test('projects build-time adapter definitions into the bundled plugin', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.permissionMode = 'read-only';
    settings.agents.claude.enabled = true;
    settings.agents.codex.enabled = false;

    expect(
      buildManagedAcpxPluginEntry(settings, [
        {
          id: 'claude',
          name: 'Claude',
          descriptionKey: 'externalAgentsClaudeDescription',
          defaultEnabled: false,
          adapter: { command: '${NODE_EXECUTABLE}', args: ['adapter.mjs', '--stdio'] },
        },
      ]),
    ).toEqual({
      enabled: true,
      config: {
        permissionMode: 'approve-reads',
        nonInteractivePermissions: 'deny',
        timeoutSeconds: 120,
        pluginToolsMcpBridge: false,
        openClawToolsMcpBridge: false,
        startupProbe: false,
        diagnosticAgents: ['claude'],
        agents: {
          claude: { command: '${NODE_EXECUTABLE}', args: ['adapter.mjs', '--stdio'] },
        },
      },
    });
  });

  test('publishes every enabled ACP harness as a configured runtime owner', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.agents.claude.enabled = true;
    settings.agents.codex.enabled = true;

    expect(buildManagedExternalAgentEntries('C:/workspace', settings)).toEqual({
      claude: {
        workspace: 'C:/workspace',
        runtime: {
          type: 'acp',
          acp: {
            agent: 'claude',
            backend: OpenClawExtensionId.ACPX,
            cwd: 'C:/workspace',
          },
        },
      },
      codex: {
        workspace: 'C:/workspace',
        runtime: {
          type: 'acp',
          acp: {
            agent: 'codex',
            backend: OpenClawExtensionId.ACPX,
            cwd: 'C:/workspace',
          },
        },
      },
    });
  });

  test('does not inject the embedded Agent model into ACP runtime owners', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.agents.codex.enabled = true;
    const sync = new OpenClawConfigSync({
      getAgents: () => [],
    } as never);

    const result = (
      sync as unknown as {
        buildAgentsEntries: (
          fallback: string,
          available: ReadonlySet<string>,
          workspace: string,
          externalAgentSettings: ReturnType<typeof createDefaultExternalAgentSettings>,
        ) => { entries: Record<string, Record<string, unknown>> };
      }
    ).buildAgentsEntries(
      'custom4/oc/mimo-v2.5',
      new Set(['custom4/oc/mimo-v2.5']),
      'C:/workspace',
      settings,
    );

    expect(result.entries.codex).toMatchObject({
      runtime: {
        type: 'acp',
        acp: { agent: 'codex', backend: OpenClawExtensionId.ACPX },
      },
    });
    expect(result.entries.codex).not.toHaveProperty('model');
  });

  test('reconciles managed ACP runtime owners when an external agent is toggled', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.agents.codex.enabled = true;
    const managedCodex = buildManagedExternalAgentEntries('/managed', settings);
    const staleEntries = {
      main: { workspace: '/existing' },
      codex: {
        runtime: {
          type: 'acp',
          acp: { agent: 'codex', backend: OpenClawExtensionId.ACPX },
        },
      },
    };

    expect(mergeAgentEntriesWithManagedMainSettings(managedCodex, staleEntries)).toEqual({
      main: { workspace: '/existing' },
      ...managedCodex,
    });
    expect(mergeAgentEntriesWithManagedMainSettings({}, staleEntries)).toEqual({
      main: { workspace: '/existing' },
    });
  });

  test('registers native ACP commands without a runtime downloader', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.agents.opencode.enabled = true;

    const pluginEntry = buildManagedAcpxPluginEntry(settings);

    expect(pluginEntry).toEqual({
      enabled: true,
      config: {
        permissionMode: 'approve-reads',
        nonInteractivePermissions: 'deny',
        timeoutSeconds: 120,
        pluginToolsMcpBridge: false,
        openClawToolsMcpBridge: false,
        startupProbe: false,
        diagnosticAgents: ['claude', 'codex', 'opencode', 'deepseek-harness', 'hermes'],
        agents: {
          opencode: { command: 'opencode', args: ['acp'] },
          'deepseek-harness': { command: 'dsh', args: ['--profile', 'acp'] },
          hermes: { command: 'hermes', args: ['acp'] },
        },
      },
    });
    expect(JSON.stringify(pluginEntry)).not.toContain('npx');
  });

  test('keeps the lazy ACPX runtime available for tests while delegation is disabled', () => {
    expect(buildManagedAcpxPluginEntry(createDefaultExternalAgentSettings())).toMatchObject({
      enabled: true,
    });
    expect(buildManagedOpenClawAcpConfig(createDefaultExternalAgentSettings())).toMatchObject({
      enabled: false,
      allowedAgents: [],
    });
  });

  test('projects every permission mode and read-only failure policy into ACPX', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.permissionMode = 'deny-all';
    settings.operationTimeoutSeconds = 300;
    expect(buildManagedAcpxPluginEntry(settings)).toMatchObject({
      config: {
        permissionMode: 'deny-all',
        nonInteractivePermissions: 'deny',
        timeoutSeconds: 300,
      },
    });

    settings.permissionMode = 'read-only';
    settings.readOnlyViolationBehavior = 'fail-task';
    expect(buildManagedAcpxPluginEntry(settings)).toMatchObject({
      config: {
        permissionMode: 'approve-reads',
        nonInteractivePermissions: 'fail',
      },
    });

    settings.permissionMode = 'full-access';
    expect(buildManagedAcpxPluginEntry(settings)).toMatchObject({
      config: {
        permissionMode: 'approve-all',
        nonInteractivePermissions: 'fail',
      },
    });
  });

  test('projects selected tool bridges and enabled stdio MCP servers into ACPX', () => {
    const settings = createDefaultExternalAgentSettings();
    settings.pluginToolsMcpBridge = true;
    settings.openClawToolsMcpBridge = true;
    settings.shareConfiguredMcpServers = true;

    expect(
      buildManagedAcpxPluginEntry(settings, [], [
        {
          id: 'local',
          name: 'workspace-tools',
          description: '',
          enabled: true,
          transportType: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          env: { MODE: 'acp' },
          isBuiltIn: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'remote',
          name: 'remote-tools',
          description: '',
          enabled: true,
          transportType: 'http',
          url: 'https://example.invalid/mcp',
          isBuiltIn: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'reserved',
          name: 'openclaw-tools',
          description: '',
          enabled: true,
          transportType: 'stdio',
          command: 'collision',
          isBuiltIn: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    ).toMatchObject({
      config: {
        pluginToolsMcpBridge: true,
        openClawToolsMcpBridge: true,
        mcpServers: {
          'workspace-tools': {
            command: 'node',
            args: ['server.mjs'],
            env: { MODE: 'acp' },
          },
        },
      },
    });
  });

  test('does not share configured MCP servers until explicitly enabled', () => {
    const settings = createDefaultExternalAgentSettings();
    const entry = buildManagedAcpxPluginEntry(settings, [], [
      {
        id: 'local',
        name: 'workspace-tools',
        description: '',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        isBuiltIn: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(entry).toMatchObject({
      config: {
        pluginToolsMcpBridge: false,
        openClawToolsMcpBridge: false,
      },
    });
    expect((entry.config as Record<string, unknown>).mcpServers).toBeUndefined();
  });
});

describe('OpenClaw managed Agent thinking config', () => {
  test('leaves the OpenClaw model default in effect until the user selects a level', () => {
    expect(buildManagedOpenClawAgentThinkingConfig()).toEqual({});
  });

  test('maps the user-selected level to agents.defaults.thinkingDefault', () => {
    const settings = createDefaultAgentRuntimeSettings();
    settings.agent.thinking = 'high';

    expect(buildManagedOpenClawAgentThinkingConfig(settings)).toEqual({
      thinkingDefault: 'high',
    });
  });
});

describe('OpenClaw managed session retention', () => {
  test('keeps 365-day stale retention while allowing OpenClaw to archive overflow entries', () => {
    expect(buildManagedOpenClawSessionConfig()).toEqual({
      dmScope: 'per-account-channel-peer',
      reset: {
        mode: 'none',
      },
      maintenance: {
        mode: 'enforce',
        pruneAfter: OPENCLAW_SESSION_PRUNE_AFTER,
        maxEntries: OPENCLAW_SESSION_MAX_ENTRIES,
      },
    });
    expect(OPENCLAW_SESSION_PRUNE_AFTER).toBe('365d');
    expect(OPENCLAW_SESSION_MAX_ENTRIES).toBe(500);
  });
});

describe('OpenClaw plugin config merging', () => {
  test.each([undefined, false])(
    'allows memory runtime hooks while preserving explicit disable (%s)',
    enabled => {
      const defaults = buildDefaultOpenClawPluginEntries(
        id => id === OpenClawExtensionId.MEMORY_CORE,
      );
      const existing = {
        allow: ['runtime-services'],
        ...(enabled === false ? { entries: { 'memory-core': { enabled: false } } } : {}),
      };
      const merged = mergeOpenClawPluginConfig(
        applyDefaultOpenClawPluginEntries(existing, defaults),
        {},
        Object.keys(defaults),
      );
      expect(merged.allow).toEqual(['runtime-services', 'memory-core']);
      expect(merged.entries).toEqual({ 'memory-core': { enabled: enabled ?? true } });
      expect(buildDefaultOpenClawPluginEntries(() => false)).toEqual({});
    },
  );

  test('applies a default plugin state without overwriting an explicit user choice', () => {
    const defaults = { [OpenClawExtensionId.WORKBOARD]: { enabled: true } };

    expect(applyDefaultOpenClawPluginEntries({}, defaults)).toEqual({ entries: defaults });
    expect(
      applyDefaultOpenClawPluginEntries(
        { entries: { [OpenClawExtensionId.WORKBOARD]: { enabled: false } } },
        defaults,
      ),
    ).toEqual({ entries: { [OpenClawExtensionId.WORKBOARD]: { enabled: false } } });
  });

  test('removes registrations for extensions that are no longer discoverable', () => {
    expect(
      removeUnavailableOpenClawPluginRegistrations(
        {
          enabled: true,
          load: { paths: ['C:/plugins'] },
          entries: {
            available: { enabled: true },
            unavailable: { enabled: true },
          },
          installs: {
            available: { source: 'npm' },
            removed: { source: 'npm' },
          },
          allow: ['available', 'removed', 'available'],
          deny: ['removed'],
          slots: {
            memory: 'removed',
            contextEngine: 'legacy',
          },
        },
        ['available'],
      ),
    ).toEqual({
      enabled: true,
      load: { paths: ['C:/plugins'] },
      entries: { available: { enabled: true } },
      installs: { available: { source: 'npm' } },
      allow: ['available'],
      slots: { contextEngine: 'legacy' },
    });
  });

  test('uses the available inventory while merging managed extensions', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          entries: {
            existing: { enabled: false },
            removed: { enabled: true },
          },
          allow: ['existing', 'removed'],
        },
        { 'automation-permission': { enabled: true } },
        [],
        ['existing', 'automation-permission'],
      ),
    ).toEqual({
      enabled: true,
      allow: ['existing', 'automation-permission'],
      entries: {
        existing: { enabled: false },
        'automation-permission': { enabled: true },
      },
    });
  });

  test('preserves imported plugin entries and exclusive slots', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          slots: { contextEngine: 'openviking' },
          entries: {
            openviking: { enabled: true, config: { baseUrl: 'http://127.0.0.1:1933' } },
            workboard: { enabled: false },
          },
        },
        { workboard: { enabled: true } },
      ),
    ).toEqual({
      enabled: true,
      slots: { contextEngine: 'openviking' },
      entries: {
        openviking: { enabled: true, config: { baseUrl: 'http://127.0.0.1:1933' } },
        workboard: { enabled: true },
      },
    });
  });

  test('preserves imported plugin config when there are no managed entries', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          slots: { contextEngine: 'openviking' },
          entries: { openviking: { enabled: true } },
        },
        {},
      ),
    ).toEqual({
      slots: { contextEngine: 'openviking' },
      entries: { openviking: { enabled: true } },
    });
  });

  test('removes empty config residue from disabled plugin entries', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          entries: {
            'llm-task': {
              enabled: false,
              llm: {
                allowModelOverride: false,
                allowAuthProfileOverride: false,
              },
              config: {},
            },
          },
        },
        {},
      ),
    ).toEqual({
      entries: {
        'llm-task': {
          enabled: false,
          llm: {
            allowModelOverride: false,
            allowAuthProfileOverride: false,
          },
        },
      },
    });
  });

  test('preserves non-empty config on disabled plugin entries', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          entries: {
            configurable: {
              enabled: false,
              config: { endpoint: 'http://127.0.0.1:1933' },
            },
          },
        },
        {},
      ),
    ).toEqual({
      entries: {
        configurable: {
          enabled: false,
          config: { endpoint: 'http://127.0.0.1:1933' },
        },
      },
    });
  });
});

describe('OpenClaw managed speech config', () => {
  test('preserves Gateway-owned online TTS when no local provider is active', () => {
    const onlineTts = {
      provider: 'openai',
      providers: {
        openai: {
          baseUrl: 'http://speech.internal:8000/v1',
          model: 'internal-tts',
          voice: 'speaker-1',
        },
      },
    };

    expect(resolveManagedOpenClawTtsConfig({ tts: onlineTts }, null)).toBe(onlineTts);
  });

  test('activates a local provider without discarding retained online TTS', () => {
    const localTts = {
      provider: 'tts-local-cli',
      providers: { 'tts-local-cli': { command: 'tts.exe' } },
    };

    expect(
      resolveManagedOpenClawTtsConfig(
        { tts: { provider: 'openai', providers: { openai: { model: 'tts-1' } } } },
        localTts,
        { enabled: true, mode: 'local' },
      ),
    ).toEqual({
      provider: 'tts-local-cli',
      providers: {
        openai: { model: 'tts-1' },
        'tts-local-cli': { command: 'tts.exe' },
      },
    });
  });

  test('disables retained Gateway TTS when response reading is turned off', () => {
    expect(
      resolveManagedOpenClawTtsConfig(
        { tts: { enabled: true, provider: 'openai' } },
        null,
        { enabled: false, mode: 'online' },
      ),
    ).toEqual({ enabled: false, provider: 'openai' });
  });

  test.each(['tts-local-cli', 'openai', 'elevenlabs'])(
    'enables the active %s speech provider plugin',
    provider => {
      expect(buildManagedOpenClawTtsPluginEntries({ provider })).toEqual({
        [provider]: { enabled: true },
      });
    },
  );

  test('does not enable an unknown speech provider plugin', () => {
    expect(buildManagedOpenClawTtsPluginEntries({ provider: 'unknown' })).toEqual({});
  });

  test('retains the legacy transcription bridge while it contains an online provider', () => {
    const voiceCall = {
      config: {
        streaming: {
          provider: 'openai',
          providers: { openai: { baseUrl: 'http://speech.internal:8000' } },
        },
      },
    };
    expect(buildManagedOnlineAsrPluginEntries({ entries: { 'voice-call': voiceCall } })).toEqual({
      'voice-call': voiceCall,
    });
  });
});

describe('OpenClaw skill config merging', () => {
  test.each(['auto', 'propose', 'off'])('preserves explicit skill automation mode %s', mode => {
    const skills = { workshop: { autonomous: { mode, custom: true }, custom: true } };
    expect(mergeOpenClawSkillConfig(skills, {})).toEqual(skills);
  });
  test('defaults automation off without losing workshop preferences', () => {
    expect(mergeOpenClawSkillConfig({ workshop: { autonomous: { custom: true } } }, {}))
      .toEqual({ workshop: { autonomous: { mode: 'off', custom: true } } });
  });
  test('preserves disabled skills and custom load directories', () => {
    expect(
      mergeOpenClawSkillConfig(
        {
          load: { extraDirs: ['C:/skills'] },
          entries: {
            docx: { enabled: false },
            pdf: { enabled: true, env: { PDF_RENDERER: 'local' } },
          },
        },
        {},
      ),
    ).toEqual({
      workshop: { autonomous: { mode: 'off' } },
      load: { extraDirs: ['C:/skills'] },
      entries: {
        docx: { enabled: false },
        pdf: { enabled: true, env: { PDF_RENDERER: 'local' } },
      },
    });
  });

  test('overrides only fields explicitly managed by JustDo', () => {
    expect(
      mergeOpenClawSkillConfig(
        {
          load: { extraDirs: ['C:/skills'], watch: true },
          entries: { docx: { enabled: false } },
        },
        {
          load: { watch: false },
        },
      ),
    ).toEqual({
      workshop: { autonomous: { mode: 'off' } },
      load: { extraDirs: ['C:/skills'], watch: false },
      entries: { docx: { enabled: false } },
    });
  });

  test('applies managed prompt limits while preserving other skill limits', () => {
    expect(
      mergeOpenClawSkillConfig(
        {
          limits: {
            maxCandidatesPerRoot: 500,
            maxSkillsLoadedPerSource: 300,
            maxSkillsInPrompt: 150,
            maxSkillsPromptChars: 18_000,
          },
        },
        {
          limits: {
            maxSkillsInPrompt: OPENCLAW_MAX_SKILLS_IN_PROMPT,
            maxSkillsPromptChars: OPENCLAW_MAX_SKILLS_PROMPT_CHARS,
          },
        },
      ),
    ).toEqual({
      workshop: { autonomous: { mode: 'off' } },
      limits: {
        maxCandidatesPerRoot: 500,
        maxSkillsLoadedPerSource: 300,
        maxSkillsInPrompt: 200,
        maxSkillsPromptChars: 50_000,
      },
    });
  });

  test('pins app-installed extensions in the plugin allowlist', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          entries: { existing: { enabled: false } },
          allow: ['existing-trusted'],
        },
        { 'automation-permission': { enabled: true } },
        ['justdo-skill-only-example', 'justdo-skill-only-example'],
      ),
    ).toEqual({
      enabled: true,
      allow: [
        'existing-trusted',
        'justdo-skill-only-example',
        'automation-permission',
      ],
      entries: {
        existing: { enabled: false },
        'automation-permission': { enabled: true },
      },
    });
  });

  test('adds managed bundled entries to an existing allowlist', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          allow: ['workboard'],
        },
        {
          'automation-permission': {
            enabled: true,
            config: { approvalTimeoutMinutes: 2 },
          },
        },
      ),
    ).toEqual({
      enabled: true,
      allow: ['workboard', 'automation-permission'],
      entries: {
        'automation-permission': {
          enabled: true,
          config: { approvalTimeoutMinutes: 2 },
        },
      },
    });
  });

  test('adds managed bundled entries when installed extensions create an allowlist', () => {
    expect(
      mergeOpenClawPluginConfig(
        {},
        {
          'automation-permission': { enabled: true },
          workboard: { enabled: true },
        },
        ['installed-extension'],
      ),
    ).toMatchObject({
      allow: ['installed-extension', 'automation-permission', 'workboard'],
    });
  });
});


describe('optional agent-team configuration', () => {
  test.each([true, false])('preserves the user enabled=%s choice during config sync', enabled => {
    const result = mergeOpenClawPluginConfig(
      applyDefaultOpenClawPluginEntries({ entries: { 'agent-team': { enabled } } },
        { 'agent-team': { enabled: false } }),
      { 'runtime-services': { enabled: true } }, ['agent-team'],
    );
    expect(result.entries).toMatchObject({ 'agent-team': { enabled } });
  });
  test('defaults to disabled without affecting the required history service', () => {
    const result = mergeOpenClawPluginConfig(
      applyDefaultOpenClawPluginEntries({}, { 'agent-team': { enabled: false } }),
      { 'runtime-services': { enabled: true } }, ['agent-team'],
    );
    expect(result.entries).toEqual({ 'agent-team': { enabled: false }, 'runtime-services': { enabled: true } });
  });
});


test('preserves user scheduler settings across managed config synchronization', () => {
  expect(buildManagedOpenClawCronConfig(undefined)).toEqual({
    enabled: true,
    skipMissedJobs: true,
    sessionRetention: '7d',
  });
  const existing = { enabled: false, sessionRetention: false, skipMissedJobs: true, failureAlert: { after: 5 } };
  expect(buildManagedOpenClawCronConfig(existing)).toEqual(existing);
  expect(buildManagedOpenClawCronConfig({ sessionRetention: '1h30m' }).sessionRetention).toBe('1h30m');
});

test('disables missed-job catch-up by default while preserving an explicit opt-in', () => {
  expect(buildManagedOpenClawCronConfig({ enabled: true }).skipMissedJobs).toBe(true);
  expect(buildManagedOpenClawCronConfig({ skipMissedJobs: false }).skipMissedJobs).toBe(false);
});

  test.each([OpenClawExtensionId.CODE_MODE_QUICKJS, OpenClawExtensionId.GITHUB])('retains %s in explicit allowlists while preserving disable', id => {
    const defaults = buildDefaultOpenClawPluginEntries(candidate => candidate === id);
    const merged = mergeOpenClawPluginConfig(
      applyDefaultOpenClawPluginEntries({ allow: [], entries: { [id]: { enabled: false } } }, defaults),
      {}, Object.keys(defaults),
    );
    expect(merged.allow).toContain(id);
    expect(merged.entries).toEqual({ [id]: { enabled: false } });
  });
