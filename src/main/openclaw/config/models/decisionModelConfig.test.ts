import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyDecisionModelConfiguration,
  captureDecisionModelConfiguration,
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
    applyDecisionModelConfiguration(config, null, dir);
    expect(config).toMatchObject({
      plugins: { entries: { typesafe: { enabled: false, config: {} } } },
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
  expect(config).toEqual(original);
});
