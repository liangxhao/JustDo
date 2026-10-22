import fs from 'node:fs';
import path from 'node:path';

import { watch } from 'chokidar';
import { beforeEach, expect, test, vi } from 'vitest';

import { ManagedDirectoryOperationCoordinator } from '../../core/filesystem/managedDirectoryOperations';
import { buildGatewayLaunchEnvironment } from '../../openclaw/runtime/launch/gatewayLaunchArgs';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { LocalSkillFileResult, OpenClawSkillFiles } from './openclawSkillFiles';
import { OpenClawSkillFileService } from './openclawSkillFileService';

const lockedResult = (targetPath = 'C:\\skills\\demo'): LocalSkillFileResult => ({
  success: false,
  error: 'EBUSY: resource busy or locked',
  errorCode: 'EBUSY',
  errorPath: targetPath,
  errorSyscall: 'rename',
});

const createManager = (phase: 'ready' | 'running' = 'running') => {
  let currentPhase = phase;
  const stopGateway = vi.fn(async () => {
    currentPhase = 'ready';
  });
  const startGateway = vi.fn(async () => {
    currentPhase = 'running';
    return { phase: 'running', message: 'running' };
  });
  return {
    manager: {
      getStateDir: vi.fn(() => 'C:\\state'),
      getStatus: vi.fn(() => ({ phase: currentPhase })),
      stopGateway,
      startGateway,
    } as unknown as OpenClawEngineManager,
    startGateway,
    stopGateway,
  };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
});

test('retains structured link failure details without diagnosing an unrelated directory lock', async () => {
  const manager = createManager();
  const findLockingProcesses = vi.fn();
  const importPath = vi.fn<() => Promise<LocalSkillFileResult>>().mockResolvedValue({
    success: false,
    error: 'Dependency link could not be created',
    errorCode: 'EPERM',
    errorSyscall: 'symlink',
    errorPath: 'C:\\capture\\dependency',
  });
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    createSkillFiles: () => ({ importPath }) as unknown as OpenClawSkillFiles,
    findLockingProcesses,
  });

  const result = await service.importPath('C:\\source');

  expect(result).toMatchObject({ success: false, errorCode: 'EPERM', errorSyscall: 'symlink' });
  expect(result.error).toContain('Dependency link could not be created');
  expect(findLockingProcesses).not.toHaveBeenCalled();
  expect(manager.stopGateway).not.toHaveBeenCalled();
  expect(manager.startGateway).not.toHaveBeenCalled();
});

test('does not restart the Gateway when a skill import is locked', async () => {
  const manager = createManager();
  const importPath = vi.fn<() => Promise<LocalSkillFileResult>>().mockResolvedValue(lockedResult());
  const files = { importPath } as unknown as OpenClawSkillFiles;
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    createSkillFiles: () => files,
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Explorer', pid: 10856 }],
    })),
  });

  const result = await service.importPath('C:\\source');

  expect(result.success).toBe(false);
  expect(result.error).toContain('Explorer (PID 10856)');
  expect(manager.stopGateway).not.toHaveBeenCalled();
  expect(importPath).toHaveBeenCalledOnce();
  expect(manager.startGateway).not.toHaveBeenCalled();
});

test('reports the owner and does not restart the Gateway when skill deletion returns EPERM without syscall', async () => {
  const manager = createManager();
  const rawError = Object.assign(new Error('EPERM, Permission denied'), {
    code: 'EPERM',
    path: 'C:\\skills\\demo',
  });
  const deleteDirectory = vi.fn(() => {
    throw new Error('Cannot delete skill', { cause: rawError });
  });
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    createSkillFiles: () => ({ deleteDirectory }) as unknown as OpenClawSkillFiles,
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Typora', pid: 38412 }],
    })),
  });

  await expect(service.deleteDirectory('C:\\skills\\demo')).rejects.toThrow('Typora (PID 38412)');
  expect(manager.stopGateway).not.toHaveBeenCalled();
  expect(deleteDirectory).toHaveBeenCalledOnce();
  expect(manager.startGateway).not.toHaveBeenCalled();
});

