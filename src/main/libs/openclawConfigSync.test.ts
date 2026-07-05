import { describe, expect, test } from 'vitest';

import {
  OpenClawApi,
  OpenClawProviderId,
  ProviderName,
  ProviderRegistry,
} from '../../shared/providers';

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
