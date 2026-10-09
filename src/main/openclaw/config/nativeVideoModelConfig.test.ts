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

test.each(NATIVE_VIDEO_PROVIDERS.filter(provider => !provider.customModel))(
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
  expect(resolveNativeVideoSelection({ providers: {} })).toBeNull();
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

test.each(NATIVE_VIDEO_PROVIDERS.filter(provider => !provider.customModel))('does not publish credentials or enable missing $id video plugins', provider => {
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

test('deleting the last configured video provider clears its native default without disabling plugins', () => {
  const config: Record<string, unknown> = {
    agents: { defaults: { model: 'chat/model', mediaModels: {
      video: { primary: 'video-openai/video-v1', fallbacks: [] }, image: 'image/model',
    } } },
    plugins: { entries: { 'video-openai': { enabled: true } } },
  };
  applyNativeVideoConfiguration(config, resolveNativeVideoSelection({ providers: {} }), os.tmpdir(), ['video-openai']);
  expect(config).toEqual({
    agents: { defaults: { model: 'chat/model', mediaModels: { image: 'image/model' } } },
    plugins: { entries: { 'video-openai': { enabled: true } } },
  });
});

test.each([null, [], 'invalid', {}, { providers: null }, { providers: [] }, { providers: 'invalid' }, { providers: {}, defaultProviderId: 'missing' }, { providers: {}, defaultProviderId: 123 }])(
  'rejects malformed video categories rather than treating them as an explicit clear: %j', value => {
    expect(() => resolveNativeVideoSelection(value)).toThrow(t('nativeVideoConfigurationInvalid'));
  },
);

test('configures an intranet model with isolated credentials and private-network admission', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-video-'));
  directories.push(stateDir);
  const selected = {
    nativeVideoProvider: 'video-openai',
    defaultModel: 'Wan-AI/Wan2.2-T2V-A14B-Diffusers',
    apiKey: 'intranet-video-key',
    baseUrl: 'http://video.lan:8091/v1/videos/',
  };
  const config: Record<string, unknown> = {
    models: { providers: { openai: { baseUrl: 'http://chat.lan/v1', apiKey: 'chat-key' }, 'justdo-image-openai': { apiKey: 'image-key' } } },
  };
  const selection = resolveNativeVideoSelection({ defaultProviderId: 'lan', providers: { lan: selected } });
  applyNativeVideoConfiguration(config, selection, stateDir, ['video-openai']);
  expect(config).toMatchObject({
    agents: { defaults: { mediaModels: { video: { primary: 'video-openai/' + selected.defaultModel } } } },
    models: { providers: {
      'video-openai': { baseUrl: 'http://video.lan:8091/v1', apiKey: { source: 'file' }, request: { allowPrivateNetwork: true } },
      openai: { apiKey: 'chat-key' }, 'justdo-image-openai': { apiKey: 'image-key' },
    } },
  });
  expect(JSON.stringify(config)).not.toContain('intranet-video-key');

  const noAuth = resolveNativeVideoSelection({ defaultProviderId: 'lan', providers: { lan: { ...selected, apiKey: '' } } });
  applyNativeVideoConfiguration(config, noAuth, stateDir, ['video-openai']);
  expect((config.models as { providers: Record<string, { apiKey?: unknown }> }).providers['video-openai'].apiKey).toBeUndefined();
});

test.each(['', 'bad model', '../model\nheader', 'x'.repeat(449)])('rejects invalid intranet model IDs', model => {
  expect(() => resolveNativeVideoSelection({
    defaultProviderId: 'lan', providers: { lan: {
      nativeVideoProvider: 'video-openai', baseUrl: 'http://video.lan/v1', apiKey: '', defaultModel: model,
    } },
  })).toThrow(t('nativeVideoConfigurationInvalid'));
});

test('does not publish intranet credentials when the adapter is absent', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-intranet-video-'));
  directories.push(stateDir);
  const selection = resolveNativeVideoSelection({ defaultProviderId: 'lan', providers: { lan: {
    nativeVideoProvider: 'video-openai', baseUrl: 'http://video.lan/v1', apiKey: 'unused', defaultModel: 'internal-video',
  } } });
  const config: Record<string, unknown> = { agents: { defaults: { mediaModels: { video: 'video-openai/old' } } } };
  applyNativeVideoConfiguration(config, selection, stateDir, []);
  expect(config).toMatchObject({ agents: { defaults: { mediaModels: {} } } });
  expect(fs.existsSync(path.join(stateDir, 'extension-secrets.json'))).toBe(false);
});
