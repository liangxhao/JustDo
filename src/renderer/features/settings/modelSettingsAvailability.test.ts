import { describe, expect, test } from 'vitest';

import { getModelActionAvailability } from './modelSettingsAvailability';

describe('getModelActionAvailability', () => {
  test.each([
    ['', 'key'],
    ['https://api.example.com/v1', ''],
    ['   ', 'key'],
  ])('disables custom model actions when credentials are incomplete', (baseUrl, apiKey) => {
    expect(
      getModelActionAvailability({
        requiresCredentials: true,
        baseUrl,
        apiKey,
        modelCount: 1,
        busy: false,
      }),
    ).toEqual({
      credentialsReady: false,
      canManageModels: false,
      canTestConnection: false,
    });
  });

  test('requires a model before enabling connection testing', () => {
    expect(
      getModelActionAvailability({
        requiresCredentials: true,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'key',
        modelCount: 0,
        busy: false,
      }),
    ).toEqual({
      credentialsReady: true,
      canManageModels: true,
      canTestConnection: false,
    });
  });

  test('disables all actions while another model request is running', () => {
    expect(
      getModelActionAvailability({
        requiresCredentials: true,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'key',
        modelCount: 2,
        busy: true,
      }),
    ).toEqual({
      credentialsReady: true,
      canManageModels: false,
      canTestConnection: false,
    });
  });

  test('does not require user credentials for a built-in provider', () => {
    expect(
      getModelActionAvailability({
        requiresCredentials: false,
        baseUrl: '',
        apiKey: '',
        modelCount: 1,
        busy: false,
      }).canTestConnection,
    ).toBe(true);
  });
});
