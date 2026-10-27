import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveExtensionSecrets } from '../../../plugins/extensions/extensionSecretFile';
import {
  applyDecisionModelConfiguration,
  captureDecisionModelConfiguration,
  isDecisionModelManaged,
  releaseDecisionModelDefault,
  resolveDecisionModelSelection,
} from './decisionModelConfig';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })),
);
const category = (apiKey = 'test-credential') => ({
  defaultProviderId: 'lan',
  providers: {
    lan: {
      displayName: 'LAN',
      baseUrl: 'http://192.168.1.9:8009/v1',
      apiKey,
      defaultModel: 'kev-latest',
      models: [{ id: 'kev-latest', name: 'Kev' }],
    },
  },
});

describe('decision model settings projection', () => {
  it.each(['legacy', 'scoped'])('keeps a released %s manual credential valid when a later takeover rolls back', mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-credential-rollback-'));
    directories.push(dir);
    const config: Record<string, unknown> = {};
    if (mode === 'legacy') {
      const secrets = saveExtensionSecrets(config, dir, 'typesafe', {
        'decisionModel.apiKey': 'original-manual-key',
      });
      config.plugins = { entries: { typesafe: { enabled: true, config: {
        serviceUrl: 'http://192.168.1.9:8009/v1', apiKey: secrets.references['decisionModel.apiKey'],
      } } } };
      config.agents = { defaults: { decisionModel: 'typesafe/kev-latest' } };
    } else {
      applyDecisionModelConfiguration(config, resolveDecisionModelSelection(category('original-manual-key')), dir);
    }
    releaseDecisionModelDefault(config, resolveDecisionModelSelection(category('original-manual-key')));
    const restore = captureDecisionModelConfiguration(config);
    const manualReference = structuredClone((config.plugins as {
      entries: { typesafe: { config: { apiKey: { id: string } } } };
    }).entries.typesafe.config.apiKey);

    applyDecisionModelConfiguration(config, resolveDecisionModelSelection(category('failed-takeover-key')), dir);
    restore(config);

    const restoredReference = (config.plugins as {
      entries: { typesafe: { config: { apiKey: { id: string } } } };
    }).entries.typesafe.config.apiKey;
    expect(restoredReference).toEqual(manualReference);
    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'extension-secrets.json'), 'utf8'));
    expect(secrets[restoredReference.id.slice(1)]).toBe('original-manual-key');
  });

  it('projects the selected LAN model and rotates secrets without putting values in config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-model-'));
    directories.push(dir);
    const config: Record<string, unknown> = { plugins: { entries: { other: { enabled: true } } } };
    expect(
      applyDecisionModelConfiguration(config, resolveDecisionModelSelection(category()), dir),
    ).toBe(true);
    expect(config).toMatchObject({
      agents: { defaults: { decisionModel: 'typesafe/kev-latest' } },
      plugins: {
        entries: {
          other: { enabled: true },
          typesafe: {
            enabled: true,
            config: {
              serviceUrl: 'http://192.168.1.9:8009/v1',
              apiKey: { source: 'file' },
            },
          },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('test-credential');
    expect((config.plugins as { entries: { typesafe: { config: unknown } } }).entries.typesafe.config).not.toHaveProperty('model');
    expect(
      applyDecisionModelConfiguration(config, resolveDecisionModelSelection(category()), dir),
    ).toBe(false);
    expect(
      applyDecisionModelConfiguration(
        config,
        resolveDecisionModelSelection(category('rotated-credential')),
        dir,
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'extension-secrets.json'), 'utf8')).toContain(
      'rotated-credential',
    );
    expect(JSON.stringify(config)).not.toContain('rotated-credential');
    const beforeRelease = structuredClone(config);
    applyDecisionModelConfiguration(config, null, dir);
    releaseDecisionModelDefault(config, resolveDecisionModelSelection(category()));
    expect(config).toMatchObject({
      plugins: beforeRelease.plugins,
      agents: { defaults: {} },
    });
    expect(JSON.stringify(config)).not.toContain('typesafe/kev-latest');
  });

  it('preserves legacy plugin settings until the model category is configured', () => {
    const config = {
      plugins: {
        entries: { typesafe: { enabled: true, config: { baseUrl: 'http://localhost:8009' } } },
      },
    };
    const before = structuredClone(config);
    expect(applyDecisionModelConfiguration(config, undefined, '')).toBe(false);
    expect(config).toEqual(before);
  });

  it.each([undefined, ''])('leaves a retained provider catalog unmanaged without a default: %s', selected => {
    const value = { ...category(), defaultProviderId: selected };
    const before = structuredClone(value);
    expect(resolveDecisionModelSelection(value)).toBeNull();
    expect(value).toEqual(before);
    expect(resolveDecisionModelSelection(undefined)).toBeUndefined();
    expect(resolveDecisionModelSelection({ providers: {} })).toBeNull();
  });

  it('releases only the exact managed default while preserving extension state and tool policies', () => {
    const config = {
      agents: {
        defaults: { decisionModel: 'typesafe/kev-latest', model: 'chat/model' },
        entries: { specialist: { decisionModel: 'other/model' } },
      },
      plugins: {
        entries: {
          typesafe: {
            enabled: true,
            config: { serviceUrl: 'http://localhost:8009', apiKey: 'old-reference', timeoutMs: 1000 },
          },
          other: { enabled: true },
        },
      },
      tools: { allow: ['read', 'decision_evaluate'], deny: ['decision_evaluate', 'operator-tool'] },
    };
    const before = structuredClone(config);
    const disabled = { ...category(), defaultProviderId: undefined };
    expect(
      applyDecisionModelConfiguration(config, resolveDecisionModelSelection(disabled), ''),
    ).toBe(false);
    releaseDecisionModelDefault(config, resolveDecisionModelSelection(category()));
    expect(config).toEqual({
      ...before,
      agents: { ...before.agents, defaults: { model: 'chat/model' } },
    });
    for (const nativeModel of ['other/default', 'typesafe/manual-model']) {
      config.agents.defaults.decisionModel = nativeModel;
      releaseDecisionModelDefault(config, resolveDecisionModelSelection(category()));
      expect(config.agents.defaults.decisionModel).toBe(nativeModel);
    }
  });

  it('locks only a valid default selection, independently of catalog existence', () => {
    for (const value of [undefined, { providers: {} }, { ...category(), defaultProviderId: '' },
      { ...category(), defaultProviderId: undefined }, { ...category(), defaultProviderId: 'missing' },
      { providers: { lan: {} }, defaultProviderId: 'lan' }]) {
      expect(isDecisionModelManaged(value)).toBe(false);
    }
    expect(isDecisionModelManaged(category())).toBe(true);
  });

  it.each([null, {}, { providers: null }, { providers: [] }, { providers: 'invalid' }])(
    'rejects malformed category input: %j',
    value => expect(() => resolveDecisionModelSelection(value)).toThrow(),
  );

  it.each([null, false, 1, {}, [], 'missing'])(
    'rejects invalid defaults instead of disabling the category: %j',
    defaultProviderId => {
      expect(() => resolveDecisionModelSelection({ ...category(), defaultProviderId })).toThrow();
      expect(() => resolveDecisionModelSelection({ providers: {}, defaultProviderId })).toThrow();
    },
  );

  it.each(['url', 'key', 'model'] as const)(
    'validates retained provider %s while the category is disabled',
    invalidField => {
      const value = { ...category(), defaultProviderId: undefined };
      if (invalidField === 'url') value.providers.lan.baseUrl = 'file:///tmp/server';
      if (invalidField === 'key') value.providers.lan.apiKey = '';
      if (invalidField === 'model') value.providers.lan.defaultModel = 'missing';
      expect(() => resolveDecisionModelSelection(value)).toThrow();
    },
  );

  it.each([
    '',
    'file:///tmp/server',
    'http://user:password@server/v1',
    'http://server/v1?key=secret',
    'http://server/v1#fragment',
  ])('rejects invalid provider URL %s', baseUrl => {
    const value = category();
    value.providers.lan.baseUrl = baseUrl;
    expect(() => resolveDecisionModelSelection(value)).toThrow();
  });

  it.each(['', ' ', 'invalid\nheader'])('rejects missing or invalid credentials', key => {
    expect(() => resolveDecisionModelSelection(category(key))).toThrow();
  });

  it('rejects an absent provider or model selection', () => {
    expect(() =>
      resolveDecisionModelSelection({ ...category(), defaultProviderId: 'missing' }),
    ).toThrow();
    const value = category();
    value.providers.lan.defaultModel = 'missing';
    expect(() => resolveDecisionModelSelection(value)).toThrow();
  });
});

it('restores unmanaged selection when a first settings save is rolled back', () => {
  const original = {
    plugins: { entries: { typesafe: { enabled: false, config: { model: 'jev-latest' } } } },
    agents: { defaults: { decisionModel: 'other/model', model: 'chat/model' } },
  };
  const restore = captureDecisionModelConfiguration(original);
  const config: Record<string, unknown> = structuredClone(original);
  applyDecisionModelConfiguration(config, null, '');
  restore(config);
  expect(config).toEqual(original);
});

it.each([true, false])('leaves unmanaged plugin configuration unchanged when enabled=%s', enabled => {
  const config = { plugins: { entries: { typesafe: { enabled, config: { model: 'kev-latest', baseUrl: 'http://localhost:8009' } } } }, agents: { defaults: {} } };
  const original = structuredClone(config);
  expect(applyDecisionModelConfiguration(config, undefined, '')).toBe(false);
  expect(applyDecisionModelConfiguration(config, null, '')).toBe(false);
  expect(config).toEqual(original);
});