test('names the external process without stopping the Gateway', async () => {
  const manager = createManager();
  const importPath = vi.fn(async () => lockedResult());
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    createSkillFiles: () => ({ importPath }) as unknown as OpenClawSkillFiles,
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Visual Studio Code', pid: 4321 }],
    })),
  });

  const result = await service.importPath('C:\\source');

  expect(result.success).toBe(false);
  expect(result.error).toContain('Visual Studio Code (PID 4321)');
  expect(result.error).toContain('C:\\skills\\demo');
  expect(manager.stopGateway).not.toHaveBeenCalled();
  expect(manager.startGateway).not.toHaveBeenCalled();
});

test('does not restart the Gateway for validation and ordinary file errors', async () => {
  const manager = createManager();
  const importPath = vi.fn(async () => ({
    success: false,
    error: 'Archive is invalid',
  }));
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    createSkillFiles: () => ({ importPath }) as unknown as OpenClawSkillFiles,
  });

  await expect(service.importPath('C:\\broken.zip')).resolves.toEqual({
    success: false,
    error: 'Archive is invalid',
  });
  expect(manager.stopGateway).not.toHaveBeenCalled();
  expect(manager.startGateway).not.toHaveBeenCalled();
});

test('does not manage the Gateway when using the shared runtime-aware coordinator', async () => {
  const manager = createManager();
  const directoryOperations = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => true,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop: manager.stopGateway,
      start: async () => {
        const status = await manager.startGateway();
        return { running: status.phase === 'running', message: status.message };
      },
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Explorer', pid: 10856 }],
    })),
  });
  const importPath = vi.fn(async () => lockedResult());
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    directoryOperations,
    createSkillFiles: () => ({ importPath }) as unknown as OpenClawSkillFiles,
  });

  const result = await service.importPath('C:\\source');

  expect(result.success).toBe(false);
  expect(manager.stopGateway).not.toHaveBeenCalled();
  expect(manager.startGateway).not.toHaveBeenCalled();
});

test.each(['import', 'delete'] as const)(
  'does not stop or restart the Gateway when it owns a locked skill directory during %s',
  async action => {
    const manager = createManager();
    const findLockingProcesses = vi.fn().mockResolvedValue({
      available: true,
      processes: [{ name: 'JustDo Gateway', pid: 4242 }],
    });
    const directoryOperations = new ManagedDirectoryOperationCoordinator({
      runtime: {
        isRunning: () => manager.manager.getStatus().phase === 'running',
        ownsProcess: pid => pid === 4242,
        prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
        stop: manager.stopGateway,
        start: async () => {
          const status = await manager.startGateway();
          return { running: status.phase === 'running', message: status.message };
        },
      },
      findLockingProcesses,
    });
    const importPath = vi
      .fn<() => Promise<LocalSkillFileResult>>()
      .mockResolvedValue(lockedResult());
    const deleteDirectory = vi.fn(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    const service = new OpenClawSkillFileService({
      getOpenClawEngineManager: () => manager.manager,
      directoryOperations,
      createSkillFiles: () => ({ importPath, deleteDirectory }) as unknown as OpenClawSkillFiles,
    });

    if (action === 'import') {
      const result = await service.importPath('C:\\source');
      expect(result.success).toBe(false);
      expect(result.error).toContain('C:\\skills\\demo');
      expect(importPath).toHaveBeenCalledOnce();
    } else {
      await expect(service.deleteDirectory('C:\\skills\\demo')).rejects.toThrow('C:\\skills\\demo');
      expect(deleteDirectory).toHaveBeenCalledOnce();
    }
    expect(manager.stopGateway).not.toHaveBeenCalled();
    expect(manager.startGateway).not.toHaveBeenCalled();
  },
);

test('serializes concurrent skill mutations', async () => {
  const manager = createManager('ready');
  let active = 0;
  let maximumActive = 0;
  const importPath = vi.fn(async (_sourcePath: string) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { success: true, skillId: 'demo' };
  });
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    createSkillFiles: () => ({ importPath }) as unknown as OpenClawSkillFiles,
  });

  await Promise.all([service.importPath('C:\\one'), service.importPath('C:\\two')]);

  expect(maximumActive).toBe(1);
});

