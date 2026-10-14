import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

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

test('rejects unsupported video providers and restores unmanaged settings after rollback', () => {
  expect(() =>
    resolveNativeVideoSelection({ providers: { legacy: { apiKey: 'retained' } } }),
  ).toThrow(t('nativeVideoConfigurationInvalid'));
  expect(resolveNativeVideoSelection(undefined)).toBeUndefined();
  expect(resolveNativeVideoSelection({ providers: {} })).toBeNull();
  const config = {
    agents: { defaults: { mediaModels: { video: 'custom/video' } } },
    models: { providers: { 'video-openai': { apiKey: 'pre-existing' } } },
    plugins: { allow: ['other'], deny: ['other'] },
  };
  const restore = captureNativeVideoConfiguration(config);
  const next: Record<string, unknown> = {
    agents: { defaults: { model: 'chat/model', mediaModels: { video: 'video-openai/changed' } } },
    plugins: { allow: ['other'], deny: ['other'] },
  };
  restore(next);
  expect(next).toMatchObject({
    agents: { defaults: { model: 'chat/model', mediaModels: { video: 'custom/video' } } },
    models: { providers: { 'video-openai': { apiKey: 'pre-existing' } } },
    plugins: { allow: ['other'], deny: ['other'] },
  });
});

test('cleans unavailable video fallbacks without a managed selection and preserves uncertain inventory', () => {
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        mediaModels: {
          video: { primary: 'custom/video', fallbacks: ['video-openai/model', 'other/video'] },
        },
      },
    },
    plugins: { entries: { openai: { enabled: true } } },
  };
  const original = structuredClone(config);
  expect(applyNativeVideoConfiguration(config, undefined, os.tmpdir(), null)).toBe(false);
  expect(config).toEqual(original);
  applyNativeVideoConfiguration(config, undefined, os.tmpdir(), ['custom', 'other']);
  expect(config).toMatchObject({
    agents: {
      defaults: { mediaModels: { video: { primary: 'custom/video', fallbacks: ['other/video'] } } },
    },
    plugins: { entries: {} },
  });
});

test('retains the available video fallback and transport options when the primary plugin is missing', () => {
  const config: Record<string, unknown> = {
    agents: {
      defaults: {
        mediaModels: {
          video: {
            primary: 'video-openai/model',
            fallbacks: ['custom/internal-video', 'other/video'],
            timeoutMs: 60000,
          },
        },
      },
    },
  };
  applyNativeVideoConfiguration(config, undefined, os.tmpdir(), ['custom', 'other']);
  expect(config).toMatchObject({
    agents: {
      defaults: {
        mediaModels: {
          video: {
            primary: 'custom/internal-video',
            fallbacks: ['other/video'],
            timeoutMs: 60000,
          },
        },
      },
    },
  });
});

test.each(['kie', 'zai', 'novita', 'openai'])(
  'rejects unsupported video provider %s even with otherwise valid settings',
  nativeVideoProvider => {
    expect(() =>
      resolveNativeVideoSelection({
        defaultProviderId: 'selected',
        providers: {
          selected: {
            nativeVideoProvider,
            defaultModel: 'internal-video',
            apiKey: '',
            baseUrl: 'http://video.lan/v1',
          },
        },
      }),
    ).toThrow(t('nativeVideoConfigurationInvalid'));
  },
);

test.each([
  'https://user:password@video.lan/v1',
  'http://video.lan/v1?key=value',
  'ftp://video.lan/v1',
])('rejects invalid video service URL %s', baseUrl => {
  expect(() =>
    resolveNativeVideoSelection({
      defaultProviderId: 'lan',
      providers: {
        lan: {
          nativeVideoProvider: 'video-openai',
          defaultModel: 'internal-video',
          apiKey: '',
          baseUrl,
        },
      },
    }),
  ).toThrow(t('nativeVideoUrlInvalid'));
});

test('translates malformed video service URLs instead of leaking URL parser errors', () => {
  expect(() =>
    resolveNativeVideoSelection({
      defaultProviderId: 'native',
      providers: {
        native: {
          nativeVideoProvider: 'video-openai',
          defaultModel: 'internal-video',
          apiKey: 'test-key',
          baseUrl: 'not a URL',
        },
      },
    }),
  ).toThrow(t('nativeVideoUrlInvalid'));
});

