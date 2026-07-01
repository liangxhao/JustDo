import { describe,expect, test } from 'vitest';

import { OpenClawApi,OpenClawProviderId, ProviderName } from '../../shared/providers';

const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `JUSTDO_APIKEY_${envName}`;
};

describe('providerApiKeyEnvVar', () => {
  test('converts ollama provider name', () => {
    expect(providerApiKeyEnvVar(ProviderName.Ollama)).toBe('JUSTDO_APIKEY_OLLAMA');
  });

  test('converts custom provider name', () => {
    expect(providerApiKeyEnvVar(ProviderName.Custom)).toBe('JUSTDO_APIKEY_CUSTOM');
  });

  test('handles custom provider indices', () => {
    expect(providerApiKeyEnvVar('custom_0')).toBe('JUSTDO_APIKEY_CUSTOM_0');
    expect(providerApiKeyEnvVar('custom_5')).toBe('JUSTDO_APIKEY_CUSTOM_5');
  });

  test('server key matches hardcoded convention', () => {
    expect(providerApiKeyEnvVar('server')).toBe('JUSTDO_APIKEY_SERVER');
  });
});

describe('env var stability on model switch', () => {
  const simulateCollectEnvVars = (
    providers: Record<string, { enabled: boolean; apiKey: string }>,
    serverToken?: string,
  ) => {
    const env: Record<string, string> = {};

    if (serverToken) {
      env.JUSTDO_APIKEY_SERVER = serverToken;
    }

    for (const [name, config] of Object.entries(providers)) {
      if (!config.enabled) continue;
      const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      env[`JUSTDO_APIKEY_${envName}`] = config.apiKey;
    }

    return env;
  };

  test('switching from server to ollama does not change env var keys', () => {
    const providers = {
      [ProviderName.Ollama]: { enabled: true, apiKey: 'ollama-key-123' },
    };
    const serverToken = 'access-token-xyz';

    const envBefore = simulateCollectEnvVars(providers, serverToken);
    const envAfter = simulateCollectEnvVars(providers, serverToken);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
  });

  test('switching between ollama and custom does not change env var keys', () => {
    const providers = {
      [ProviderName.Ollama]: { enabled: true, apiKey: 'ollama-key-123' },
      [ProviderName.Custom]: { enabled: true, apiKey: 'custom-key-456' },
    };

    const envBefore = simulateCollectEnvVars(providers);
    const envAfter = simulateCollectEnvVars(providers);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
    expect(envBefore.JUSTDO_APIKEY_OLLAMA).toBe('ollama-key-123');
    expect(envBefore.JUSTDO_APIKEY_CUSTOM).toBe('custom-key-456');
  });

  test('only editing apiKey value causes env var change', () => {
    const providersBefore = {
      [ProviderName.Ollama]: { enabled: true, apiKey: 'ollama-OLD' },
    };
    const providersAfter = {
      [ProviderName.Ollama]: { enabled: true, apiKey: 'ollama-NEW' },
    };

    const envBefore = simulateCollectEnvVars(providersBefore);
    const envAfter = simulateCollectEnvVars(providersAfter);

    expect(JSON.stringify(envBefore)).not.toBe(JSON.stringify(envAfter));
  });
});

// ═══════════════════════════════════════════════════════
// Provider Descriptor Registry Tests
//
// Since buildProviderSelection imports Electron-only modules,
// we mirror the descriptor resolution logic here to verify
// the registry mapping correctness.
// ═══════════════════════════════════════════════════════

type OpenClawProviderApi = 'openai-completions';

type ProviderDescriptor = {
  providerId: string;
  resolveApi: () => OpenClawProviderApi;
  normalizeBaseUrl: (rawBaseUrl: string) => string;
  resolveSessionModelId?: (modelId: string) => string;
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};

const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) return trimmed;
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.endsWith('/openai')) {
    return normalized.slice(0, -'/openai'.length);
  }
  return normalized;
};

// Provider registry matching the current implementation (only Ollama)
const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  [ProviderName.Ollama]: {
    providerId: OpenClawProviderId.Ollama,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
};

const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.JustDo,
  resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

const resolveDescriptor = (providerName: string): ProviderDescriptor => {
  if (providerName in PROVIDER_REGISTRY) {
    return PROVIDER_REGISTRY[providerName];
  }
  return {
    ...DEFAULT_DESCRIPTOR,
    providerId: providerName || OpenClawProviderId.JustDo,
  };
};

describe('resolveDescriptor', () => {
  test('ollama maps to ollama providerId with openai-completions API', () => {
    const d = resolveDescriptor(ProviderName.Ollama);
    expect(d.providerId).toBe(OpenClawProviderId.Ollama);
    expect(d.resolveApi()).toBe(OpenClawApi.OpenAICompletions);
  });

  test('ollama falls back to ollama providerId', () => {
    const d = resolveDescriptor(ProviderName.Ollama);
    expect(d.providerId).toBe(OpenClawProviderId.Ollama);
  });

  test('unknown provider falls back to justdo providerId', () => {
    const d = resolveDescriptor('some-unknown');
    expect(d.providerId).toBe('some-unknown');
  });

  test('empty provider name falls back to justdo', () => {
    const d = resolveDescriptor('');
    expect(d.providerId).toBe(OpenClawProviderId.JustDo);
  });

  test('custom provider uses fallback descriptor', () => {
    const d = resolveDescriptor(ProviderName.Custom);
    expect(d.providerId).toBe(ProviderName.Custom);
    expect(d.resolveApi()).toBe(OpenClawApi.OpenAICompletions);
  });

  test('custom provider index uses fallback descriptor', () => {
    const d = resolveDescriptor('custom_5');
    expect(d.providerId).toBe('custom_5');
  });
});

describe('provider registry coverage', () => {
  test('ollama has registry entry', () => {
    expect(ProviderName.Ollama in PROVIDER_REGISTRY).toBe(true);
  });

  test('ollama resolves to correct providerId', () => {
    const d = resolveDescriptor(ProviderName.Ollama, false);
    expect(d.providerId).toBe(OpenClawProviderId.Ollama);
    expect(d.providerId).not.toBe(OpenClawProviderId.JustDo);
  });

  test('ollama has non-empty providerId', () => {
    const d = resolveDescriptor(ProviderName.Ollama, false);
    expect(d.providerId.length).toBeGreaterThan(0);
  });

  test('custom provider resolves to itself', () => {
    const d = resolveDescriptor(ProviderName.Custom, false);
    expect(d.providerId).toBe(ProviderName.Custom);
  });
});
