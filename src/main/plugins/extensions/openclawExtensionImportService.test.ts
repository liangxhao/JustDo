import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedDirectoryOperationCoordinator } from '../../core/filesystem/managedDirectoryOperations';
import { t } from '../../core/i18n';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  __openClawExtensionImportTestUtils,
  OpenClawExtensionImportService,
} from './openclawExtensionImportService';

describe('OpenClawExtensionImportService', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extension-import-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('routes a wrapped foreign archive through conversion before preparing the runtime', async () => {
    const sourceDir = path.join(fixtureRoot, 'foreign');
    fs.mkdirSync(path.join(sourceDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '.codex-plugin', 'plugin.json'), '{"name":"foreign"}');
    const archivePath = path.join(fixtureRoot, 'foreign.tgz');
    await tar.create({ file: archivePath, cwd: fixtureRoot, gzip: true }, ['foreign']);
    const getOpenClawEngineManager = vi.fn();
    const service = new OpenClawExtensionImportService({ getOpenClawEngineManager });

    const createTemporaryDirectory = vi.spyOn(fs, 'mkdtempSync');
    await expect(service.importPath(archivePath)).resolves.toEqual({
      success: false,
      error: t('extensionConversionNotImplemented'),
      failedStage: 'validating',
    });
    expect(getOpenClawEngineManager).not.toHaveBeenCalled();
    expect(fs.existsSync(archivePath)).toBe(true);
    const temporaryDirectory = createTemporaryDirectory.mock.results[0]?.value as string;
    expect(temporaryDirectory).toBeTruthy();
    expect(fs.existsSync(temporaryDirectory)).toBe(false);
  });

  it.each([
    'gateway not connected',
    'OpenClaw engine is not running.',
    'OpenClaw gateway client connect timeout after 10000ms',
    'Failed to start OpenClaw Gateway',
  ])('recognizes the transport startup failure: %s', message => {
    expect(__openClawExtensionImportTestUtils.isGatewayUnavailableError(new Error(message))).toBe(
      true,
    );
  });

  it('recognizes the authoritative OpenClaw retryable directory-removal failure', () => {
    expect(
      __openClawExtensionImportTestUtils.isDirectoryLockError({
        code: 'UNAVAILABLE',
        message:
          'Failed to remove plugin directory C:\\extensions\\demo; the plugin remains disabled and tracked so uninstall can be retried.',
      }),
    ).toBe(true);
    expect(
      __openClawExtensionImportTestUtils.isDirectoryLockError({
        code: 'UNAVAILABLE',
        message: 'Plugin inventory transaction failed',
      }),
    ).toBe(false);
  });

  it.each(['automation-permission', 'cua-computer', 'openai', 'code-mode-quickjs', 'video-openai'])(
    'protects managed %s from user mutation',
    async extensionId => {
      const runCommand = vi.fn();
      const requestGateway = vi.fn();
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({ getStatus: () => ({ phase: 'ready' }) }) as OpenClawEngineManager,
        getManagedPluginIds: () => [extensionId],
        runCommand,
        requestGateway,
      });

      await expect(
        service.updateConfiguration(extensionId, {
          approvalTimeoutMinutes: 10,
        }),
      ).resolves.toEqual({
        success: false,
        error: 'Managed extensions cannot be reconfigured here.',
      });
      await expect(service.delete(extensionId)).resolves.toEqual({
        success: false,
        error: 'Managed extensions cannot be deleted.',
      });
      await expect(service.setEnabled(extensionId, false)).resolves.toEqual({
        success: false,
        error: 'Managed extensions cannot be changed here.',
      });
      await expect(service.setEnabled(extensionId, true)).resolves.toEqual({
        success: false,
        error: 'Managed extensions cannot be changed here.',
      });
      expect(runCommand).not.toHaveBeenCalled();
      expect(requestGateway).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'locks the desktop-control catalog entry when enabled=%s',
    async enabled => {
      const requestGateway = vi.fn().mockResolvedValue({
        plugins: [
          {
            id: 'cua-computer',
            name: 'Computer',
            installed: true,
            enabled,
            state: enabled ? 'enabled' : 'disabled',
            origin: 'bundled',
            removable: true,
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({
            getStateDir: () => fixtureRoot,
            getConfigPath: () => path.join(fixtureRoot, 'openclaw.json'),
          }) as unknown as OpenClawEngineManager,
        getManagedPluginIds: () => ['cua-computer'],
        requestGateway,
      });
      expect(await service.listCatalog()).toEqual([
        expect.objectContaining({
          id: 'cua-computer',
          enabled,
          managed: true,
          canToggle: false,
          removable: false,
        }),
      ]);
    },
  );

  it('uses the Gateway plugin catalog as the installed inventory authority', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const requestGateway = vi.fn().mockResolvedValue({
      plugins: [
        {
          id: 'browser',
          name: 'Browser',
          description: 'Browser tools',
          installed: true,
          enabled: true,
          state: 'enabled',
          origin: 'bundled',
          kind: ['tool'],
          removable: false,
        },
        {
          id: 'available-only',
          name: 'Available only',
          installed: false,
          enabled: false,
          state: 'not-installed',
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStatus: () => ({ phase: 'ready' }),
          getStateDir: () => stateDir,
          getBaseDir: () => path.join(fixtureRoot, 'openclaw-home'),
          getConfigPath: () => path.join(stateDir, 'openclaw.json'),
        }) as unknown as OpenClawEngineManager,
      requestGateway,
    });

    await expect(service.listCatalog()).resolves.toEqual([
      expect.objectContaining({
        id: 'browser',
        enabled: true,
        origin: 'bundled',
        removable: false,
        canToggle: true,
      }),
    ]);
    expect(requestGateway).toHaveBeenCalledWith('plugins.list', {});
  });

  it('fills a blank Gateway description from bundled extension package metadata', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    const bundledDir = path.join(runtimeRoot, 'dist', 'extensions', 'memory-core');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'memory-core', name: 'OpenClaw Memory' }),
    );
    fs.writeFileSync(
      path.join(bundledDir, 'package.json'),
      JSON.stringify({ description: 'Search and retrieve persistent memory.' }),
    );
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStatus: () => ({ phase: 'ready' }),
          getStateDir: () => stateDir,
          getRuntimeRoot: () => runtimeRoot,
          getConfigPath: () => path.join(stateDir, 'openclaw.json'),
        }) as unknown as OpenClawEngineManager,
      requestGateway: vi.fn().mockResolvedValue({
        plugins: [
          {
            id: 'memory-core',
            name: 'OpenClaw Memory',
            description: '   ',
            installed: true,
            enabled: true,
            state: 'enabled',
            origin: 'bundled',
            kind: ['memory'],
            removable: false,
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      }),
    });

    await expect(service.listCatalog()).resolves.toEqual([
      expect.objectContaining({
        id: 'memory-core',
        description: 'Search and retrieve persistent memory.',
      }),
    ]);

    const externalService = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStateDir: () => stateDir,
          getRuntimeRoot: () => runtimeRoot,
          getConfigPath: () => path.join(stateDir, 'openclaw.json'),
        }) as unknown as OpenClawEngineManager,
      requestGateway: vi.fn().mockResolvedValue({
        plugins: [
          {
            id: 'memory-core',
            name: 'External Memory',
            installed: true,
            enabled: true,
            state: 'enabled',
            origin: 'path',
            removable: true,
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      }),
    });

    await expect(externalService.listCatalog()).resolves.toEqual([
      expect.objectContaining({ id: 'memory-core', description: '' }),
    ]);
  });

  it('refreshes stale Gateway metadata after an external CLI installs an extension', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'external-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'external-extension', name: 'External Extension' }),
    );
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({ plugins: {} }));
    const requestGateway = vi
      .fn()
      .mockResolvedValueOnce({
        plugins: [
          {
            id: 'external-extension',
            name: 'External Extension',
            installed: false,
            enabled: false,
            state: 'not-installed',
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      })
      .mockResolvedValueOnce({ ok: true, restartRequired: true })
      .mockResolvedValueOnce({
        plugins: [
          {
            id: 'external-extension',
            name: 'External Extension',
            installed: true,
            enabled: true,
            state: 'enabled',
            removable: true,
          },
        ],
        diagnostics: [],
        mutationAllowed: true,
      });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStateDir: () => stateDir,
          getBaseDir: () => path.join(fixtureRoot, 'openclaw-home'),
          getConfigPath: () => path.join(stateDir, 'openclaw.json'),
        }) as unknown as OpenClawEngineManager,
      requestGateway,
    });

    await expect(service.listCatalog()).resolves.toEqual([
      expect.objectContaining({ id: 'external-extension', enabled: true }),
    ]);
    expect(requestGateway).toHaveBeenNthCalledWith(2, 'plugins.refresh', {});
    expect(requestGateway).toHaveBeenNthCalledWith(3, 'plugins.list', {});
  });

  it.each([true, false])(
    'synchronizes the team skill through native APIs when enabled=%s',
    async enabled => {
      const requestGateway = vi.fn().mockResolvedValue({ ok: true, restartRequired: false });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({ getStatus: () => ({ phase: 'running' }) }) as OpenClawEngineManager,
        requestGateway,
      });
      await expect(service.setEnabled('agent-team', enabled)).resolves.toEqual({ success: true });
      expect(requestGateway.mock.calls).toEqual([
        ['plugins.setEnabled', { pluginId: 'agent-team', enabled }],
        ['skills.update', { skillKey: 'agent-team', enabled }],
      ]);
    },
  );

  it('honors a required native reload even when the team skill write fails', async () => {
    const requestGateway = vi.fn(async method => {
      if (method === 'skills.update') throw new Error('Skill update unavailable');
      return { ok: true, restartRequired: true };
    });
    const restartGatewayAfterMutation = vi.fn().mockResolvedValue({ phase: 'running' });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({ getStatus: () => ({ phase: 'running' }) }) as OpenClawEngineManager,
      requestGateway,
      restartGatewayAfterMutation,
    });
    await expect(service.setEnabled('agent-team', false)).resolves.toMatchObject({
      success: false,
    });
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-status-change');
  });

  it('reports partial team skill failure and repairs it when retrying the same state', async () => {
    let skillAttempts = 0;
    const requestGateway = vi.fn(async method => {
      if (method === 'skills.update' && ++skillAttempts === 1)
        throw new Error('gateway not connected');
      return { ok: true, restartRequired: false };
    });
    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({ getStatus: () => ({ phase: 'running' }) }) as OpenClawEngineManager,
      requestGateway,
      runCommand,
    });
    await expect(service.setEnabled('agent-team', true)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Agent Team'),
    });
    expect(runCommand).not.toHaveBeenCalled();
    await expect(service.setEnabled('agent-team', true)).resolves.toEqual({ success: true });
    expect(skillAttempts).toBe(2);
  });

  it.each([true, false])(
    'repairs the team skill through the cold CLI even when plugin enabled=%s already matches',
    async enabled => {
      const stateDir = path.join(fixtureRoot, 'state');
      const configPath = path.join(stateDir, 'openclaw.json');
      const extensionDir = path.join(stateDir, 'extensions', 'agent-team');
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(
        path.join(extensionDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'agent-team' }),
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          plugins: { entries: { 'agent-team': { enabled } } },
          skills: { load: { watch: false }, entries: { 'agent-team': { enabled: !enabled } } },
        }),
      );
      const runCommand = vi.fn(async (_executable, args) => {
        expect(args.slice(1)).toEqual([
          'config',
          'set',
          'skills.entries.agent-team.enabled',
          String(enabled),
          '--strict-json',
        ]);
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.skills.entries['agent-team'].enabled = enabled;
        fs.writeFileSync(configPath, JSON.stringify(config));
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({
            getStatus: () => ({ phase: 'ready' }),
            getStateDir: () => stateDir,
            getConfigPath: () => configPath,
            getBaseDir: () => stateDir,
            buildCliEnvironment: async () => ({
              env: {},
              runtimeRoot: fixtureRoot,
              openclawEntry: 'openclaw.mjs',
            }),
          }) as unknown as OpenClawEngineManager,
        runCommand,
      });
      await expect(service.setEnabled('agent-team', enabled)).resolves.toEqual({ success: true });
      expect(runCommand).toHaveBeenCalledOnce();
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).skills.load.watch).toBe(false);
    },
  );

  it('uses Gateway mutations and restarts only when OpenClaw requests it', async () => {
    const restartGatewayAfterMutation = vi.fn().mockResolvedValue({ phase: 'running' });
    const requestGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, restartRequired: false })
      .mockResolvedValueOnce({ ok: true, restartRequired: true, removed: ['files'] });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStateDir: () => path.join(fixtureRoot, 'state'),
          getStatus: () => ({ phase: 'ready' }),
        }) as OpenClawEngineManager,
      requestGateway,
      restartGatewayAfterMutation,
    });

    await expect(service.setEnabled('sample-extension', true)).resolves.toEqual({ success: true });
    expect(restartGatewayAfterMutation).not.toHaveBeenCalled();
    await expect(service.delete('sample-extension')).resolves.toEqual({ success: true });
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-delete');
    expect(requestGateway).toHaveBeenNthCalledWith(1, 'plugins.setEnabled', {
      pluginId: 'sample-extension',
      enabled: true,
    });
    expect(requestGateway).toHaveBeenNthCalledWith(2, 'plugins.uninstall', {
      pluginId: 'sample-extension',
    });
  });

  it('retries a Gateway uninstall file lock through the lock-aware cold CLI path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'locked-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'locked-extension' }),
    );
    let phase = 'running';
    const stop = vi.fn(async () => {
      phase = 'ready';
    });
    const start = vi.fn(async () => {
      phase = 'running';
      return { running: true };
    });
    const manager = {
      getStatus: vi.fn(() => ({ phase })),
      getStateDir: vi.fn(() => stateDir),
      getBaseDir: vi.fn(() => path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn(() => path.join(stateDir, 'openclaw.json')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const requestGateway = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'UNAVAILABLE',
        message: `Failed to remove plugin directory ${installedDir}; the plugin remains disabled and tracked so uninstall can be retried.`,
      })
      .mockResolvedValueOnce({
        plugins: [{ id: 'locked-extension', installed: true }],
      });
    const runCommand = vi.fn(async () => {
      expect(phase).toBe('ready');
      fs.rmSync(installedDir, { recursive: true, force: true });
      return {
        exitCode: 0,
        stdout: 'Uninstalled plugin "locked-extension"',
        stderr: '',
      };
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway,
      runCommand,
      directoryOperations: new ManagedDirectoryOperationCoordinator({
        runtime: {
          isRunning: () => phase === 'running',
          ownsProcess: pid => pid === 4242,
          prepareStop: async () => ({ ready: true, token: 'lock-retry' }),
          stop,
          start,
        },
        findLockingProcesses: vi.fn(async () => ({
          available: true,
          processes: [{ name: 'OpenClaw Gateway', pid: 4242 }],
        })),
      }),
    });

    await expect(service.delete('locked-extension')).resolves.toEqual({ success: true });
    expect(requestGateway).toHaveBeenNthCalledWith(1, 'plugins.uninstall', {
      pluginId: 'locked-extension',
    });
    expect(requestGateway).toHaveBeenNthCalledWith(2, 'plugins.list', {});
    expect(runCommand).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('refreshes the live plugin registry after a CLI uninstall fallback', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'removed-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'removed-extension' }),
    );
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getStateDir: () => stateDir,
      getBaseDir: () => fixtureRoot,
      getConfigPath: () => path.join(stateDir, 'openclaw.json'),
      buildCliEnvironment: async () => ({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: fixtureRoot,
        openclawEntry: path.join(fixtureRoot, 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const requestGateway = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Gateway unavailable'), { code: 'CLIENT_CLOSED' }),
      )
      .mockResolvedValueOnce({ ok: true, restartRequired: false });
    const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway,
      restartGatewayAfterMutation: restartGateway,
      runCommand: vi.fn(async () => {
        fs.rmSync(installedDir, { recursive: true, force: true });
        return { exitCode: 0, stdout: 'Uninstalled plugin "removed-extension"', stderr: '' };
      }),
    });

    await expect(service.delete('removed-extension')).resolves.toEqual({ success: true });
    expect(requestGateway).toHaveBeenLastCalledWith('plugins.refresh', {});
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it('restores a Gateway that drops during uninstall after the cold retry succeeds', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'dropped-gateway-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'dropped-gateway-extension' }),
    );
    let phase = 'running';
    const manager = {
      getStatus: vi.fn(() => ({ phase })),
      getStateDir: vi.fn(() => stateDir),
      getBaseDir: vi.fn(() => path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn(() => path.join(stateDir, 'openclaw.json')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const requestGateway = vi.fn(async () => {
      phase = 'ready';
      throw Object.assign(new Error('Gateway client stopped'), { code: 'CLIENT_CLOSED' });
    });
    const runCommand = vi.fn(async () => {
      fs.rmSync(installedDir, { recursive: true, force: true });
      return {
        exitCode: 0,
        stdout: 'Uninstalled plugin "dropped-gateway-extension"',
        stderr: '',
      };
    });
    const restartGatewayAfterMutation = vi.fn(async () => {
      phase = 'running';
      return { phase: 'running' };
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway,
      runCommand,
      restartGatewayAfterMutation,
      directoryOperations: new ManagedDirectoryOperationCoordinator({
        findLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
      }),
    });

    await expect(service.delete('dropped-gateway-extension')).resolves.toEqual({ success: true });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-delete');
    expect(phase).toBe('running');
  });

  it('does not repeat uninstall when Gateway inventory confirms the mutation committed', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'removed-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'removed-extension' }),
    );
    const manager = {
      getStateDir: vi.fn(() => stateDir),
      getStatus: vi.fn(() => ({ phase: 'running' })),
    } as unknown as OpenClawEngineManager;
    const requestGateway = vi
      .fn()
      .mockImplementationOnce(async () => {
        fs.rmSync(installedDir, { recursive: true, force: true });
        throw Object.assign(new Error('EPERM: operation not permitted'), {
          code: 'UNAVAILABLE',
        });
      })
      .mockResolvedValueOnce({ plugins: [] });
    const restartGatewayAfterMutation = vi.fn().mockResolvedValue({ phase: 'running' });
    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway,
      restartGatewayAfterMutation,
      runCommand,
    });

    await expect(service.delete('removed-extension')).resolves.toEqual({ success: true });
    expect(requestGateway).toHaveBeenNthCalledWith(2, 'plugins.list', {});
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-delete');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('returns the authoritative capability review and forwards its token on retry', async () => {
    const reviewToken = 'review-token';
    const consentError = Object.assign(new Error('Capability consent is required'), {
      code: 'INVALID_REQUEST',
      details: {
        capabilityConsentCode: 'PLUGIN_CAPABILITY_CONSENT_REQUIRED',
        pluginId: 'sample-extension',
        reviewToken,
        widened: { tools: ['sample.write'] },
      },
    });
    const declared = {
      channels: [],
      providers: [],
      tools: ['sample.read', 'sample.write'],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    };
    const requestGateway = vi
      .fn()
      .mockRejectedValueOnce(consentError)
      .mockResolvedValueOnce({
        ok: true,
        plugin: { id: 'sample-extension' },
        declared,
        reviewToken,
        grants: {},
        trust: { disposition: 'review-required', reasons: ['New write tool'] },
      })
      .mockResolvedValueOnce({ ok: true, restartRequired: false, warnings: ['Reviewed'] });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({ getStatus: () => ({ phase: 'ready' }) }) as OpenClawEngineManager,
      requestGateway,
    });

    await expect(service.setEnabled('sample-extension', true)).resolves.toMatchObject({
      success: false,
      capabilityReview: {
        reviewToken,
        declared,
        widened: { tools: ['sample.write'] },
      },
    });
    await expect(service.setEnabled('sample-extension', true, reviewToken)).resolves.toEqual({
      success: true,
      warnings: ['Reviewed'],
    });
    expect(requestGateway).toHaveBeenLastCalledWith('plugins.setEnabled', {
      pluginId: 'sample-extension',
      enabled: true,
      acknowledgeCapabilities: { reviewToken },
    });
  });

  it('enables a network sidecar without an outbound-header capability review', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'network-extension');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'network-extension', name: 'Network Extension' }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { 'network-extension': { enabled: false } } } }),
    );
    const requestGateway = vi.fn(async () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ plugins: { entries: { 'network-extension': { enabled: true } } } }),
      );
      return { ok: true, restartRequired: false };
    });
    const reconcile = vi
      .fn()
      .mockReturnValueOnce({
        overwrite: false,
        enabled: true,
        groups: [],
        digest: 'before-enable',
      })
      .mockReturnValue({
        overwrite: false,
        enabled: true,
        groups: [],
        digest: 'after-enable',
      });
    const restartGatewayAfterMutation = vi.fn().mockResolvedValue({ phase: 'running' });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStatus: () => ({ phase: 'ready' }),
          getStateDir: () => stateDir,
          getBaseDir: () => fixtureRoot,
          getConfigPath: () => configPath,
        }) as OpenClawEngineManager,
      requestGateway,
      restartGatewayAfterMutation,
      outboundHeaderPolicy: {
        inspectExtension: vi.fn(),
        reconcile,
      },
    });

    await expect(service.setEnabled('network-extension', true)).resolves.toEqual({
      success: true,
      warnings: undefined,
    });
    expect(requestGateway).toHaveBeenLastCalledWith('plugins.setEnabled', {
      pluginId: 'network-extension',
      enabled: true,
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-network-policy-change');
  });

  it('converges policy and restores Gateway when an enable response is lost after commit', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'response-lost-extension');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'response-lost-extension' }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { 'response-lost-extension': { enabled: false } } } }),
    );
    let phase = 'running';
    const requestGateway = vi.fn(async () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ plugins: { entries: { 'response-lost-extension': { enabled: true } } } }),
      );
      phase = 'ready';
      throw Object.assign(new Error('Gateway response was lost'), { code: 'CLIENT_CLOSED' });
    });
    const reconcile = vi
      .fn()
      .mockReturnValueOnce({ overwrite: false, enabled: false, groups: [], digest: 'before' })
      .mockReturnValue({ overwrite: false, enabled: true, groups: [], digest: 'after' });
    const restartGatewayAfterMutation = vi.fn(async () => {
      phase = 'running';
      return { phase: 'running' };
    });
    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStatus: () => ({ phase }),
          getStateDir: () => stateDir,
          getBaseDir: () => fixtureRoot,
          getConfigPath: () => configPath,
        }) as OpenClawEngineManager,
      requestGateway,
      runCommand,
      restartGatewayAfterMutation,
      outboundHeaderPolicy: { inspectExtension: vi.fn(), reconcile },
    });

    await expect(service.setEnabled('response-lost-extension', true)).resolves.toEqual({
      success: true,
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-network-policy-change');
    expect(phase).toBe('running');
  });

  it('removes a partially disabled extension policy even when cold uninstall fails', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'partially-disabled-extension');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'partially-disabled-extension' }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: { entries: { 'partially-disabled-extension': { enabled: true } } },
      }),
    );
    const requestGateway = vi
      .fn()
      .mockImplementationOnce(async () => {
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            plugins: { entries: { 'partially-disabled-extension': { enabled: false } } },
          }),
        );
        throw Object.assign(new Error(`Failed to remove plugin directory ${installedDir}`), {
          code: 'UNAVAILABLE',
        });
      })
      .mockResolvedValueOnce({
        plugins: [{ id: 'partially-disabled-extension', installed: true }],
      });
    const reconcile = vi
      .fn()
      .mockReturnValueOnce({ overwrite: false, enabled: true, groups: [], digest: 'before' })
      .mockReturnValue({ overwrite: false, enabled: false, groups: [], digest: 'after' });
    const restartGatewayAfterMutation = vi.fn().mockResolvedValue({ phase: 'running' });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStatus: () => ({ phase: 'running' }),
          getStateDir: () => stateDir,
          getBaseDir: () => fixtureRoot,
          getConfigPath: () => configPath,
          buildCliEnvironment: async () => ({
            env: { OPENCLAW_STATE_DIR: stateDir },
            runtimeRoot: fixtureRoot,
            openclawEntry: path.join(fixtureRoot, 'openclaw.mjs'),
          }),
        }) as OpenClawEngineManager,
      requestGateway,
      runCommand: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'locked' }),
      restartGatewayAfterMutation,
      outboundHeaderPolicy: { inspectExtension: vi.fn(), reconcile },
      directoryOperations: new ManagedDirectoryOperationCoordinator({
        findLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
      }),
    });

    await expect(service.delete('partially-disabled-extension')).resolves.toMatchObject({
      success: false,
    });
    expect(reconcile).toHaveBeenCalled();
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-network-policy-change');
  });

  it('still disables an extension when its installed network sidecar is invalid', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'invalid-network-extension');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'invalid-network-extension' }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: { entries: { 'invalid-network-extension': { enabled: true } } },
      }),
    );
    const requestGateway = vi.fn(async (method: string) => {
      expect(method).toBe('plugins.setEnabled');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          plugins: { entries: { 'invalid-network-extension': { enabled: false } } },
        }),
      );
      return { ok: true, restartRequired: false };
    });
    const reconcile = vi.fn(() => ({
      overwrite: false,
      enabled: false,
      groups: [],
      digest: 'disabled',
    }));
    const restartGatewayAfterMutation = vi.fn().mockResolvedValue({ phase: 'running' });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStatus: () => ({ phase: 'ready' }),
          getStateDir: () => stateDir,
          getBaseDir: () => fixtureRoot,
          getConfigPath: () => configPath,
        }) as OpenClawEngineManager,
      requestGateway,
      restartGatewayAfterMutation,
      outboundHeaderPolicy: {
        inspectExtension: () => {
          throw new Error('Invalid network sidecar');
        },
        reconcile,
      },
    });

    await expect(service.setEnabled('invalid-network-extension', false)).resolves.toEqual({
      success: true,
      warnings: undefined,
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(restartGatewayAfterMutation).not.toHaveBeenCalled();
  });

  it('uses local inventory only when the Gateway transport is unavailable', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'sample-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'sample-extension', name: 'Sample Extension' }),
    );
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({ plugins: {} }));
    const requestGateway = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('gateway not connected'), { code: 'UNAVAILABLE' }),
      );
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStateDir: () => stateDir,
          getBaseDir: () => path.join(fixtureRoot, 'openclaw-home'),
          getConfigPath: () => path.join(stateDir, 'openclaw.json'),
        }) as unknown as OpenClawEngineManager,
      requestGateway,
    });

    await expect(service.listCatalog()).resolves.toEqual([
      expect.objectContaining({
        id: 'sample-extension',
        origin: 'local-recovery',
        canToggle: true,
        removable: true,
      }),
    ]);
  });

  it('does not bypass authoritative Gateway lifecycle failures with the cold CLI', async () => {
    const requestGateway = vi.fn().mockRejectedValue(
      Object.assign(new Error('Plugin inventory transaction failed'), {
        code: 'UNAVAILABLE',
      }),
    );
    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({ getStatus: () => ({ phase: 'ready' }) }) as OpenClawEngineManager,
      requestGateway,
      runCommand,
    });

    await expect(service.setEnabled('sample-extension', false)).resolves.toEqual({
      success: false,
      error: 'Plugin inventory transaction failed',
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'installs a native OpenClaw extension and restarts Gateway (archive: %s)',
    async archive => {
      const sourceDir = path.join(fixtureRoot, 'sample-extension');
      const stateDir = path.join(fixtureRoot, 'state');
      const configPath = path.join(stateDir, 'openclaw.json');
      fs.mkdirSync(sourceDir);
      fs.writeFileSync(
        path.join(sourceDir, 'openclaw.plugin.json'),
        JSON.stringify({
          id: 'sample-extension',
          configSchema: { type: 'object', additionalProperties: false },
        }),
      );
      fs.mkdirSync(stateDir);
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              'automation-permission': { enabled: true },
              workboard: { enabled: true },
              'untrusted-user-entry': { enabled: true },
            },
          },
        }),
      );
      const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
      const manager = {
        getStatus: vi.fn().mockReturnValue({ phase: 'running' }),
        getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
        buildCliEnvironment: vi.fn().mockResolvedValue({
          env: {
            OPENCLAW_STATE_DIR: stateDir,
            NPM_CONFIG_USERCONFIG: path.join(fixtureRoot, 'dependency-config', '.npmrc'),
          },
          runtimeRoot: path.join(fixtureRoot, 'runtime'),
          openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
        }),
        restartGateway,
      } as unknown as OpenClawEngineManager;
      const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => manager,
        getManagedPluginIds: () => ['automation-permission', 'workboard'],
        restartGatewayAfterMutation: () => restartGateway(),
        runCommand,
      });

      const sourcePath = archive ? path.join(fixtureRoot, 'native.tgz') : sourceDir;
      if (archive) {
        await tar.create({ file: sourcePath, cwd: fixtureRoot, gzip: true }, ['sample-extension']);
      }
      await expect(service.importPath(sourcePath)).resolves.toEqual({
        success: true,
        extensionId: 'sample-extension',
      });
      expect(runCommand).toHaveBeenCalledWith(
        process.execPath,
        [
          path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
          'plugins',
          'install',
          sourcePath,
          '--force',
        ],
        expect.objectContaining({
          cwd: path.join(fixtureRoot, 'runtime'),
          env: expect.objectContaining({
            OPENCLAW_HOME: path.join(fixtureRoot, 'openclaw-home'),
            OPENCLAW_STATE_DIR: path.join(fixtureRoot, 'state'),
            NPM_CONFIG_USERCONFIG: path.join(fixtureRoot, 'dependency-config', '.npmrc'),
          }),
        }),
      );
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
        plugins: {
          allow: ['automation-permission', 'workboard', 'sample-extension'],
          entries: {
            'automation-permission': { enabled: true },
            workboard: { enabled: true },
            'untrusted-user-entry': { enabled: true },
          },
        },
      });
      expect(restartGateway).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { receipt: '', reloadAccepted: false, runtimeApplied: false },
    { receipt: '', reloadAccepted: true, runtimeApplied: false },
    {
      receipt: 'Installed plugin: hot-extension\nSaved for the next Gateway start.',
      reloadAccepted: true,
      runtimeApplied: false,
    },
    {
      receipt: 'Installed plugin: hot-extension\nApplied in Gateway generation 4.',
      reloadAccepted: true,
      runtimeApplied: true,
    },
    {
      receipt: 'Installed plugin: another-extension\nApplied in Gateway generation 4.',
      reloadAccepted: true,
      runtimeApplied: false,
    },
  ])(
    'converges a CLI installed extension (receipt: $receipt, reload accepted: $reloadAccepted)',
    async ({ receipt, reloadAccepted, runtimeApplied }) => {
      const sourceDir = path.join(fixtureRoot, 'hot-extension');
      const stateDir = path.join(fixtureRoot, 'state');
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(stateDir);
      fs.writeFileSync(
        path.join(sourceDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'hot-extension', configSchema: { type: 'object' } }),
      );
      const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
      const requestGateway = vi.fn().mockResolvedValue({
        ok: true,
        restartRequired: !reloadAccepted,
      });
      const manager = {
        getStatus: () => ({ phase: 'running' }),
        getBaseDir: () => fixtureRoot,
        buildCliEnvironment: async () => ({
          env: { OPENCLAW_STATE_DIR: stateDir },
          runtimeRoot: fixtureRoot,
          openclawEntry: path.join(fixtureRoot, 'openclaw.mjs'),
        }),
      } as unknown as OpenClawEngineManager;
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => manager,
        requestGateway,
        restartGatewayAfterMutation: restartGateway,
        runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: receipt, stderr: '' }),
      });

      await expect(
        service.importPath(sourceDir, undefined, undefined, {
          trustMarketplaceSource: true,
        }),
      ).resolves.toEqual({ success: true, extensionId: 'hot-extension' });
      if (runtimeApplied) {
        expect(requestGateway).not.toHaveBeenCalled();
      } else {
        expect(requestGateway).toHaveBeenCalledWith('plugins.reload', {
          plugins: [{ pluginId: 'hot-extension' }],
        });
      }
      expect(restartGateway).toHaveBeenCalledTimes(reloadAccepted ? 0 : 1);
    },
  );

  it.each(['failure result', 'exception'])(
    'retains the installed extension identity when Gateway application fails: %s', async failure => {
      const sourceDir = path.join(fixtureRoot, 'partial-extension');
      const stateDir = path.join(fixtureRoot, 'state');
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(sourceDir, 'openclaw.plugin.json'),
        JSON.stringify({ id: 'partial-extension', configSchema: { type: 'object' } }));
      const restartGatewayAfterMutation = vi.fn();
      if (failure === 'exception') restartGatewayAfterMutation.mockRejectedValue(new Error('restart failed'));
      else restartGatewayAfterMutation.mockResolvedValue({ phase: 'error', message: 'restart failed' });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => ({
          getStatus: () => ({ phase: 'running' }), getBaseDir: () => fixtureRoot,
          buildCliEnvironment: async () => ({ env: { OPENCLAW_STATE_DIR: stateDir },
            runtimeRoot: fixtureRoot, openclawEntry: path.join(fixtureRoot, 'openclaw.mjs') }),
        }) as unknown as OpenClawEngineManager,
        requestGateway: vi.fn().mockResolvedValue({ ok: true, restartRequired: true }),
        restartGatewayAfterMutation,
        runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Installed plugin: partial-extension\nSaved for the next Gateway start.', stderr: '' }),
      });

      await expect(service.importPath(sourceDir, undefined, undefined, { trustMarketplaceSource: true }))
        .resolves.toMatchObject({ success: false, extensionId: 'partial-extension', error: 'restart failed' });
    },
  );

  it.each(['Applied in Gateway generation 4.', 'Saved for the next Gateway start.'])(
    'waits for the final installer receipt even if the CLI keeps handles open: %s',
    async receipt => {
      const result = await __openClawExtensionImportTestUtils.runCommand(
        process.execPath,
        [
          '-e',
          `console.log('Installed plugin: sample-extension'); setTimeout(() => console.log(${JSON.stringify(receipt)}), 500); setInterval(() => {}, 1000);`,
        ],
        {
          cwd: fixtureRoot,
          env: process.env,
          successPattern:
            __openClawExtensionImportTestUtils.createInstallSuccessPattern('sample-extension'),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).not.toBe(true);
      expect(result.stdout).toContain('Installed plugin: sample-extension');
      expect(result.stdout).toContain(receipt);
    },
  );

  it.each([
    'Installed plugin: sample-extension',
    'Applied in Gateway generation 4.',
    'Saved for the next Gateway start.',
    'Installed plugin: another-extension\nApplied in Gateway generation 4.',
  ])(
    'preserves a delayed installer failure after nonterminal or unrelated output: %s',
    async output => {
      const result = await __openClawExtensionImportTestUtils.runCommand(
        process.execPath,
        [
          '-e',
          `console.log(${JSON.stringify(output)}); setTimeout(() => { console.error('Installation failed'); process.exit(1); }, 500);`,
        ],
        {
          cwd: fixtureRoot,
          env: process.env,
          successPattern:
            __openClawExtensionImportTestUtils.createInstallSuccessPattern('sample-extension'),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Installation failed');
    },
  );

  it.each([
    { stream: 'stderr', delayMs: 500 },
    { stream: 'stdout', delayMs: 100 },
  ])('preserves CLI errors despite receipt text on $stream', async ({ stream, delayMs }) => {
    const receipt = 'Installed plugin: sample-extension\nApplied in Gateway generation 4.\n';
    const result = await __openClawExtensionImportTestUtils.runCommand(
      process.execPath,
      [
        '-e',
        `process.${stream}.write(${JSON.stringify(receipt)}); setTimeout(() => process.exit(1), ${delayMs});`,
      ],
      {
        cwd: fixtureRoot,
        env: process.env,
        successPattern:
          __openClawExtensionImportTestUtils.createInstallSuccessPattern('sample-extension'),
      },
    );
    expect(result.exitCode).toBe(1);
  });

  it('requires an OpenClaw capability review token before accepting local capabilities', async () => {
    const sourceDir = path.join(fixtureRoot, 'reviewed-extension');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'reviewed-extension' }),
    );
    const manager = {
      getStatus: vi.fn().mockReturnValue({ phase: 'ready' }),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: path.join(fixtureRoot, 'state') },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const review: import('../../../shared/plugins/extensions').OpenClawPluginCapabilityReview = {
      reviewToken: 'current-surface-token',
      declared: {
        channels: [],
        providers: [],
        tools: ['reviewed.write'],
        contracts: [],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      source: { kind: 'path', spec: sourceDir },
      grants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      },
      trust: { disposition: 'review-required', reasons: ['Local source'] },
    };
    const inspectCapabilityReview = vi.fn().mockResolvedValue({
      extensionId: 'reviewed-extension',
      review,
    });
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway: vi.fn(),
      inspectCapabilityReview,
      runCommand,
      directoryOperations: new ManagedDirectoryOperationCoordinator({
        findLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
      }),
    });

    await expect(service.importPath(sourceDir)).resolves.toEqual({
      success: false,
      extensionId: 'reviewed-extension',
      capabilityReview: review,
      failedStage: 'validating',
    });
    expect(runCommand).not.toHaveBeenCalled();

    await expect(
      service.importPath(sourceDir, undefined, undefined, { trustMarketplaceSource: true }),
    ).resolves.toEqual({ success: true, extensionId: 'reviewed-extension' });
    expect(inspectCapabilityReview).toHaveBeenCalledTimes(1);

    await expect(service.importPath(sourceDir, undefined, review.reviewToken)).resolves.toEqual({
      success: true,
      extensionId: 'reviewed-extension',
    });
    expect(inspectCapabilityReview).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
        'plugins',
        'install',
        sourceDir,
        '--force',
        '--accept-capabilities',
      ],
      expect.any(Object),
    );
  });

  it.skipIf(
    !fs.existsSync(path.resolve('vendor/openclaw-runtime/current/dist')) ||
      !fs.existsSync(path.resolve('../openclaw/extensions/browser')),
  )('reads capability reviews through the locked OpenClaw runtime scanner', async () => {
    const runtimeRoot = fs.realpathSync(path.resolve('vendor/openclaw-runtime/current'));
    const sourceDir = path.resolve('../openclaw/extensions/browser');
    const stateDir = path.join(fixtureRoot, 'state');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    const manager = {
      getStatus: vi.fn().mockReturnValue({ phase: 'ready' }),
      getBaseDir: vi.fn().mockReturnValue(stateDir),
      getConfigPath: vi.fn().mockReturnValue(configPath),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot,
        openclawEntry: path.join(runtimeRoot, 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway: vi.fn(),
    });

    const result = await service.importPath(sourceDir);

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      success: false,
      extensionId: 'browser',
      capabilityReview: {
        declared: { tools: ['browser'] },
        grants: {
          hooks: {
            allowConversationAccess: { effective: false },
          },
        },
      },
      failedStage: 'validating',
    });
    expect(result.capabilityReview?.reviewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.capabilityReview?.grants.hooks.allowPromptInjection.effective).toEqual(
      expect.any(Boolean),
    );
  });

  it('activates an imported network sidecar after a locked directory mutation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const sourceDir = path.join(fixtureRoot, 'locked-extension');
    const stateDir = path.join(fixtureRoot, 'state');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'locked-extension' }),
    );
    fs.writeFileSync(
      path.join(sourceDir, 'outbound-header-policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        groups: [
          {
            baseUrlWhitelist: ['https://locked.example/v1/'],
            headerNames: ['X-Locked-Token'],
          },
        ],
      }),
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({ plugins: {} }));
    let phase = 'running';
    const stopGateway = vi.fn(async () => {
      phase = 'ready';
    });
    const startGateway = vi.fn(async () => {
      phase = 'running';
      return { phase: 'running' };
    });
    const restartGateway = vi.fn();
    const manager = {
      getStatus: vi.fn(() => ({ phase })),
      getStateDir: vi.fn(() => stateDir),
      getBaseDir: vi.fn(() => path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn(() => path.join(stateDir, 'openclaw.json')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
      stopGateway,
      startGateway,
      restartGateway,
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn(async () => {
      expect(phase).toBe('ready');
      const installedDir = path.join(stateDir, 'extensions', 'locked-extension');
      fs.mkdirSync(installedDir, { recursive: true });
      fs.copyFileSync(
        path.join(sourceDir, 'openclaw.plugin.json'),
        path.join(installedDir, 'openclaw.plugin.json'),
      );
      fs.copyFileSync(
        path.join(sourceDir, 'outbound-header-policy.json'),
        path.join(installedDir, 'outbound-header-policy.json'),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const restartGatewayAfterMutation = vi.fn().mockResolvedValue({ phase: 'running' });
    const reconcile = vi
      .fn()
      .mockReturnValueOnce({
        overwrite: false,
        enabled: true,
        groups: [],
        digest: 'before-import',
      })
      .mockReturnValue({
        overwrite: false,
        enabled: true,
        groups: [],
        digest: 'after-import',
      });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand,
      restartGatewayAfterMutation,
      outboundHeaderPolicy: {
        inspectExtension: () => ({
          manifest: {
            schemaVersion: 1,
            groups: [
              {
                baseUrlWhitelist: ['https://locked.example/v1/'],
                headerNames: ['X-Locked-Token'],
              },
            ],
          },
        }),
        reconcile,
      },
      directoryOperations: new ManagedDirectoryOperationCoordinator({
        runtime: {
          isRunning: () => phase === 'running' || phase === 'starting',
          ownsProcess: pid => pid === 4242,
          prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
          stop: stopGateway,
          start: async () => {
            const status = await startGateway();
            return { running: status.phase === 'running' };
          },
        },
        findLockingProcesses: vi.fn(async () => ({
          available: true,
          processes: [{ name: 'OpenClaw Gateway', pid: 4242 }],
        })),
      }),
    });

    await expect(service.importPath(sourceDir)).resolves.toEqual({
      success: true,
      extensionId: 'locked-extension',
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(startGateway).toHaveBeenCalledOnce();
    expect(restartGateway).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(restartGatewayAfterMutation).toHaveBeenCalledWith('extension-network-policy-change');
  });

  it('reports an external owner before deleting any extension files', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'locked-extension');
    const manifestPath = path.join(installedDir, 'openclaw.plugin.json');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ id: 'locked-extension', name: 'Locked Extension' }),
    );
    const manager = {
      getStateDir: vi.fn(() => stateDir),
      getBaseDir: vi.fn(() => path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn(() => path.join(stateDir, 'openclaw.json')),
      getStatus: vi.fn(() => ({ phase: 'running' })),
      getGatewayProcessId: vi.fn(() => 4242),
      buildCliEnvironment: vi.fn(),
      stopGateway: vi.fn(),
      startGateway: vi.fn(),
      restartGateway: vi.fn(),
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand,
      directoryOperations: new ManagedDirectoryOperationCoordinator({
        findLockingProcesses: vi.fn(async () => ({
          available: true,
          processes: [{ name: 'Typora', pid: 38412 }],
        })),
      }),
    });

    const result = await service.delete('locked-extension');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Typora (PID 38412)');
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.readFileSync(manifestPath, 'utf8')).toContain('locked-extension');
    expect(fs.readdirSync(installedDir)).toEqual(['openclaw.plugin.json']);
  });

  it('diagnoses a CLI permission error without an error code as a directory lock', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const sourceDir = path.join(fixtureRoot, 'locked-extension');
    const stateDir = path.join(fixtureRoot, 'state');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'locked-extension' }),
    );
    const manager = {
      getStatus: vi.fn(() => ({ phase: 'ready' })),
      getStateDir: vi.fn(() => stateDir),
      getBaseDir: vi.fn(() => path.join(fixtureRoot, 'openclaw-home')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const findLockingProcesses = vi
      .fn()
      .mockResolvedValueOnce({ available: true, processes: [] })
      .mockResolvedValueOnce({
        available: true,
        processes: [{ name: 'explorer', pid: 10856 }],
      });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: `Permission denied: '${path.join(stateDir, 'extensions', 'locked-extension')}'`,
      }),
      directoryOperations: new ManagedDirectoryOperationCoordinator({ findLockingProcesses }),
    });

    const result = await service.importPath(sourceDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('explorer (PID 10856)');
    expect(findLockingProcesses).toHaveBeenCalledTimes(2);
  });

  it('preflights the real install directory when its name differs from the extension id', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const sourceDir = path.join(fixtureRoot, 'update-source');
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'directory-alias');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'canonical-extension' }),
    );
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'canonical-extension', name: 'Canonical Extension' }),
    );
    const manager = {
      getStatus: vi.fn(() => ({ phase: 'ready' })),
      getStateDir: vi.fn(() => stateDir),
      getBaseDir: vi.fn(() => path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn(() => path.join(stateDir, 'openclaw.json')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const findLockingProcesses = vi.fn(async (targetPath: string) => ({
      available: true,
      processes: targetPath === installedDir ? [{ name: 'Typora', pid: 38412 }] : [],
    }));
    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand,
      directoryOperations: new ManagedDirectoryOperationCoordinator({ findLockingProcesses }),
    });

    const result = await service.importPath(sourceDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Typora (PID 38412)');
    expect(findLockingProcesses).toHaveBeenCalledWith(installedDir);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'stops a foreign bundle before installation (marketplace: %s)',
    async trustMarketplaceSource => {
      const sourceDir = path.join(fixtureRoot, 'claude-extension');
      fs.mkdirSync(path.join(sourceDir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ id: 'claude-extension', name: 'Claude Extension' }),
      );

      const stateDir = path.join(fixtureRoot, 'state');
      const manager = {
        getStatus: vi.fn().mockReturnValue({ phase: 'ready' }),
        getStateDir: vi.fn().mockReturnValue(stateDir),
        getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
        getConfigPath: vi.fn().mockReturnValue(path.join(stateDir, 'openclaw.json')),
        buildCliEnvironment: vi.fn().mockResolvedValue({
          env: { OPENCLAW_STATE_DIR: stateDir },
          runtimeRoot: path.join(fixtureRoot, 'runtime'),
          openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
        }),
      } as unknown as OpenClawEngineManager;
      const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => manager,
        runCommand,
      });

      const result = await service.importPath(sourceDir, undefined, undefined, {
        trustMarketplaceSource,
      });

      expect(result).toEqual({
        success: false,
        error: t('extensionConversionNotImplemented'),
        failedStage: 'validating',
      });
      expect(runCommand).not.toHaveBeenCalled();
      expect(manager.buildCliEnvironment).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('configures bundled Jev credentials without exposing values and refreshes rotated secrets', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    const bundledDir = path.join(runtimeRoot, 'dist', 'extensions', 'typesafe');
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.copyFileSync(
      'openclaw-extensions/typesafe/openclaw.plugin.json',
      path.join(bundledDir, 'openclaw.plugin.json'),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { typesafe: { enabled: false } } } }),
    );
    const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
    const manager = {
      getStateDir: () => stateDir,
      getBaseDir: () => fixtureRoot,
      getRuntimeRoot: () => runtimeRoot,
      getConfigPath: () => configPath,
      getStatus: () => ({ phase: 'running' }),
      getGatewayConfigReloadGeneration: vi.fn(),
      waitForGatewayConfigReload: vi.fn(),
    } as unknown as OpenClawEngineManager;
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      restartGatewayAfterMutation: restartGateway,
      requestGateway: vi.fn().mockResolvedValue({
        plugins: [
          {
            id: 'typesafe',
            name: 'TypeSafe AI',
            installed: true,
            origin: 'bundled',
            enabled: false,
            state: 'disabled',
            removable: false,
          },
        ],
        mutationAllowed: true,
        diagnostics: [],
      }),
    });
    expect((await service.listCatalog())[0]).toMatchObject({
      canToggle: true,
      removable: false,
      configurationFields: [
        expect.objectContaining({ path: 'apiKey', configured: false, sensitive: true }),
      ],
    });
    await expect(
      service.updateConfiguration('typesafe', { apiKey: 'synthetic-first-key' }),
    ).resolves.toEqual({ success: true });
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(saved.plugins.entries.typesafe.enabled).toBe(false);
    expect(saved.plugins.entries.typesafe.config.apiKey).toMatchObject({
      source: 'file',
      provider: 'justdo-extension-secrets',
    });
    expect(JSON.stringify(saved)).not.toContain('synthetic-first-key');
    const catalog = await service.listCatalog();
    expect(catalog[0].configurationFields[0].configured).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('synthetic-first-key');
    expect(restartGateway).toHaveBeenCalledTimes(1);
    await service.updateConfiguration('typesafe', { apiKey: 'synthetic-first-key' });
    expect(restartGateway).toHaveBeenCalledTimes(1);
    await service.updateConfiguration('typesafe', { apiKey: 'synthetic-rotated-key' });
    expect(restartGateway).toHaveBeenCalledTimes(2);
    expect(manager.waitForGatewayConfigReload).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(saved);
    const credentialStore = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'extension-secrets.json'), 'utf8'),
    );
    expect(credentialStore[saved.plugins.entries.typesafe.config.apiKey.id.slice(1)]).toBe(
      'synthetic-rotated-key',
    );
    await expect(
      service.updateConfiguration('../typesafe', { apiKey: 'synthetic-key' }),
    ).resolves.toMatchObject({ success: false });
  });

  it.each(['config-write', 'restart-throws', 'restart-error'])(
    'retries the same rotated credential after %s fails',
    async failure => {
      const stateDir = path.join(fixtureRoot, 'state');
      const runtimeRoot = path.join(fixtureRoot, 'runtime');
      const bundledDir = path.join(runtimeRoot, 'dist', 'extensions', 'typesafe');
      const configPath = path.join(stateDir, 'openclaw.json');
      fs.mkdirSync(bundledDir, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.copyFileSync(
        'openclaw-extensions/typesafe/openclaw.plugin.json',
        path.join(bundledDir, 'openclaw.plugin.json'),
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ plugins: { entries: { typesafe: { enabled: true } } } }),
      );
      let phase = 'running';
      const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
      const manager = {
        getStateDir: () => stateDir,
        getBaseDir: () => fixtureRoot,
        getRuntimeRoot: () => runtimeRoot,
        getConfigPath: () => configPath,
        getStatus: () => ({ phase }),
        getGatewayConfigReloadGeneration: vi.fn(),
        waitForGatewayConfigReload: vi.fn(),
      } as unknown as OpenClawEngineManager;
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => manager,
        restartGatewayAfterMutation: restartGateway,
      });
      await expect(
        service.updateConfiguration('typesafe', { apiKey: 'original-key' }),
      ).resolves.toEqual({ success: true });
      restartGateway.mockClear();
      const rename = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
        if (failure === 'config-write' && target === configPath)
          throw new Error('Synthetic write failure');
        rename(source, target);
      });
      if (failure === 'restart-throws')
        restartGateway.mockRejectedValueOnce(new Error('Synthetic restart failure'));
      if (failure === 'restart-error') restartGateway.mockResolvedValueOnce({ phase: 'error' });

      await expect(
        service.updateConfiguration('typesafe', { apiKey: 'rotated-key' }),
      ).resolves.toMatchObject({ success: false });
      renameSpy.mockRestore();
      if (failure === 'restart-error') phase = 'error';
      restartGateway.mockClear();

      await expect(
        service.updateConfiguration('typesafe', { apiKey: 'rotated-key' }),
      ).resolves.toEqual({ success: true });
      expect(restartGateway).toHaveBeenCalledTimes(1);
      expect(manager.waitForGatewayConfigReload).not.toHaveBeenCalled();
      phase = 'running';
      await expect(
        service.updateConfiguration('typesafe', { apiKey: 'rotated-key' }),
      ).resolves.toEqual({ success: true });
      expect(restartGateway).toHaveBeenCalledTimes(1);
    },
  );

  it('lists installed native extensions and ignores incomplete staging directories', () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'sample-extension');
    const stagingDir = path.join(stateDir, 'extensions', '.openclaw-install-stage-stale');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      `{
        // OpenClaw manifests may use JSON5.
        id: 'sample-extension',
        name: 'Sample Extension',
        description: 'A test extension',
      }`,
    );
    fs.writeFileSync(path.join(installedDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const manager = {
      getStateDir: vi.fn().mockReturnValue(stateDir),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn().mockReturnValue(path.join(stateDir, 'openclaw.json')),
    } as unknown as OpenClawEngineManager;
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
    });

    expect(service.listInstalled()).toEqual([
      {
        id: 'sample-extension',
        name: 'Sample Extension',
        description: 'A test extension',
        version: '1.2.3',
        installPath: installedDir,
        enabled: true,
        missingRequirements: [],
        configurationFields: [],
      },
    ]);

    fs.writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify({ plugins: { entries: { 'sample-extension': { enabled: false } } } }),
    );
    expect(service.listInstalled()[0].enabled).toBe(false);
  });

  it('fills local descriptions from compatible manifest and package metadata', () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const extensionsDir = path.join(stateDir, 'extensions');
    const shortDescriptionDir = path.join(extensionsDir, 'short-description');
    const packageDescriptionDir = path.join(extensionsDir, 'package-description');
    fs.mkdirSync(shortDescriptionDir, { recursive: true });
    fs.mkdirSync(packageDescriptionDir, { recursive: true });
    fs.writeFileSync(
      path.join(shortDescriptionDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'short-description', shortDescription: 'Short manifest summary.' }),
    );
    fs.writeFileSync(
      path.join(packageDescriptionDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'package-description' }),
    );
    fs.writeFileSync(
      path.join(packageDescriptionDir, 'package.json'),
      JSON.stringify({ description: 'Package summary.' }),
    );
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStateDir: () => stateDir,
          getBaseDir: () => path.join(fixtureRoot, 'openclaw-home'),
          getConfigPath: () => path.join(stateDir, 'openclaw.json'),
        }) as unknown as OpenClawEngineManager,
    });

    expect(service.listInstalled()).toEqual([
      expect.objectContaining({ id: 'package-description', description: 'Package summary.' }),
      expect.objectContaining({
        id: 'short-description',
        description: 'Short manifest summary.',
      }),
    ]);
  });

  it('lists installed bundle plugins with their OpenClaw-normalized id', () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'team-tools');
    fs.mkdirSync(path.join(installedDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'Team Tools', description: 'Internal tools', version: '2.0.0' }),
    );
    const manager = {
      getStateDir: vi.fn().mockReturnValue(stateDir),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn().mockReturnValue(path.join(stateDir, 'openclaw.json')),
    } as unknown as OpenClawEngineManager;
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
    });

    expect(service.listInstalled()).toEqual([
      expect.objectContaining({
        id: 'team-tools',
        name: 'Team Tools',
        description: 'Internal tools',
        version: '2.0.0',
        installPath: installedDir,
      }),
    ]);
  });

  it('reports provider environment variables that are not configured', () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'brave');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'brave',
        name: 'Brave',
        setup: {
          providers: [{ id: 'brave', envVars: ['JUSTDO_TEST_MISSING_EXTENSION_KEY'] }],
        },
        uiHints: {
          'webSearch.apiKey': { label: 'Brave Search API Key', sensitive: true },
        },
      }),
    );
    const manager = {
      getStateDir: vi.fn().mockReturnValue(stateDir),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn().mockReturnValue(path.join(stateDir, 'openclaw.json')),
    } as unknown as OpenClawEngineManager;
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
    });

    expect(service.listInstalled()[0].missingRequirements).toEqual([
      'JUSTDO_TEST_MISSING_EXTENSION_KEY',
    ]);
    expect(service.listInstalled()[0].configurationFields).toEqual([
      {
        path: 'webSearch.apiKey',
        label: 'Brave Search API Key',
        requirement: 'JUSTDO_TEST_MISSING_EXTENSION_KEY',
        sensitive: true,
        configured: false,
      },
    ]);

    const openClawHome = path.join(fixtureRoot, 'openclaw-home');
    fs.mkdirSync(openClawHome, { recursive: true });
    fs.writeFileSync(path.join(openClawHome, '.env'), 'JUSTDO_TEST_MISSING_EXTENSION_KEY=\n');
    expect(service.listInstalled()[0].missingRequirements).toEqual([
      'JUSTDO_TEST_MISSING_EXTENSION_KEY',
    ]);
    fs.writeFileSync(path.join(openClawHome, '.env'), 'JUSTDO_TEST_MISSING_EXTENSION_KEY=secret\n');
    expect(service.listInstalled()[0].missingRequirements).toEqual([]);
    fs.rmSync(path.join(openClawHome, '.env'));

    fs.writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          entries: { brave: { config: { webSearch: { apiKey: '${BRAVE_SECRET}' } } } },
        },
      }),
    );
    expect(service.listInstalled()[0].missingRequirements).toEqual([
      'JUSTDO_TEST_MISSING_EXTENSION_KEY',
    ]);

    fs.writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify({
        env: { BRAVE_SECRET: 'configured' },
        plugins: {
          entries: { brave: { config: { webSearch: { apiKey: '${BRAVE_SECRET}' } } } },
        },
      }),
    );
    expect(service.listInstalled()[0].missingRequirements).toEqual([]);
  });

  it.each([true, false])(
    'configures provider credentials without uiHints (bundled=%s)',
    async bundled => {
      const stateDir = path.join(fixtureRoot, 'state');
      const runtimeRoot = path.join(fixtureRoot, 'runtime');
      const configPath = path.join(stateDir, 'openclaw.json');
      const installedDir = bundled
        ? path.join(runtimeRoot, 'dist', 'extensions', 'speech-example')
        : path.join(stateDir, 'extensions', 'speech-example');
      fs.mkdirSync(installedDir, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      const candidates = ['JUSTDO_TEST_SPEECH_KEY', 'JUSTDO_TEST_SPEECH_ALIAS'];
      fs.writeFileSync(
        path.join(installedDir, 'openclaw.plugin.json'),
        JSON.stringify({
          id: 'speech-example',
          setup: { providers: [{ id: 'speech-example', envVars: candidates }] },
          configSchema: { type: 'object', additionalProperties: false, properties: {} },
        }),
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          env: { vars: { UNRELATED_KEY: 'preserved' }, shellEnv: { enabled: false } },
          plugins: { entries: { 'speech-example': { enabled: false } } },
        }),
      );
      const manager = {
        getStateDir: () => stateDir,
        getBaseDir: () => fixtureRoot,
        getRuntimeRoot: () => runtimeRoot,
        getConfigPath: () => configPath,
        getStatus: () => ({ phase: 'running' }),
        getGatewayConfigReloadGeneration: () => 2,
        waitForGatewayConfigReload: vi.fn().mockResolvedValue(true),
      } as unknown as OpenClawEngineManager;
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => manager,
        requestGateway: vi.fn().mockResolvedValue({
          plugins: [
            {
              id: 'speech-example',
              installed: true,
              origin: bundled ? 'bundled' : 'local',
              enabled: false,
              state: 'disabled',
            },
          ],
          mutationAllowed: true,
          diagnostics: [],
        }),
      });
      expect((await service.listCatalog())[0]).toMatchObject({
        missingRequirements: candidates,
        configurationFields: [
          {
            path: `env.vars.${candidates[0]}`,
            label: candidates[0],
            environmentVariables: candidates,
            sensitive: true,
            configured: false,
          },
        ],
      });
      await expect(
        service.updateConfiguration('speech-example', {
          [`env.vars.${candidates[0]}`]: 'synthetic-speech-secret',
          'env.vars.UNDECLARED_KEY': 'must-not-write',
          'constructor.prototype.polluted': 'must-not-write',
        }),
      ).resolves.toEqual({ success: true });
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(saved.env).toEqual({
        vars: { UNRELATED_KEY: 'preserved', [candidates[0]]: 'synthetic-speech-secret' },
        shellEnv: { enabled: false },
      });
      expect(saved.plugins.entries['speech-example']).toEqual({ enabled: false });
      const catalog = await service.listCatalog();
      expect(catalog[0].missingRequirements).toEqual([]);
      expect(catalog[0].configurationFields[0].configured).toBe(true);
      expect(JSON.stringify(catalog)).not.toContain('synthetic-speech-secret');
      expect(manager.waitForGatewayConfigReload).toHaveBeenCalledWith(2);
      delete saved.env.vars[candidates[0]];
      fs.writeFileSync(configPath, JSON.stringify(saved));
      await expect(
        service.updateConfiguration('speech-example', {
          [`env.vars.${candidates[1]}`]: 'synthetic-alias-secret',
        }),
      ).resolves.toEqual({ success: true });
      const aliasConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(aliasConfig.env.vars).toEqual({
        UNRELATED_KEY: 'preserved',
        [candidates[1]]: 'synthetic-alias-secret',
      });
      const aliasCatalog = await service.listCatalog();
      expect(aliasCatalog[0].missingRequirements).toEqual([]);
      expect(aliasCatalog[0].configurationFields[0].configuredEnvironmentVariables).toEqual([
        candidates[1],
      ]);
      expect(JSON.stringify(aliasCatalog)).not.toContain('synthetic-alias-secret');
    },
  );

  it.each(['reload-throws', 'restart-throws', 'restart-error'])(
    'retries a persisted environment credential after %s and replaces the top-level value',
    async failure => {
      const stateDir = path.join(fixtureRoot, 'state');
      const installedDir = path.join(stateDir, 'extensions', 'credential-example');
      const configPath = path.join(stateDir, 'openclaw.json');
      const name = 'JUSTDO_TEST_RETRY_ENV_KEY';
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedDir, 'openclaw.plugin.json'),
        JSON.stringify({
          id: 'credential-example',
          setup: { providers: [{ id: 'provider', envVars: [name] }] },
        }),
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ env: { [name]: 'old-key', vars: { UNRELATED: 'preserved' } } }),
      );
      let phase = 'running';
      const restart = vi.fn().mockResolvedValue({ phase: 'running' });
      const reload = vi.fn().mockResolvedValue(false);
      if (failure === 'reload-throws')
        reload.mockRejectedValueOnce(new Error('Synthetic reload failure'));
      if (failure === 'restart-throws')
        restart.mockRejectedValueOnce(new Error('Synthetic restart failure'));
      if (failure === 'restart-error') restart.mockResolvedValueOnce({ phase: 'error' });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({
            getStateDir: () => stateDir,
            getBaseDir: () => fixtureRoot,
            getConfigPath: () => configPath,
            getStatus: () => ({ phase }),
            getGatewayConfigReloadGeneration: () => 1,
            waitForGatewayConfigReload: reload,
          }) as unknown as OpenClawEngineManager,
        restartGatewayAfterMutation: restart,
      });
      const values = { [`env.vars.${name}`]: 'new-key' };

      await expect(
        service.updateConfiguration('credential-example', values),
      ).resolves.toMatchObject({ success: false });
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).env).toEqual({
        vars: { UNRELATED: 'preserved', [name]: 'new-key' },
      });
      if (failure === 'restart-error') phase = 'error';
      restart.mockClear();
      await expect(service.updateConfiguration('credential-example', values)).resolves.toEqual({
        success: true,
      });
      expect(restart).toHaveBeenCalledTimes(1);
      phase = 'running';
      await expect(service.updateConfiguration('credential-example', values)).resolves.toEqual({
        success: true,
      });
      expect(restart).toHaveBeenCalledTimes(1);
    },
  );

  it('reports inherited environment credentials and rejects edits that cannot take effect', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'credential-example');
    const configPath = path.join(stateDir, 'openclaw.json');
    const name = 'JUSTDO_TEST_INHERITED_KEY';
    vi.stubEnv(name, 'synthetic-inherited-key');
    try {
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedDir, 'openclaw.plugin.json'),
        JSON.stringify({
          id: 'credential-example',
          setup: { providers: [{ id: 'provider', envVars: [name] }] },
        }),
      );
      fs.writeFileSync(configPath, '{}');
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({
            getStateDir: () => stateDir,
            getBaseDir: () => fixtureRoot,
            getConfigPath: () => configPath,
          }) as unknown as OpenClawEngineManager,
      });
      const inventory = service.listInstalled();
      expect(inventory[0].configurationFields[0]).toMatchObject({
        configured: true,
        inheritedEnvironmentVariables: [name],
      });
      expect(JSON.stringify(inventory)).not.toContain('synthetic-inherited-key');
      await expect(
        service.updateConfiguration('credential-example', { [`env.vars.${name}`]: 'replacement' }),
      ).resolves.toMatchObject({ success: false, error: t('extensionCredentialInherited') });
      expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps separate provider credential groups independent and recognizes native env.vars', () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'multi-provider');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'multi-provider',
        setup: {
          providers: [
            { id: 'first', envVars: ['JUSTDO_TEST_FIRST_KEY', 'JUSTDO_TEST_FIRST_ALIAS'] },
            { id: 'second', envVars: ['JUSTDO_TEST_SECOND_KEY'] },
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify({
        env: { vars: { JUSTDO_TEST_FIRST_ALIAS: 'synthetic-first-secret' } },
      }),
    );
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () =>
        ({
          getStateDir: () => stateDir,
          getBaseDir: () => fixtureRoot,
          getConfigPath: () => path.join(stateDir, 'openclaw.json'),
        }) as unknown as OpenClawEngineManager,
    });
    const installed = service.listInstalled()[0];
    expect(installed.missingRequirements).toEqual(['JUSTDO_TEST_SECOND_KEY']);
    expect(installed.configurationFields.map(field => field.configured)).toEqual([true, false]);
  });

  it.each([true, false])(
    'updates declared extension configuration with native reload result %s',
    async reloaded => {
      const stateDir = path.join(fixtureRoot, 'state');
      const configPath = path.join(stateDir, 'openclaw.json');
      const installedDir = path.join(stateDir, 'extensions', 'brave');
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedDir, 'openclaw.plugin.json'),
        JSON.stringify({
          id: 'brave',
          name: 'Brave',
          setup: {
            providers: [{ id: 'brave', envVars: ['JUSTDO_TEST_EDIT_EXTENSION_KEY'] }],
          },
          uiHints: {
            'webSearch.apiKey': {
              label: 'Brave Search API Key',
              help: 'Key used for Brave Search.',
              sensitive: true,
            },
            'constructor.prototype.polluted': { sensitive: true },
          },
        }),
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: 'local' },
          plugins: { entries: { brave: { enabled: true } } },
        }),
      );
      const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
      const manager = {
        getStateDir: vi.fn().mockReturnValue(stateDir),
        getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
        getConfigPath: vi.fn().mockReturnValue(configPath),
        getGatewayConfigReloadGeneration: vi.fn(() => 7),
        waitForGatewayConfigReload: vi.fn(async () => reloaded),
        getStatus: vi.fn().mockReturnValue({ phase: 'running' }),
        restartGateway,
      } as unknown as OpenClawEngineManager;
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => manager,
        restartGatewayAfterMutation: () => restartGateway(),
      });

      await expect(
        service.updateConfiguration('brave', {
          'webSearch.apiKey': 'secret-key',
          'unsupported.path': 'must-not-be-written',
          'constructor.prototype.polluted': 'must-not-be-written',
        }),
      ).resolves.toEqual({ success: true });

      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(savedConfig.gateway).toEqual({ mode: 'local' });
      expect(savedConfig.plugins.entries.brave).toEqual({
        enabled: true,
        config: { webSearch: { apiKey: 'secret-key' } },
      });
      expect(service.listInstalled()[0]).toMatchObject({
        missingRequirements: [],
        configurationFields: [
          expect.objectContaining({ path: 'webSearch.apiKey', configured: true }),
        ],
      });
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
      expect(manager.waitForGatewayConfigReload).toHaveBeenCalledWith(7);
      expect(restartGateway).toHaveBeenCalledTimes(reloaded ? 0 : 1);
      await expect(
        service.updateConfiguration('brave', { 'webSearch.apiKey': 'secret-key' }),
      ).resolves.toEqual({ success: true });
      expect(manager.waitForGatewayConfigReload).toHaveBeenCalledTimes(1);
      expect(restartGateway).toHaveBeenCalledTimes(reloaded ? 0 : 1);
    },
  );
  it.each([
    { acknowledged: true, reported: 5, pending: false },
    { acknowledged: true, reported: 3, pending: true },
    { acknowledged: false, reported: 5, pending: false },
    { acknowledged: false, reported: 3, pending: true },
  ])(
    'confirms numeric hot settings without restarting active work: $acknowledged/$reported',
    async scenario => {
      const stateDir = path.join(fixtureRoot, 'state');
      const configPath = path.join(stateDir, 'openclaw.json');
      const directory = path.join(stateDir, 'extensions', 'numeric-demo');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'openclaw.plugin.json'),
        JSON.stringify({
          id: 'numeric-demo',
          configSchema: {
            type: 'object',
            properties: { concurrency: { type: 'integer', minimum: 1, maximum: 16, default: 3 } },
          },
          uiHints: { concurrency: { configurable: true, labelKey: 'swarmWorkflowConfigConcurrency' } },
          configContracts: { configurationStatusMethod: 'numericDemo.health' },
        }),
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: 'local' },
          plugins: {
            entries: { 'numeric-demo': { enabled: false, config: { preserved: 'original' } } },
          },
        }),
      );
      const restart = vi.fn();
      const manager = {
        getStateDir: () => stateDir,
        getBaseDir: () => fixtureRoot,
        getConfigPath: () => configPath,
        getStatus: () => ({ phase: 'running' }),
        getGatewayConfigReloadGeneration: () => 7,
        waitForGatewayConfigReload: vi.fn(async () => scenario.acknowledged),
      } as unknown as OpenClawEngineManager;
      const requestGateway = vi
        .fn()
        .mockResolvedValue({ ready: true, configuration: { concurrency: scenario.reported } });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () => manager,
        requestGateway,
        restartGatewayAfterMutation: restart,
      });
      expect(service.listInstalled()[0].configurationFields[0]).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 16,
        defaultValue: 3,
        sensitive: false,
      });
      for (const value of ['0', '17', '1.5', 'NaN'])
        expect(
          await service.updateConfiguration('numeric-demo', { concurrency: value }),
        ).toMatchObject({ success: false });
      expect(await service.updateConfiguration('numeric-demo', { concurrency: '5' })).toEqual({
        success: true,
        pending: scenario.pending,
      });
      expect(
        JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.entries['numeric-demo'],
      ).toEqual({ enabled: false, config: { preserved: 'original', concurrency: 5 } });
      expect(restart).not.toHaveBeenCalled();
      if (scenario.pending) {
        expect(await service.updateConfiguration('numeric-demo', { concurrency: '5' })).toEqual({
          success: true,
          pending: true,
        });
        requestGateway.mockResolvedValue({ ready: true, configuration: { concurrency: 5 } });
        expect(await service.updateConfiguration('numeric-demo', { concurrency: '5' })).toEqual({
          success: true,
          pending: false,
        });
      }
      expect(restart).not.toHaveBeenCalled();
    },
  );

  it('uninstalls an extension and restarts a Gateway that was still starting', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const configPath = path.join(stateDir, 'openclaw.json');
    const installedDir = path.join(stateDir, 'extensions', 'sample-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'sample-extension', name: 'Sample Extension' }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { allow: ['bundled-plugin', 'sample-extension'] } }),
    );
    const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
    const manager = {
      getStateDir: vi.fn().mockReturnValue(stateDir),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn().mockReturnValue(configPath),
      getStatus: vi.fn().mockReturnValue({ phase: 'starting' }),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
      restartGateway,
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn().mockImplementation(async () => {
      fs.rmSync(installedDir, { recursive: true, force: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      restartGatewayAfterMutation: () => restartGateway(),
      runCommand,
    });

    await expect(service.delete('sample-extension')).resolves.toEqual({ success: true });
    expect(runCommand).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
        'plugins',
        'uninstall',
        'sample-extension',
        '--force',
      ],
      expect.objectContaining({
        cwd: path.join(fixtureRoot, 'runtime'),
        successPattern: expect.any(RegExp),
      }),
    );
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins.allow).toEqual([
      'bundled-plugin',
    ]);
    expect(restartGateway).toHaveBeenCalledOnce();
  });

  it('allowlists an installed extension when enabling it', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const configPath = path.join(stateDir, 'openclaw.json');
    const installedDir = path.join(stateDir, 'extensions', 'sample-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'sample-extension', name: 'Sample Extension' }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { allow: ['bundled-plugin'], entries: {} } }),
    );
    const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
    const manager = {
      getStateDir: vi.fn().mockReturnValue(stateDir),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn().mockReturnValue(configPath),
      getStatus: vi.fn().mockReturnValue({ phase: 'running' }),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
      restartGateway,
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn().mockImplementation(async () => {
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins).toMatchObject({
        allow: ['bundled-plugin', 'sample-extension'],
        entries: { 'sample-extension': { enabled: false } },
      });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            allow: ['bundled-plugin', 'sample-extension'],
            entries: { 'sample-extension': { enabled: true } },
          },
        }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      restartGatewayAfterMutation: () => restartGateway(),
      runCommand,
    });

    await expect(service.setEnabled('sample-extension', true)).resolves.toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins).toMatchObject({
      allow: ['bundled-plugin', 'sample-extension'],
      entries: { 'sample-extension': { enabled: true } },
    });
    expect(restartGateway).toHaveBeenCalledOnce();
  });

  it('disables an installed extension and restarts a Gateway that was still starting', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'sample-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'sample-extension', name: 'Sample Extension' }),
    );
    fs.writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          allow: ['sample-extension'],
          entries: { 'sample-extension': { enabled: true } },
        },
      }),
    );
    const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
    const manager = {
      getStateDir: vi.fn().mockReturnValue(stateDir),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn().mockReturnValue(path.join(stateDir, 'openclaw.json')),
      getStatus: vi.fn().mockReturnValue({ phase: 'starting' }),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
      restartGateway,
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn().mockImplementation(async () => {
      fs.writeFileSync(
        path.join(stateDir, 'openclaw.json'),
        JSON.stringify({
          plugins: {
            allow: ['sample-extension'],
            entries: { 'sample-extension': { enabled: false } },
          },
        }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      restartGatewayAfterMutation: () => restartGateway(),
      runCommand,
    });

    await expect(service.setEnabled('sample-extension', false)).resolves.toEqual({
      success: true,
    });
    expect(runCommand).toHaveBeenCalledWith(
      process.execPath,
      [path.join(fixtureRoot, 'runtime', 'openclaw.mjs'), 'plugins', 'disable', 'sample-extension'],
      expect.objectContaining({ successPattern: expect.any(RegExp) }),
    );
    expect(fs.existsSync(installedDir)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')).plugins.allow,
    ).toEqual(['sample-extension']);
    expect(restartGateway).toHaveBeenCalledOnce();
  });

  it('reports failure when OpenClaw exits successfully but policy keeps an extension disabled', async () => {
    const stateDir = path.join(fixtureRoot, 'state');
    const installedDir = path.join(stateDir, 'extensions', 'sample-extension');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'sample-extension', name: 'Sample Extension' }),
    );
    fs.writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify({ plugins: { enabled: false } }),
    );
    const restartGateway = vi.fn().mockResolvedValue({ phase: 'running' });
    const manager = {
      getStateDir: vi.fn().mockReturnValue(stateDir),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      getConfigPath: vi.fn().mockReturnValue(path.join(stateDir, 'openclaw.json')),
      getStatus: vi.fn().mockReturnValue({ phase: 'running' }),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: { OPENCLAW_STATE_DIR: stateDir },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
      restartGateway,
    } as unknown as OpenClawEngineManager;
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    });

    const result = await service.setEnabled('sample-extension', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('global plugin policy');
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')).plugins,
    ).toMatchObject({
      allow: ['sample-extension'],
      entries: { 'sample-extension': { enabled: false } },
    });
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it('preserves the injected npm environment and reports dependency installation progress', async () => {
    const sourceDir = path.join(fixtureRoot, 'network-extension');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({
        id: 'network-extension',
        configSchema: { type: 'object', additionalProperties: false },
      }),
    );
    fs.writeFileSync(
      path.join(sourceDir, 'package.json'),
      JSON.stringify({ dependencies: { 'missing-package': '1.0.0' } }),
    );
    const manager = {
      getStatus: vi.fn().mockReturnValue({ phase: 'ready' }),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: {
          NPM_CONFIG_USERCONFIG: path.join(fixtureRoot, 'dependency-config', '.npmrc'),
          NPM_CONFIG_REGISTRY: 'https://injected.example.invalid',
          npm_config_registry: 'https://injected.example.invalid',
          NPM_CONFIG_OFFLINE: 'true',
          npm_config_offline: 'true',
        },
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'npm error code E404: package is missing from the configured registry',
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand,
    });

    const onProgress = vi.fn();
    await expect(service.importPath(sourceDir, onProgress)).resolves.toEqual({
      success: false,
      extensionId: 'network-extension',
      error: 'npm error code E404: package is missing from the configured registry',
      failedStage: 'installing_dependencies',
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0][2].env).toEqual(
      expect.objectContaining({
        NPM_CONFIG_USERCONFIG: path.join(fixtureRoot, 'dependency-config', '.npmrc'),
      }),
    );
    expect(runCommand.mock.calls[0][2].env).toEqual(
      expect.objectContaining({
        NPM_CONFIG_REGISTRY: 'https://injected.example.invalid',
        npm_config_registry: 'https://injected.example.invalid',
        NPM_CONFIG_OFFLINE: 'true',
        npm_config_offline: 'true',
      }),
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'installing_dependencies', percent: 55 });
  });

  it('classifies missing compiled JavaScript as package validation failure', async () => {
    const sourceDir = path.join(fixtureRoot, 'typescript-only-extension');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'typescript-only-extension' }),
    );
    fs.writeFileSync(
      path.join(sourceDir, 'package.json'),
      JSON.stringify({ dependencies: { json5: '^2.2.3' } }),
    );
    const manager = {
      getStatus: vi.fn().mockReturnValue({ phase: 'ready' }),
      getBaseDir: vi.fn().mockReturnValue(path.join(fixtureRoot, 'openclaw-home')),
      buildCliEnvironment: vi.fn().mockResolvedValue({
        env: {},
        runtimeRoot: path.join(fixtureRoot, 'runtime'),
        openclawEntry: path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
      }),
    } as unknown as OpenClawEngineManager;
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        '[openclaw-launcher] loading bundle\n' +
        'package install requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js. This is a plugin packaging issue.\n' +
        'Also not a valid hook pack: Error: package.json missing openclaw.hooks',
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand,
    });

    await expect(service.importPath(sourceDir)).resolves.toEqual({
      success: false,
      extensionId: 'typescript-only-extension',
      error:
        'package install requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js. This is a plugin packaging issue.',
      failedStage: 'validating',
    });
  });
});
