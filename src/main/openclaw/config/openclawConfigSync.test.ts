import { describe, expect, test } from 'vitest';

import { BrowserMode } from '../../../shared/browser';
import {
  AgentRuntimeDelegationMode,
  createDefaultAgentRuntimeSettings,
} from '../../../shared/openclaw/agentRuntimeSettings';
import { PermissionMode } from '../../../shared/openclaw/approvals';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import {
  OpenClawApi,
  OpenClawProviderId,
  ProviderName,
  ProviderRegistry,
} from '../../../shared/providers';
import type { ProviderRawConfig } from '../../cowork/providerApiConfig';
import {
  applyManagedOpenClawHeartbeatConfig,
  buildBuiltinMemorySearchConfig,
  buildManagedOpenClawAgentThinkingConfig,
  buildManagedOpenClawCompactionConfig,
  buildManagedOpenClawConnectivityConfig,
  buildManagedOpenClawHeartbeatConfig,
  buildManagedOpenClawSessionConfig,
  buildManagedOpenClawSubagentConfig,
  buildOpenClawConfigMeta,
  buildProviderSelection,
  hasOpenClawConfigChanged,
  mergeOpenClawPluginConfig,
  mergeOpenClawSkillConfig,
  OPENCLAW_MAX_SKILLS_IN_PROMPT,
  OPENCLAW_MAX_SKILLS_PROMPT_CHARS,
  OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS,
  OPENCLAW_SESSION_MAX_ENTRIES,
  OPENCLAW_SESSION_PRUNE_AFTER,
  OPENCLAW_STUCK_SESSION_ABORT_MS,
  OPENCLAW_STUCK_SESSION_WARN_MS,
  OPENCLAW_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  OPENCLAW_SUBAGENT_MAX_CONCURRENT,
  removeUnavailableOpenClawPluginRegistrations,
  resolveFileToolsWorkspaceOnly,
  resolvePermissionPolicy,
} from './openclawConfigSync';

const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `JUSTDO_APIKEY_${envName}`;
};

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

describe('provider API key environment variables', () => {
  test('normalizes custom provider identifiers', () => {
    expect(providerApiKeyEnvVar(ProviderName.Custom)).toBe('JUSTDO_APIKEY_CUSTOM');
    expect(providerApiKeyEnvVar('custom_5')).toBe('JUSTDO_APIKEY_CUSTOM_5');
    expect(providerApiKeyEnvVar('my-provider')).toBe('JUSTDO_APIKEY_MY_PROVIDER');
  });

  test('uses the server environment variable convention', () => {
    expect(providerApiKeyEnvVar('server')).toBe('JUSTDO_APIKEY_SERVER');
  });
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
        apiKey: 'sk-local',
        apiType: 'openai',
        models: [{ id: 'chat-model' }],
        embeddingModels: [{ id: 'embedding-z' }, { id: 'embedding-a' }],
      },
    ];

    expect(buildBuiltinMemorySearchConfig(providers)).toEqual({
      enabled: true,
      provider: OpenClawExtensionId.JUSTDO_RUNTIME_BRIDGE,
      model: 'embedding-a',
      remote: {
        baseUrl: 'http://127.0.0.1:4000/v1',
        apiKey: '${JUSTDO_APIKEY_BUILTIN_MODELS}',
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

  test('enables streaming usage metadata for every generated model', () => {
    const selection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.example.com/v1',
      modelId: 'usage-aware-model',
      apiType: 'openai',
      providerName: 'custom_0',
    });

    expect(selection.providerConfig.models).toHaveLength(1);
    expect(selection.providerConfig.models[0]?.compat).toEqual({
      supportsUsageInStreaming: true,
    });
  });

  test('sets a provider idle timeout above the OpenClaw default', () => {
    const selection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.example.com/v1',
      modelId: 'deepseek-v4-flash',
      apiType: 'openai',
      providerName: ProviderName.Custom,
    });

    expect(selection.providerConfig.timeoutSeconds).toBe(OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS);
    expect(selection.providerConfig.timeoutSeconds).toBeGreaterThan(120);
  });

  test('keeps stalled-session recovery slower than long model calls', () => {
    expect(OPENCLAW_STUCK_SESSION_WARN_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(OPENCLAW_STUCK_SESSION_ABORT_MS).toBeGreaterThan(
      OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS * 1000,
    );
  });
});

