import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenClawExtensionConfigurationField } from '../../../shared/plugins/extensions';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  getTextConfigurationFields,
  isValidTextConfigurationValue,
} from './extensionConfigurationFields';
import { OpenClawExtensionImportService } from './openclawExtensionImportService';

const textField: OpenClawExtensionConfigurationField = {
  path: 'url',
  label: 'URL',
  type: 'string',
  sensitive: false,
  configured: false,
};

describe('explicitly editable extension text fields', () => {
  it('projects TypeSafe URLs without exposing its structured credential', () => {
    const manifest = JSON.parse(
      fs.readFileSync('plugins/extensions/typesafe/openclaw.plugin.json', 'utf8'),
    );
    const fields = getTextConfigurationFields(manifest, {
      serviceUrl: 'http://inference.corp:8009/v1',
      apiKey: { source: 'file', provider: 'secrets', id: '/private-key' },
    });

    expect(fields).toMatchObject([
      { path: 'baseUrl', type: 'string', configured: false, sensitive: false, maxLength: 128 },
      {
        path: 'serviceUrl',
        value: 'http://inference.corp:8009/v1',
        configured: true,
        minLength: 1,
      },
    ]);
    expect(JSON.stringify(fields)).not.toContain('/private-key');
  });

  it('requires explicit schema and UI admission and protects secret, read-only and dangerous paths', () => {
    const properties: Record<string, unknown> = {
      label: { type: 'string', default: 'Default label' },
      internal: { type: 'string' },
      readonly: { type: 'string', readOnly: true },
      private: { type: 'string', writeOnly: true },
      fixed: { type: 'string', const: 'fixed' },
      composed: { type: 'string', allOf: [{ maxLength: 3 }] },
      mixedEnum: { type: 'string', enum: ['one', 2] },
      token: { type: 'string' },
      mode: { type: 'string' },
      credentials: { type: 'object', properties: { child: { type: 'string' } } },
      secrets: {
        type: 'object',
        properties: { provider: { type: 'object', properties: { key: { type: 'string' } } } },
      },
      inherited: { type: 'object', readOnly: true, properties: { child: { type: 'string' } } },
      conditional: {
        type: 'object',
        if: { required: ['enabled'] },
        then: { properties: { child: { writeOnly: true } } },
        properties: { child: { type: 'string' } },
      },
    };
    const hintPaths = [
      ...Object.keys(properties),
      'credentials.child',
      'secrets.provider.key',
      'inherited.child',
      'conditional.child',
      'undeclared',
      '__proto__.polluted',
      'constructor.prototype.polluted',
    ];
    const manifest = {
      configSchema: { type: 'object', properties },
      uiHints: {
        ...Object.fromEntries(hintPaths.map(fieldPath => [fieldPath, { configurable: true }])),
        internal: { label: 'Internal' },
        credentials: { sensitive: true },
      },
      configContracts: {
        secretInputs: { paths: [{ path: 'token' }, { path: 'secrets.*.*' }] },
        dangerousFlags: [{ path: 'mode', equals: 'approve-all' }],
      },
    };

    const fields = getTextConfigurationFields(manifest, {
      token: 'private',
      credentials: { child: 'private' },
    });

    expect(fields).toMatchObject([
      { path: 'label', type: 'string', defaultValue: 'Default label' },
    ]);
    expect(fields).toHaveLength(1);
    expect(JSON.stringify(fields)).not.toContain('private');
    // ACPX's ordinary hints must not become a second permission or executable editor.
    const acpx = JSON.parse(
      fs.readFileSync('plugins/extensions/acpx/openclaw.plugin.json', 'utf8'),
    );
    expect(getTextConfigurationFields(acpx, {})).toEqual([]);
  });

  it.each([
    [{ minLength: 3 }, 'ab', false],
    [{ maxLength: 2 }, 'abc', false],
    [{ minLength: 1, maxLength: 1 }, '😀', true],
    [{ enum: ['one', 'two'] }, 'three', false],
    [{ pattern: '^https?://' }, 'file:///private', false],
    [{ pattern: '[' }, 'anything', false],
    [{ format: 'uri' }, 'invalid URL', false],
    [{ format: 'uri' }, 'http://inference.corp:8009/v1', true],
    [{ required: true }, '', false],
    [{ required: true, defaultValue: 'valid', minLength: 3 }, '', true],
    [{ required: true, defaultValue: 'x', minLength: 3 }, '', false],
    [{ required: true, defaultValue: '' }, '', true],
    [{ minLength: 1 }, '', true],
  ])('validates text rules %j for %j', (constraints, value, valid) => {
    expect(isValidTextConfigurationValue({ ...textField, ...constraints }, value)).toBe(valid);
  });
});

