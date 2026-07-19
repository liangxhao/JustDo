import { describe, expect, test } from 'vitest';

import {
  OpenClawApi,
  OpenClawProviderId,
  ProviderName,
  ProviderRegistry,
} from '../../../shared/providers';
import type { ProviderRawConfig } from '../../cowork/providerApiConfig';
import {
  buildBuiltinMemorySearchConfig,
  buildOpenClawConfigMeta,
  buildProviderSelection,
  mergeOpenClawPluginConfig,
  OPENCLAW_MODEL_PROVIDER_TIMEOUT_SECONDS,
  OPENCLAW_STUCK_SESSION_ABORT_MS,
  OPENCLAW_STUCK_SESSION_WARN_MS,
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
      provider: OpenClawProviderId.BuiltinModels,
      model: 'embedding-a',
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
});

describe('OpenClaw plugin config merging', () => {
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
