import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { NATIVE_VIDEO_PROVIDERS } from '../../../shared/providers/nativeVideoProviders';
import { t } from '../../core/i18n';
import {
  applyNativeVideoConfiguration,
  captureNativeVideoConfiguration,
  resolveNativeVideoSelection,
} from './nativeVideoModelConfig';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach(directory => fs.rmSync(directory, { recursive: true, force: true })),
);

test.each(NATIVE_VIDEO_PROVIDERS)(
  'projects $id video via native provider and restricted SecretRef',
  provider => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-video-'));
    directories.push(stateDir);
    const category = {
      defaultProviderId: 'selected',
      providers: {
        selected: {
          nativeVideoProvider: provider.id,
          baseUrl: provider.baseUrl,
          apiKey: 'video-test-secret',
          defaultModel: provider.models[0],
        },
      },
    };
    const selection = resolveNativeVideoSelection(category);
    const config: Record<string, unknown> = {
      agents: { defaults: { model: 'chat/model' } },
      plugins: { allow: ['other'], deny: [provider.id], entries: { other: { enabled: false } } },
    };
    expect(applyNativeVideoConfiguration(config, selection, stateDir, [provider.id])).toBe(true);
    expect(config).toMatchObject({
      agents: {
        defaults: {
          model: 'chat/model',
          mediaModels: { video: { primary: `${provider.id}/${provider.models[0]}` } },
        },
      },
      models: {
        providers: { [provider.id]: { apiKey: { source: 'file' }, baseUrl: provider.baseUrl } },
      },
      plugins: {
        allow: ['other', provider.id],
        deny: [],
        entries: { [provider.id]: { enabled: true }, other: { enabled: false } },
      },
    });
    expect(JSON.stringify(config)).not.toContain('video-test-secret');
    expect(fs.readFileSync(path.join(stateDir, 'extension-secrets.json'), 'utf8')).toContain(
      'video-test-secret',
    );
    expect(applyNativeVideoConfiguration(config, selection, stateDir, [provider.id])).toBe(false);
    expect(resolveNativeVideoSelection({ ...category, defaultProviderId: undefined })).toBeNull();
    applyNativeVideoConfiguration(config, null, stateDir, [provider.id]);
    expect(config).toMatchObject({
      agents: { defaults: { mediaModels: {} } },
      plugins: { entries: { [provider.id]: { enabled: true } } },
    });
  },
);

test('rejects unsupported video providers and restores unmanaged settings after rollback', () => {
  expect(() =>
    resolveNativeVideoSelection({ providers: { legacy: { apiKey: 'retained' } } }),
  ).toThrow(t('nativeVideoConfigurationInvalid'));
  expect(resolveNativeVideoSelection(undefined)).toBeUndefined();
  expect(resolveNativeVideoSelection({ providers: {} })).toBeUndefined();
  const config = {
    agents: { defaults: { mediaModels: { video: 'custom/video' } } },
    models: { providers: { kie: { apiKey: 'pre-existing' } } },
    plugins: { allow: ['other'], deny: ['kie'] },
  };
  const restore = captureNativeVideoConfiguration(config);
  const next: Record<string, unknown> = {
    agents: { defaults: { model: 'chat/model', mediaModels: { video: 'kie/changed' } } },
    plugins: { allow: ['other', 'kie'], deny: [] },
  };
  restore(next);
  expect(next).toMatchObject({
    agents: { defaults: { model: 'chat/model', mediaModels: { video: 'custom/video' } } },
    models: { providers: { kie: { apiKey: 'pre-existing' } } },
    plugins: { allow: ['other'], deny: ['kie'] },
  });
});

test.each(NATIVE_VIDEO_PROVIDERS)('does not publish credentials or enable missing $id video plugins', provider => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-native-video-'));
  directories.push(stateDir);
  const selection = resolveNativeVideoSelection({ defaultProviderId: 'selected', providers: {
    selected: { nativeVideoProvider: provider.id, baseUrl: provider.baseUrl, apiKey: 'unused-secret', defaultModel: provider.models[0] },
  } });
  const config: Record<string, unknown> = {
    agents: { defaults: { model: 'chat/model', mediaModels: { video: `${provider.id}/old`, image: 'custom/image' } } },
    models: { providers: { [provider.id]: { apiKey: 'existing-chat-key' } } },
    plugins: { allow: ['other', provider.id], deny: [provider.id], entries: { [provider.id]: { enabled: true }, other: { enabled: true } } },
  };
  expect(applyNativeVideoConfiguration(config, selection, stateDir, ['other'])).toBe(false);
  expect(config).toEqual({
    agents: { defaults: { model: 'chat/model', mediaModels: { image: 'custom/image' } } },
    models: { providers: { [provider.id]: { apiKey: 'existing-chat-key' } } },
    plugins: { allow: ['other'], deny: [], entries: { other: { enabled: true } } },
  });
  expect(fs.existsSync(path.join(stateDir, 'extension-secrets.json'))).toBe(false);
});

test('cleans unavailable video fallbacks without a managed selection and preserves uncertain inventory', () => {
  const config: Record<string, unknown> = {
    agents: { defaults: { mediaModels: { video: { primary: 'custom/video', fallbacks: ['kie/model', 'other/video'] } } } },
    plugins: { entries: { kie: { enabled: true } } },
  };
  const original = structuredClone(config);
  expect(applyNativeVideoConfiguration(config, undefined, os.tmpdir(), null)).toBe(false);
  expect(config).toEqual(original);
  applyNativeVideoConfiguration(config, undefined, os.tmpdir(), ['custom', 'other']);
  expect(config).toMatchObject({
    agents: { defaults: { mediaModels: { video: { primary: 'custom/video', fallbacks: ['other/video'] } } } },
    plugins: { entries: {} },
  });
});

test('retains the available video fallback and transport options when the primary plugin is missing', () => {
  const config: Record<string, unknown> = {
    agents: { defaults: { mediaModels: { video: {
      primary: 'kie/model', fallbacks: ['novita/model', 'custom/internal-video', 'other/video'], timeoutMs: 60000,
    } } } },
  };
  applyNativeVideoConfiguration(config, undefined, os.tmpdir(), ['custom', 'other']);
  expect(config).toMatchObject({ agents: { defaults: { mediaModels: { video: {
    primary: 'custom/internal-video', fallbacks: ['other/video'], timeoutMs: 60000,
  } } } } });
});

test.each([
  { nativeVideoProvider: 'openai' },
  {
    nativeVideoProvider: 'kie',
    defaultModel: 'unregistered',
    apiKey: 'key',
    baseUrl: 'https://api.kie.ai',
  },
  {
    nativeVideoProvider: 'kie',
    defaultModel: 'kling-2.6/text-to-video',
    apiKey: '',
    baseUrl: 'https://api.kie.ai',
  },
  {
    nativeVideoProvider: 'kie',
    defaultModel: 'kling-2.6/text-to-video',
    apiKey: 'key',
    baseUrl: 'https://user:password@api.kie.ai',
  },
])('rejects invalid native video settings in Main', selected => {
  expect(() =>
    resolveNativeVideoSelection({ defaultProviderId: 'selected', providers: { selected } }),
  ).toThrow();
});

test('translates malformed video service URLs instead of leaking URL parser errors', () => {
  expect(() =>
    resolveNativeVideoSelection({
      defaultProviderId: 'native',
      providers: {
        native: {
          nativeVideoProvider: 'kie',
          defaultModel: 'kling-2.6/text-to-video',
          apiKey: 'test-key',
          baseUrl: 'not a URL',
        },
      },
    }),
  ).toThrow(t('nativeVideoUrlInvalid'));
});