describe('extension text configuration persistence', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-text-config-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const createService = (root: string, managed = false) => {
    const stateDir = path.join(root, 'state');
    const runtimeRoot = path.join(root, 'runtime');
    const bundledDir = path.join(runtimeRoot, 'dist', 'extensions', 'typesafe');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.copyFileSync(
      'plugins/extensions/typesafe/openclaw.plugin.json',
      path.join(bundledDir, 'openclaw.plugin.json'),
    );
    const manager = {
      getStateDir: () => stateDir,
      getBaseDir: () => root,
      getRuntimeRoot: () => runtimeRoot,
      getConfigPath: () => configPath,
      getStatus: () => ({ phase: 'ready' }),
    } as unknown as OpenClawEngineManager;
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      getManagedPluginIds: () => (managed ? ['typesafe'] : []),
      requestGateway: vi.fn(async () => ({
        plugins: [{ id: 'typesafe', installed: true, origin: 'bundled', enabled: false }],
        mutationAllowed: true,
      })),
    });
    return { service, manager, configPath, stateDir };
  };

  it('switches URL modes by clearing the old override, preserves credentials and leaves activation unchanged', async () => {
    const { service, configPath, stateDir } = createService(fixtureRoot);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        tools: { deny: ['restricted-tool'] },
        plugins: {
          entries: {
            typesafe: {
              enabled: false,
              config: { baseUrl: 'http://localhost:8009', timeoutMs: 4500 },
            },
          },
        },
      }),
    );

    expect(
      await service.updateConfiguration('typesafe', {
        baseUrl: '',
        serviceUrl: 'http://inference.corp:8009/v1',
        apiKey: 'synthetic-text-key',
      }),
    ).toEqual({ success: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tools).toEqual({ deny: ['restricted-tool'] });
    expect(config.plugins.entries.typesafe).toMatchObject({
      enabled: false,
      config: {
        serviceUrl: 'http://inference.corp:8009/v1',
        timeoutMs: 4500,
        apiKey: { source: 'file', provider: 'justdo-extension-secrets' },
      },
    });
    expect(config.plugins.entries.typesafe.config).not.toHaveProperty('baseUrl');
    expect(JSON.stringify(config)).not.toContain('synthetic-text-key');
    expect(fs.readFileSync(path.join(stateDir, 'extension-secrets.json'), 'utf8')).toContain(
      'synthetic-text-key',
    );
    const fields = (await service.listCatalog())[0].configurationFields;
    expect(fields.find(field => field.path === 'serviceUrl')?.value).toBe(
      'http://inference.corp:8009/v1',
    );
    expect(JSON.stringify(fields)).not.toContain('synthetic-text-key');
  });

  it('validates a mixed submission before writing either config or credentials', async () => {
    const { service, configPath, stateDir } = createService(fixtureRoot);
    const original = JSON.stringify({ plugins: { entries: { typesafe: { enabled: false } } } });
    fs.writeFileSync(configPath, original);

    expect(
      await service.updateConfiguration('typesafe', {
        baseUrl: 'http://remote.corp:8009',
        apiKey: 'must-not-persist',
      }),
    ).toMatchObject({ success: false });
    expect(
      await service.updateConfiguration('typesafe', { serviceUrl: 'x'.repeat(2049) }),
    ).toMatchObject({ success: false });
    expect(
      await service.updateConfiguration('typesafe', {
        timeoutMs: '1000',
        'constructor.prototype.polluted': 'blocked',
      }),
    ).toMatchObject({ success: false });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(stateDir, 'extension-secrets.json'))).toBe(false);
  });

  it('keeps application-managed URLs protected', async () => {
    const { service, configPath } = createService(fixtureRoot, true);
    fs.writeFileSync(configPath, '{}');

    expect(
      await service.updateConfiguration('typesafe', { serviceUrl: 'http://inference.corp/v1' }),
    ).toMatchObject({ success: false });
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
  });

  it('edits and clears nested text while preserving sibling values', async () => {
    const { service, manager, configPath, stateDir } = createService(fixtureRoot);
    const directory = path.join(stateDir, 'extensions', 'text-demo');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'text-demo',
        configSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri', minLength: 1 },
                label: { type: 'string', default: 'Default' },
                requiredName: { type: 'string', minLength: 1 },
              },
              required: ['requiredName'],
            },
          },
        },
        uiHints: {
          'server.url': { configurable: true },
          'server.label': { configurable: true },
          'server.requiredName': { configurable: true },
        },
      }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            'text-demo': {
              enabled: true,
              config: { server: { label: 'Existing', requiredName: 'Required' } },
            },
          },
        },
      }),
    );

    expect(
      await service.updateConfiguration('text-demo', {
        'server.url': 'http://intranet.corp/v1',
        'server.label': '  exact text  ',
      }),
    ).toEqual({ success: true });
    expect(
      service.listInstalled().find(plugin => plugin.id === 'text-demo')?.configurationFields,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'server.url', value: 'http://intranet.corp/v1' }),
        expect.objectContaining({ path: 'server.label', value: '  exact text  ' }),
      ]),
    );
    const beforeInvalid = fs.readFileSync(configPath, 'utf8');
    expect(
      await service.updateConfiguration('text-demo', { 'server.requiredName': '' }),
    ).toMatchObject({ success: false });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeInvalid);
    expect(
      await service.updateConfiguration('text-demo', { 'server.url': '', 'server.label': '' }),
    ).toEqual({ success: true });
    expect(
      JSON.parse(fs.readFileSync(manager.getConfigPath(), 'utf8')).plugins.entries['text-demo'],
    ).toEqual({ enabled: true, config: { server: { requiredName: 'Required' } } });
    expect(
      service
        .listInstalled()
        .find(plugin => plugin.id === 'text-demo')
        ?.configurationFields.find(field => field.path === 'server.label'),
    ).toMatchObject({ configured: false, defaultValue: 'Default' });
  });
});