test.each([{ providers: {} }, { providers: { lan: { nativeVideoProvider: 'video-openai' } } }])(
  'clearing the default video model keeps the shared OpenAI extension enabled while preserving other models: %j',
  category => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          model: 'chat/model',
          mediaModels: {
            video: { primary: 'video-openai/video-v1', fallbacks: [] },
            image: 'image/model',
          },
        },
      },
      plugins: {
        entries: {
          openai: { enabled: true, config: { retained: true } },
          other: { enabled: true },
        },
      },
    };
    applyNativeVideoConfiguration(config, resolveNativeVideoSelection(category), os.tmpdir(), [
      'openai',
    ]);
    expect(config).toEqual({
      agents: { defaults: { model: 'chat/model', mediaModels: { image: 'image/model' } } },
      plugins: {
        entries: {
          openai: { enabled: true, config: { retained: true } },
          other: { enabled: true },
        },
      },
    });
  },
);

test('clears the managed video model before video settings are configured while keeping OpenAI enabled', () => {
  const config: Record<string, unknown> = {
    agents: { defaults: { mediaModels: { video: 'video-openai/model' } } },
    plugins: { entries: { openai: { enabled: true } } },
  };
  applyNativeVideoConfiguration(config, undefined, os.tmpdir(), ['openai']);
  expect(config).toMatchObject({
    agents: { defaults: { mediaModels: {} } },
    plugins: { entries: { openai: { enabled: true } } },
  });
});

test.each([null, undefined])(
  'clears managed video use even with an incomplete inventory: %j',
  selection => {
    const config: Record<string, unknown> = {
      agents: { defaults: { mediaModels: { video: 'video-openai/old', image: 'other/image' } } },
      plugins: {
        allow: ['openai', 'unknown'],
        deny: ['unknown'],
        entries: { openai: { enabled: true }, unknown: { enabled: true } },
      },
      models: { providers: { unknown: { baseUrl: 'http://other.lan/v1' } } },
    };

    expect(applyNativeVideoConfiguration(config, selection, os.tmpdir(), null)).toBe(false);

    expect(config).toEqual({
      agents: { defaults: { mediaModels: { image: 'other/image' } } },
      plugins: {
        allow: ['openai', 'unknown'],
        deny: ['unknown'],
        entries: { openai: { enabled: true }, unknown: { enabled: true } },
      },
      models: { providers: { unknown: { baseUrl: 'http://other.lan/v1' } } },
    });
  },
);

test.each([{}, { openai: { enabled: false } }])(
  'does not add or enable a video provider when the inventory is incomplete: %j',
  entries => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uncertain-native-video-'));
    directories.push(stateDir);
    const config: Record<string, unknown> = { plugins: { entries } };
    const original = structuredClone(config);
    const selection = resolveNativeVideoSelection({
      defaultProviderId: 'lan',
      providers: {
        lan: {
          nativeVideoProvider: 'video-openai',
          baseUrl: 'http://video.lan/v1',
          apiKey: 'unused-video-key',
          defaultModel: 'internal-video',
        },
      },
    });

    expect(applyNativeVideoConfiguration(config, selection, stateDir, null)).toBe(false);

    expect(config).toEqual(original);
    expect(fs.existsSync(path.join(stateDir, 'extension-secrets.json'))).toBe(false);
  },
);

test.each([
  null,
  [],
  'invalid',
  {},
  { providers: null },
  { providers: [] },
  { providers: 'invalid' },
  { providers: {}, defaultProviderId: 'missing' },
  { providers: {}, defaultProviderId: 123 },
])(
  'rejects malformed video categories rather than treating them as an explicit clear: %j',
  value => {
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
    models: {
      providers: {
        openai: { baseUrl: 'http://chat.lan/v1', apiKey: 'chat-key' },
        'justdo-image-openai': { apiKey: 'image-key' },
      },
    },
    plugins: { allow: ['other'], deny: ['openai'], entries: { other: { enabled: false } } },
  };
  const selection = resolveNativeVideoSelection({
    defaultProviderId: 'lan',
    providers: { lan: selected },
  });
  expect(applyNativeVideoConfiguration(config, selection, stateDir, ['openai'])).toBe(true);
  expect(config).toMatchObject({
    agents: {
      defaults: { mediaModels: { video: { primary: 'video-openai/' + selected.defaultModel } } },
    },
    models: {
      providers: {
        'video-openai': {
          baseUrl: 'http://video.lan:8091/v1',
          apiKey: { source: 'file' },
          request: { allowPrivateNetwork: true },
        },
        openai: { apiKey: 'chat-key' },
        'justdo-image-openai': { apiKey: 'image-key' },
      },
    },
    plugins: {
      allow: ['other', 'openai'],
      deny: [],
      entries: { openai: { enabled: true }, other: { enabled: false } },
    },
  });
  expect(JSON.stringify(config)).not.toContain('intranet-video-key');
  expect(applyNativeVideoConfiguration(config, selection, stateDir, ['openai'])).toBe(false);

  const noAuth = resolveNativeVideoSelection({
    defaultProviderId: 'lan',
    providers: { lan: { ...selected, apiKey: '' } },
  });
  applyNativeVideoConfiguration(config, noAuth, stateDir, ['openai']);
  expect(
    (config.models as { providers: Record<string, { apiKey?: unknown }> }).providers['video-openai']
      .apiKey,
  ).toBeUndefined();
});

