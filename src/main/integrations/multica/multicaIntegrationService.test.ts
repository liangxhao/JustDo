import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { SqliteStore } from '../../data/sqliteStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  isAllowedLocalMulticaCommand,
  isMulticaDesktopProfile,
  MulticaIntegrationService,
} from './multicaIntegrationService';

describe('Multica local integration', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('recognizes current desktop profiles when daemon status omits launched_by', () => {
    const profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-profiles-'));
    tempDirectories.push(profilesRoot);
    const desktopProfile = 'desktop-api.multica.ai';
    const desktopProfileDirectory = path.join(profilesRoot, desktopProfile);
    fs.mkdirSync(desktopProfileDirectory);
    fs.writeFileSync(path.join(desktopProfileDirectory, '.desktop-user-id'), 'desktop-user');

    expect(isMulticaDesktopProfile(profilesRoot, desktopProfile, { status: 'running' })).toBe(true);
    expect(
      isMulticaDesktopProfile(profilesRoot, 'terminal-profile', {
        status: 'running',
        launched_by: 'desktop',
      }),
    ).toBe(true);
    expect(isMulticaDesktopProfile(profilesRoot, 'terminal-profile', { status: 'running' })).toBe(
      false,
    );
  });

  test('allows only Multica CLI commands proven to stay local', () => {
    expect(isAllowedLocalMulticaCommand(['--version'])).toBe(true);
    expect(
      isAllowedLocalMulticaCommand([
        'daemon',
        'status',
        '--profile',
        'desktop-api.multica.ai',
        '--output',
        'json',
      ]),
    ).toBe(true);
    expect(isAllowedLocalMulticaCommand(['runtime', 'profile', 'list'])).toBe(false);
    expect(
      isAllowedLocalMulticaCommand(['daemon', 'restart', '--profile', 'desktop-api.multica.ai']),
    ).toBe(false);
  });

  test('prepares a local launcher and leaves the Multica profile untouched', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-lifecycle-'));
    tempDirectories.push(directory);
    const configPath = path.join(directory, 'config.json');
    const originalConfig = '{"token":"secret","custom":{"value":1}}\n';
    fs.writeFileSync(configPath, originalConfig);
    const targetPath = path.join(directory, '程序文件', `${PRODUCT_NAME}-agent.exe`);
    const launcherPath = targetPath;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(launcherPath, 'placeholder');
    const values = new Map<string, unknown>();
    const store = {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    } as unknown as SqliteStore;
    const manager = {
      getStatus: () => ({ phase: 'ready', version: '2026.7.1-2' }),
      getGatewayPort: () => null,
    } as unknown as OpenClawEngineManager;
    const service = new MulticaIntegrationService({
      getStore: () => store,
      getEngineManager: () => manager,
      isBridgeRunning: () => true,
      getCommandLauncher: targetPath => ({
        commandName: targetPath,
        commandLine: targetPath,
        fixedArgs: [],
        path: targetPath,
      }),
      getLauncherPath: () => targetPath,
    });
    const privateService = service as unknown as {
      detectMultica: () => Promise<unknown>;
    };
    vi.spyOn(privateService, 'detectMultica').mockImplementation(async () => ({
      executable: 'C:\\Multica\\multica.exe',
      version: 'multica v0.4.32',
      profileName: 'desktop-api.multica.ai',
      configPath,
      daemon: {
        status: 'running',
        launched_by: 'desktop',
        active_task_count: 0,
        pid: 100,
        workspaces: [{ id: 'workspace-1' }],
      },
    }));

    const enabled = await service.enable();
    expect(enabled.success).toBe(true);
    expect(enabled.status.networkPolicy).toBe('local-only');
    expect(enabled.status.launcherReady).toBe(true);
    expect(enabled.status.manualSetup).toEqual({
      protocolFamily: 'Openclaw',
      displayName: PRODUCT_NAME,
      commandName: targetPath,
      description: `${PRODUCT_NAME} local Agent runtime`,
    });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);

    const enabledAgain = await service.enable();
    expect(enabledAgain.success).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);

    const disabled = await service.disable();
    expect(disabled.success).toBe(true);
    expect(disabled.status.enabled).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  test('repairs persisted launcher state when the development executable changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-drift-'));
    tempDirectories.push(directory);
    const staleTargetPath = path.join(directory, 'release', `${PRODUCT_NAME}-agent.exe`);
    const currentTargetPath = path.join(directory, 'development', `${PRODUCT_NAME}-agent.exe`);
    fs.mkdirSync(path.dirname(staleTargetPath), { recursive: true });
    fs.mkdirSync(path.dirname(currentTargetPath), { recursive: true });
    fs.writeFileSync(staleTargetPath, 'stale');
    fs.writeFileSync(currentTargetPath, 'current');

    const values = new Map<string, unknown>([
      [
        'multica_integration_v1',
        {
          enabled: true,
          managedBinaryPath: staleTargetPath,
          commandLauncherPath: staleTargetPath,
          commandLine: staleTargetPath.replaceAll('\\', '/'),
        },
      ],
    ]);
    const store = {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    } as unknown as SqliteStore;
    const manager = {
      getStatus: () => ({ phase: 'ready', version: '2026.7.1-2' }),
      getGatewayPort: () => 42871,
    } as unknown as OpenClawEngineManager;
    const service = new MulticaIntegrationService({
      getStore: () => store,
      getEngineManager: () => manager,
      isBridgeRunning: () => true,
      getCommandLauncher: targetPath => ({
        commandName: targetPath,
        commandLine: targetPath.replaceAll('\\', '/'),
        fixedArgs: [],
        path: targetPath,
      }),
      getLauncherPath: () => currentTargetPath,
    });
    const privateService = service as unknown as {
      detectMultica: () => Promise<unknown>;
    };
    vi.spyOn(privateService, 'detectMultica').mockResolvedValue(null);

    const staleStatus = await service.getStatus();
    expect(staleStatus.launcherReady).toBe(false);
    expect(staleStatus.launcherPath).toBe(currentTargetPath);
    expect(staleStatus.manualSetup.commandName).toBe(
      process.platform === 'win32'
        ? currentTargetPath.replaceAll('\\', '/')
        : `${PRODUCT_NAME}-agent`,
    );

    const refreshed = await service.refresh();
    expect(refreshed.success).toBe(true);
    expect(refreshed.status.launcherReady).toBe(true);
    expect(refreshed.status.launcherPath).toBe(currentTargetPath);
    expect(values.get('multica_integration_v1')).toMatchObject({
      enabled: true,
      managedBinaryPath: currentTargetPath,
      commandLauncherPath: currentTargetPath,
    });
  });
});