describe('OpenClaw managed config metadata', () => {
  test('stamps metadata so gateway config recovery accepts JustDo writes', () => {
    const meta = buildOpenClawConfigMeta(
      '2026.6.11',
      new Date('2026-07-13T03:27:00.677Z'),
    );

    expect(meta).toEqual({
      lastTouchedVersion: '2026.6.11',
      lastTouchedAt: '2026-07-13T03:27:00.677Z',
    });
  });

  test('does not treat a refreshed metadata timestamp as a config change', () => {
    const currentContent = JSON.stringify({
      gateway: { mode: 'local' },
      meta: {
        lastTouchedVersion: '2026.6.11',
        lastTouchedAt: '2026-07-13T03:27:00.677Z',
      },
    });
    const nextConfig = {
      meta: {
        lastTouchedAt: '2026-07-23T07:37:34.681Z',
        lastTouchedVersion: '2026.6.11',
      },
      gateway: { mode: 'local' },
    };

    expect(hasOpenClawConfigChanged(currentContent, nextConfig)).toBe(false);
  });

  test('detects substantive config and version changes', () => {
    const currentContent = JSON.stringify({
      gateway: { mode: 'local' },
      meta: {
        lastTouchedVersion: '2026.6.11',
        lastTouchedAt: '2026-07-13T03:27:00.677Z',
      },
    });

    expect(
      hasOpenClawConfigChanged(currentContent, {
        gateway: { mode: 'remote' },
        meta: {
          lastTouchedVersion: '2026.6.11',
          lastTouchedAt: '2026-07-23T07:37:34.681Z',
        },
      }),
    ).toBe(true);
    expect(
      hasOpenClawConfigChanged(currentContent, {
        gateway: { mode: 'local' },
        meta: {
          lastTouchedVersion: '2026.7.1',
          lastTouchedAt: '2026-07-23T07:37:34.681Z',
        },
      }),
    ).toBe(true);
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
  test('enables heartbeat wake-ups without injecting heartbeat instructions', () => {
    expect(buildManagedOpenClawHeartbeatConfig()).toEqual({
      every: '2h',
      includeSystemPromptSection: false,
    });
  });

  test('enables managed heartbeat only for the main agent', () => {
    expect(applyManagedOpenClawHeartbeatConfig({ id: 'main', default: true })).toEqual({
      id: 'main',
      default: true,
      heartbeat: {
        every: '2h',
        includeSystemPromptSection: false,
      },
    });
    expect(applyManagedOpenClawHeartbeatConfig({ id: 'researcher' })).toEqual({
      id: 'researcher',
    });
  });
});

describe('OpenClaw permission policy', () => {
  test.each([
    [
      PermissionMode.Ask,
      { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
    ],
    [
      PermissionMode.Auto,
      { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
    ],
    [PermissionMode.Full, { security: 'full', ask: 'off', askFallback: 'full' }],
  ])('maps %s to the matching host approval policy', (mode, expected) => {
    expect(resolvePermissionPolicy(mode)).toEqual(expected);
  });

  test.each([
    [PermissionMode.Ask, true],
    [PermissionMode.Auto, true],
    [PermissionMode.Full, false],
  ])('maps %s to workspace-only file tools=%s', (mode, expected) => {
    expect(resolveFileToolsWorkspaceOnly(mode)).toBe(expected);
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
        experimental: {
          planTool: true,
        },
      toolSearch: {
        enabled: true,
        mode: 'directory',
      },
        deny: [
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
      defaultProfile: 'user',
      profiles: {
        user: {
          driver: 'existing-session',
          attachOnly: true,
          color: '#00AA00',
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
      defaultProfile: 'chrome',
      profiles: {
        chrome: {
          driver: 'extension',
          color: '#FF4500',
        },
      },
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });
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
  test('retains sessions for at most one year and caps the store at 500 entries', () => {
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
  test('removes registrations for extensions that are no longer discoverable', () => {
    expect(
      removeUnavailableOpenClawPluginRegistrations(
        {
          enabled: true,
          load: { paths: ['C:/plugins'] },
          entries: {
            available: { enabled: true },
            'file-permission-policy': { enabled: true },
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
        { 'action-approval': { enabled: true } },
        [],
        ['existing', 'action-approval'],
      ),
    ).toEqual({
      enabled: true,
      allow: ['existing', 'action-approval'],
      bundledDiscovery: 'compat',
      entries: {
        existing: { enabled: false },
        'action-approval': { enabled: true },
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
});

describe('OpenClaw skill config merging', () => {
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
      limits: {
        maxCandidatesPerRoot: 500,
        maxSkillsLoadedPerSource: 300,
        maxSkillsInPrompt: 200,
        maxSkillsPromptChars: 50_000,
      },
    });
  });

  test('pins app-installed extensions while preserving bundled plugin discovery', () => {
    expect(
      mergeOpenClawPluginConfig(
        {
          entries: { existing: { enabled: false } },
          allow: ['existing-trusted'],
        },
        { 'action-approval': { enabled: true } },
        ['justdo-skill-only-example', 'justdo-skill-only-example'],
      ),
    ).toEqual({
      enabled: true,
      allow: [
        'existing-trusted',
        'justdo-skill-only-example',
        'action-approval',
      ],
      bundledDiscovery: 'compat',
      entries: {
        existing: { enabled: false },
        'action-approval': { enabled: true },
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
          'ask-user-question': {
            enabled: true,
            config: { callbackUrl: 'http://127.0.0.1:43127/askuser' },
          },
        },
      ),
    ).toEqual({
      allow: ['workboard', 'ask-user-question'],
      bundledDiscovery: 'compat',
      entries: {
        'ask-user-question': {
          enabled: true,
          config: { callbackUrl: 'http://127.0.0.1:43127/askuser' },
        },
      },
    });
  });

  test('adds managed bundled entries when installed extensions create an allowlist', () => {
    expect(
      mergeOpenClawPluginConfig(
        {},
        {
          'ask-user-question': { enabled: true },
          workboard: { enabled: true },
        },
        ['installed-extension'],
      ),
    ).toMatchObject({
      allow: ['installed-extension', 'ask-user-question', 'workboard'],
      bundledDiscovery: 'compat',
    });
  });
});