test('removes the retired video plugin entry while preserving the provider domain and shared OpenAI', () => {
  const config: Record<string, unknown> = {
    models: { providers: { 'video-openai': { baseUrl: 'http://video.lan/v1' } } },
    plugins: {
      allow: ['openai', 'video-openai', 'other'],
      deny: ['video-openai', 'other'],
      entries: {
        openai: { enabled: true },
        'video-openai': { enabled: true },
        other: { enabled: false },
      },
    },
  };
  applyNativeVideoConfiguration(config, null, os.tmpdir(), ['openai']);
  expect(config).toMatchObject({
    models: { providers: { 'video-openai': { baseUrl: 'http://video.lan/v1' } } },
    plugins: {
      allow: ['openai', 'other'],
      deny: ['other'],
      entries: { openai: { enabled: true }, other: { enabled: false } },
    },
  });
  expect(
    (config.plugins as { entries: Record<string, unknown> }).entries['video-openai'],
  ).toBeUndefined();
});

test('rolling back video settings does not overwrite shared OpenAI state or chat configuration', () => {
  const restore = captureNativeVideoConfiguration({
    plugins: { allow: [], entries: { openai: { enabled: false, config: { personality: 'off' } } } },
  });
  const next: Record<string, unknown> = {
    models: {
      providers: {
        openai: { baseUrl: 'http://chat.lan/v1' },
        'video-openai': { baseUrl: 'http://video.lan/v1' },
      },
    },
    plugins: {
      allow: ['openai'],
      entries: { openai: { enabled: true, config: { personality: 'friendly' } } },
    },
  };
  restore(next);
  expect(next).toMatchObject({
    models: { providers: { openai: { baseUrl: 'http://chat.lan/v1' } } },
    plugins: {
      allow: ['openai'],
      entries: { openai: { enabled: true, config: { personality: 'friendly' } } },
    },
  });
  expect(
    (next.models as { providers: Record<string, unknown> }).providers['video-openai'],
  ).toBeUndefined();
});

test.each(['', 'bad model', '../model\nheader', 'x'.repeat(449)])(
  'rejects invalid intranet model IDs',
  model => {
    expect(() =>
      resolveNativeVideoSelection({
        defaultProviderId: 'lan',
        providers: {
          lan: {
            nativeVideoProvider: 'video-openai',
            baseUrl: 'http://video.lan/v1',
            apiKey: '',
            defaultModel: model,
          },
        },
      }),
    ).toThrow(t('nativeVideoConfigurationInvalid'));
  },
);

test('does not publish intranet credentials when the adapter is absent', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-intranet-video-'));
  directories.push(stateDir);
  const selection = resolveNativeVideoSelection({
    defaultProviderId: 'lan',
    providers: {
      lan: {
        nativeVideoProvider: 'video-openai',
        baseUrl: 'http://video.lan/v1',
        apiKey: 'unused',
        defaultModel: 'internal-video',
      },
    },
  });
  const config: Record<string, unknown> = {
    agents: { defaults: { mediaModels: { video: 'video-openai/old' } } },
  };
  applyNativeVideoConfiguration(config, selection, stateDir, []);
  expect(config).toMatchObject({ agents: { defaults: { mediaModels: {} } } });
  expect(fs.existsSync(path.join(stateDir, 'extension-secrets.json'))).toBe(false);
});
