import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedDirectoryOperationCoordinator } from '../../core/managedDirectoryOperations';
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
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('protects managed permission extensions from user mutation', async () => {
    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => ({}) as OpenClawEngineManager,
      getManagedPluginIds: () => ['automation-permission'],
      runCommand,
    });

    await expect(
      service.updateConfiguration('automation-permission', {
        unrestrictedAgentIds: 'main',
      }),
    ).resolves.toEqual({
      success: false,
      error: 'Managed extensions cannot be reconfigured here.',
    });
    await expect(service.delete('automation-permission')).resolves.toEqual({
      success: false,
      error: 'Managed extensions cannot be deleted.',
    });
    await expect(service.setEnabled('automation-permission', false)).resolves.toEqual({
      success: false,
      error: 'Managed extensions cannot be disabled.',
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('installs a native OpenClaw extension through the bundled CLI and restarts Gateway', async () => {
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
            'ask-user-question': { enabled: true },
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
      getManagedPluginIds: () => ['ask-user-question', 'workboard'],
      restartGatewayAfterMutation: () => restartGateway(),
      runCommand,
    });

    await expect(service.importPath(sourceDir)).resolves.toEqual({
      success: true,
      extensionId: 'sample-extension',
    });
    expect(runCommand).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(fixtureRoot, 'runtime', 'openclaw.mjs'),
        'plugins',
        'install',
        sourceDir,
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
        allow: ['ask-user-question', 'workboard', 'sample-extension'],
        bundledDiscovery: 'compat',
        entries: {
          'ask-user-question': { enabled: true },
          workboard: { enabled: true },
          'untrusted-user-entry': { enabled: true },
        },
      },
    });
    expect(restartGateway).toHaveBeenCalledOnce();
  });

  it('finishes after a successful installer message even if the CLI keeps handles open', async () => {
    const result = await __openClawExtensionImportTestUtils.runCommand(
      process.execPath,
      ['-e', "console.log('Installed plugin: sample-extension'); setInterval(() => {}, 1000);"],
      {
        cwd: fixtureRoot,
        env: process.env,
        successPattern: /Installed plugin:\s*sample-extension/i,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).not.toBe(true);
    expect(result.stdout).toContain('Installed plugin: sample-extension');
  });

  it('releases a Gateway-owned extension lock before starting the CLI transaction', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const sourceDir = path.join(fixtureRoot, 'locked-extension');
    const stateDir = path.join(fixtureRoot, 'state');
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(
      path.join(sourceDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'locked-extension' }),
    );
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
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      runCommand,
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

  it('rejects a Claude bundle before invoking the OpenClaw installer', async () => {
    const sourceDir = path.join(fixtureRoot, 'claude-extension');
    fs.mkdirSync(path.join(sourceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'claude-extension' }),
    );

    const runCommand = vi.fn();
    const service = new OpenClawExtensionImportService({
      getOpenClawEngineManager: () => ({}) as OpenClawEngineManager,
      runCommand,
    });

    const result = await service.importPath(sourceDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('openclaw.plugin.json');
    expect(runCommand).not.toHaveBeenCalled();
  });

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

  it('updates declared extension configuration without exposing or replacing unrelated config', async () => {
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
    expect(restartGateway).toHaveBeenCalledOnce();
  });

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
        bundledDiscovery: 'compat',
        entries: { 'sample-extension': { enabled: false } },
      });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            allow: ['bundled-plugin', 'sample-extension'],
            bundledDiscovery: 'compat',
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
      bundledDiscovery: 'compat',
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
      error:
        'package install requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js. This is a plugin packaging issue.',
      failedStage: 'validating',
    });
  });
});