test('runs skill mutations inside the shared config mutation queue', async () => {
  const manager = createManager('ready');
  const importPath = vi.fn(async () => ({ success: true, skillId: 'demo' }));
  const runConfigMutationExclusive = vi.fn(async <T>(operation: () => Promise<T>) => operation());
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
    createSkillFiles: () => ({ importPath }) as unknown as OpenClawSkillFiles,
    runConfigMutationExclusive,
  });

  await service.importPath('C:\\source');

  expect(runConfigMutationExclusive).toHaveBeenCalledOnce();
  expect(importPath).toHaveBeenCalledOnce();
});

test('imports, updates and deletes skills while the Windows polling watcher stays active', async () => {
  const taskRoot = path.resolve('.agent-tasks');
  fs.mkdirSync(taskRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(taskRoot, 'skill-files-'));
  const relative = path.relative(taskRoot, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to use a skill test outside the task directory');
  }
  const stateDir = path.join(root, 'state');
  const skillsDir = path.join(stateDir, 'skills');
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(skillsDir, 'demo');
  const targetFile = path.join(targetDir, 'SKILL.md');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(sourceDir);
  const writeSource = (version: string) =>
    fs.writeFileSync(
      path.join(sourceDir, 'SKILL.md'),
      `---\nname: demo\ndescription: Test skill\n---\n${version}\n`,
    );
  writeSource('First version');
  const gatewayEnv = buildGatewayLaunchEnvironment({}, { appStartedAtMs: 1, platform: 'win32' });
  vi.stubEnv('CHOKIDAR_USEPOLLING', gatewayEnv.CHOKIDAR_USEPOLLING);
  vi.stubEnv('CHOKIDAR_INTERVAL', gatewayEnv.CHOKIDAR_INTERVAL);
  const nativeWatch = vi.spyOn(fs, 'watch');
  const watcher = watch(skillsDir, { ignoreInitial: true, followSymlinks: false, depth: 2 });
  const events: Array<{ event: string; file: string }> = [];
  watcher.on('all', (event, file) => events.push({ event, file }));
  const manager = createManager();
  manager.manager.getStateDir = () => stateDir;
  const service = new OpenClawSkillFileService({
    getOpenClawEngineManager: () => manager.manager,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });

    await expect(service.importPath(sourceDir)).resolves.toEqual({
      success: true,
      skillId: 'demo',
    });
    await vi.waitFor(() => expect(events.some(entry => entry.file === targetFile)).toBe(true), {
      timeout: 4000,
    });
    expect(fs.readFileSync(targetFile, 'utf8')).toContain('First version');

    events.length = 0;
    writeSource('Updated version');
    await expect(service.importPath(sourceDir)).resolves.toEqual({
      success: true,
      skillId: 'demo',
    });
    await vi.waitFor(
      () =>
        expect(events.some(entry => entry.event === 'change' && entry.file === targetFile)).toBe(
          true,
        ),
      { timeout: 4000 },
    );
    expect(fs.readFileSync(targetFile, 'utf8')).toContain('Updated version');

    events.length = 0;
    await service.deleteDirectory(targetDir);
    expect(fs.existsSync(targetDir)).toBe(false);
    await vi.waitFor(
      () =>
        expect(events.some(entry => entry.event === 'unlinkDir' && entry.file === targetDir)).toBe(
          true,
        ),
      { timeout: 4000 },
    );
    expect(watcher.closed).toBe(false);
    expect(nativeWatch).not.toHaveBeenCalled();
    expect(manager.stopGateway).not.toHaveBeenCalled();
    expect(manager.startGateway).not.toHaveBeenCalled();
  } finally {
    await watcher.close();
    nativeWatch.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
