import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../data/coworkStore';
import {
  resolveRawApiConfig,
  validateConfiguredOpenClawProviderNames,
} from '../../providers/providerApiConfig';
import { OpenClawConfigSync } from './openclawConfigSync';

vi.mock('../../providers/providerApiConfig', async importOriginal => ({
  ...await importOriginal<typeof import('../../providers/providerApiConfig')>(),
  resolveRawApiConfig: vi.fn(),
  validateConfiguredOpenClawProviderNames: vi.fn(),
}));
vi.mock('./models/providerSecretFile', async importOriginal => ({
  ...await importOriginal<typeof import('./models/providerSecretFile')>(),
  restrictCredentialFile: vi.fn(),
}));

const directories: string[] = [];
const config = {
  models: { providers: { officemodels: {
    baseUrl: 'http://models.internal/v1',
    apiKey: { source: 'file', provider: 'private', id: '/apiKey' },
    models: [{ id: 'first' }, { id: 'second' }],
  } } },
  agents: {
    defaults: { model: { primary: 'officemodels/first', fallbacks: ['officemodels/first'] }, modelSelectionScope: 'session' },
    entries: {
      main: { model: { primary: 'officemodels/first' }, workspace: 'main-workspace' },
      review: { model: { primary: 'officemodels/first' }, tools: { deny: ['example'] } },
      external: { model: 'officemodels/first', runtime: { type: 'acp' } },
    },
  },
  plugins: { entries: { optional: { enabled: false, config: { custom: true } } } },
  tools: { exec: { host: 'gateway', mode: 'ask' }, fs: { workspaceOnly: true } },
  secrets: { providers: { private: { source: 'file', path: 'private.json' } } },
};

beforeEach(() => {
  vi.mocked(resolveRawApiConfig).mockReturnValue({
    config: { apiKey: 'fixture-key', baseURL: 'http://models.internal/v1', model: 'second', apiType: 'openai' },
    providerMetadata: { providerName: 'officemodels', displayName: 'OfficeModels' },
  });
  vi.mocked(validateConfiguredOpenClawProviderNames).mockReturnValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const createFixture = (agents: Agent[] = []) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-defaults-test-'));
  directories.push(directory);
  const configPath = path.join(directory, 'openclaw.json');
  const original = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(configPath, original);
  const secretPath = path.join(directory, 'private.json');
  fs.writeFileSync(secretPath, '{"apiKey":"fixture-private-key"}\n');
  const sync = new OpenClawConfigSync({
    engineManager: { getConfigPath: () => configPath },
    getCoworkConfig: () => ({}),
    getAgents: () => agents,
  } as never);
  return { directory, configPath, secretPath, sync, original };
};

describe('model-default-only native publication', () => {
  it('uses a custom provider display name while preserving every unrelated native field and secret file', () => {
    const fixture = createFixture([{ id: 'review', enabled: true, model: '' } as Agent]);

    const publication = fixture.sync.syncModelDefaults();
    const published = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));

    expect(publication.result).toMatchObject({ ok: true, changed: true, modelDefaultsOnly: true, secretsChanged: false, requiresGatewayRestart: false });
    expect(published).toEqual({ ...config, agents: {
      ...config.agents,
      defaults: { ...config.agents.defaults, model: { primary: 'officemodels/second', fallbacks: ['officemodels/first'] } },
      entries: {
        ...config.agents.entries,
        main: { ...config.agents.entries.main, model: { primary: 'officemodels/second' } },
        review: { ...config.agents.entries.review, model: { primary: 'officemodels/second' } },
      },
    } });
    expect(fs.readFileSync(fixture.secretPath, 'utf8')).toBe('{"apiKey":"fixture-private-key"}\n');
    expect(fs.readdirSync(fixture.directory).sort()).toEqual(['openclaw.json', 'private.json']);
    expect(publication.isCurrent()).toBe(true);
    expect(publication.matchesRuntimeConfig(published)).toBe(true);
    fs.appendFileSync(fixture.configPath, ' ');
    expect(publication.isCurrent()).toBe(false);
  });

  it('keeps specialist selections and native external owners rather than adding or rebuilding agent rows', () => {
    const fixture = createFixture([{ id: 'review', enabled: true, model: 'officemodels/first' } as Agent]);
    expect(fixture.sync.syncModelDefaults().result.ok).toBe(true);
    const published = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    expect(published.agents.entries.review).toEqual(config.agents.entries.review);
    expect(published.agents.entries.external).toEqual(config.agents.entries.external);
    expect(Object.keys(published.agents.entries)).toEqual(Object.keys(config.agents.entries));
  });

  it.each(['catalog', 'roster'] as const)('rejects an unavailable %s before writing any config', kind => {
    const fixture = createFixture(kind === 'roster' ? [{ id: 'missing', enabled: true, model: '' } as Agent] : []);
    if (kind === 'catalog') vi.mocked(resolveRawApiConfig).mockReturnValue({
      config: { apiKey: 'fixture-key', baseURL: 'http://models.internal/v1', model: 'missing', apiType: 'openai' },
      providerMetadata: { providerName: 'officemodels', displayName: 'OfficeModels' },
    });
    const publication = fixture.sync.syncModelDefaults();
    expect(publication.result.ok).toBe(false);
    expect(publication.isCurrent()).toBe(false);
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toBe(fixture.original);
    expect(fs.readdirSync(fixture.directory).sort()).toEqual(['openclaw.json', 'private.json']);
  });

  it('preserves a concurrently changed native tree and removes only its own unpublished temporary file', () => {
    const fixture = createFixture();
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
      write(file, content, options);
      if (String(file).startsWith(`${fixture.configPath}.tmp-`) && typeof content === 'string' && content.includes('officemodels/second')) {
        write(fixture.configPath, `${fixture.original} `);
      }
    });
    expect(fixture.sync.syncModelDefaults().result.ok).toBe(false);
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toBe(`${fixture.original} `);
    expect(fs.readdirSync(fixture.directory).sort()).toEqual(['openclaw.json', 'private.json']);
  });

  it('does not rewrite an unchanged default', () => {
    const fixture = createFixture();
    expect(fixture.sync.syncModelDefaults().result.changed).toBe(true);
    const write = vi.spyOn(fs, 'writeFileSync');
    expect(fixture.sync.syncModelDefaults().result).toMatchObject({ ok: true, changed: false, configChanged: false });
    expect(write).not.toHaveBeenCalled();
  });
});
