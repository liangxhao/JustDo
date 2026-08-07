import { beforeEach, expect, test, vi } from 'vitest';

import { ManagedDirectoryOperationCoordinator } from '../../core/managedDirectoryOperations';
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
