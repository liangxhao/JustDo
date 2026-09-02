import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  managedDirectoryFailure,
  managedDirectoryFailureFromError,
  managedDirectoryFailureFromMessage,
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
  removeDirectoryTransactional,
  replaceDirectoryTransactional,
} from './managedDirectoryOperations';

const temporaryDirectories: string[] = [];

const makeTempDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-directory-operation-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('transactionally replaces a directory and removes obsolete files', () => {
  const root = makeTempDir();
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'current.txt'), 'new');
  fs.writeFileSync(path.join(target, 'obsolete.txt'), 'old');

  replaceDirectoryTransactional({ sourceDir: source, targetDir: target, stagingParent: root });

  expect(fs.readFileSync(path.join(target, 'current.txt'), 'utf8')).toBe('new');
  expect(fs.existsSync(path.join(target, 'obsolete.txt'))).toBe(false);
});

test('restores the previous directory when publishing the staged version fails', () => {
  const root = makeTempDir();
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'version.txt'), 'new');
  fs.writeFileSync(path.join(target, 'version.txt'), 'old');
  const renameSync = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (path.basename(oldPath.toString()) === 'next' && newPath.toString() === target) {
      throw Object.assign(new Error('publish locked'), {
        code: 'EBUSY',
        syscall: 'rename',
      });
    }
    renameSync(oldPath, newPath);
  });

  expect(() =>
    replaceDirectoryTransactional({ sourceDir: source, targetDir: target, stagingParent: root }),
  ).toThrow('publish locked');
  expect(fs.readFileSync(path.join(target, 'version.txt'), 'utf8')).toBe('old');
});

test('recovers an interrupted backup before starting the next replacement', () => {
  const root = makeTempDir();
  const source = path.join(root, 'source');
  const stagingParent = path.join(root, 'managed');
  const target = path.join(stagingParent, 'demo');
  const interrupted = path.join(stagingParent, '.stage-interrupted');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(interrupted, 'backup'), { recursive: true });
  fs.writeFileSync(path.join(source, 'version.txt'), 'new');
  fs.writeFileSync(path.join(interrupted, 'backup', 'version.txt'), 'old');
  fs.writeFileSync(
    path.join(interrupted, '.justdo-transaction.json'),
    JSON.stringify({ targetDir: target }),
  );

  replaceDirectoryTransactional({
    sourceDir: source,
    targetDir: target,
    stagingParent,
    transactionPrefix: '.stage-',
  });

  expect(fs.readFileSync(path.join(target, 'version.txt'), 'utf8')).toBe('new');
  expect(fs.existsSync(interrupted)).toBe(false);
});

test('moves a directory out of its managed root before deleting it', () => {
  const root = makeTempDir();
  const target = path.join(root, 'managed', 'demo');
  const trashRoot = path.join(root, 'trash');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'manifest.json'), '{}');

  removeDirectoryTransactional({ targetDir: target, trashRoot });

  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readdirSync(trashRoot)).toEqual([]);
});

test('keeps every live file when the quarantine rename is locked', () => {
  const root = makeTempDir();
  const target = path.join(root, 'managed', 'demo');
  const trashRoot = path.join(root, 'trash');
  const skillManifest = path.join(target, 'SKILL.md');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(skillManifest, '# Demo');
  const renameSync = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (source.toString() === target) {
      throw Object.assign(new Error('resource busy or locked'), {
        code: 'EBUSY',
        syscall: 'rename',
        path: source,
        dest: destination,
      });
    }
    return renameSync(source, destination);
  });

  expect(() => removeDirectoryTransactional({ targetDir: target, trashRoot })).toThrow(
    'resource busy or locked',
  );
  expect(fs.readFileSync(skillManifest, 'utf8')).toBe('# Demo');
  expect(fs.readdirSync(target)).toEqual(['SKILL.md']);
});

test('does not reset a live directory ACL when its quarantine rename returns EPERM', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const root = makeTempDir();
  const target = path.join(root, 'managed', 'demo');
  const trashRoot = path.join(root, 'trash');
  const skillManifest = path.join(target, 'SKILL.md');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(skillManifest, '# Demo');
  const renameSync = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (source.toString() === target) {
      throw Object.assign(new Error('permission denied'), {
        code: 'EPERM',
        path: source,
        dest: destination,
      });
    }
    return renameSync(source, destination);
  });
  const resetAcl = vi.spyOn(childProcess, 'spawnSync');

  expect(() => removeDirectoryTransactional({ targetDir: target, trashRoot })).toThrow(
    'permission denied',
  );
  expect(resetAcl).not.toHaveBeenCalled();
  expect(fs.readFileSync(skillManifest, 'utf8')).toBe('# Demo');
});

test('classifies structured and CLI filesystem failures consistently', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const error = Object.assign(new Error('resource busy'), {
    code: 'EBUSY',
    syscall: 'rename',
  });

  expect(managedDirectoryFailureFromError(error, 'C:\\target')).toMatchObject({
    reason: 'locked',
    code: 'EBUSY',
    syscall: 'rename',
  });
  expect(
    managedDirectoryFailureFromMessage(
      "EBUSY: resource busy or locked, rename 'C:\\old' -> 'C:\\new'",
      'C:\\new',
    ),
  ).toMatchObject({ reason: 'locked', code: 'EBUSY', syscall: 'rename' });
  expect(
    managedDirectoryFailureFromMessage(
      "Permission denied: 'C:\\extensions\\demo'",
      'C:\\extensions\\demo',
    ),
  ).toMatchObject({ reason: 'locked' });
});

test('diagnoses a Windows EPERM without syscall as a potential directory lock', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const target = 'C:\\skills\\demo';
  const findLockingProcesses = vi.fn(async () => ({
    available: true,
    processes: [{ name: 'Typora', pid: 38412 }],
  }));
  const coordinator = new ManagedDirectoryOperationCoordinator({ findLockingProcesses });
  const error = Object.assign(new Error(`EPERM, Permission denied: ${target}`), {
    code: 'EPERM',
    path: target,
  });

  const result = await coordinator.execute({
    operation: async () => managedDirectoryFailure(managedDirectoryFailureFromError(error, target)),
    resourceName: 'skill directory',
    targetPath: target,
  });

  expect(findLockingProcesses).toHaveBeenCalledWith(target);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.reason).toBe('locked');
    expect(result.failure.message).toContain('Typora (PID 38412)');
  }
});

test('stops the runtime, retries, diagnoses external owners, and restarts', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  let running = true;
  const stop = vi.fn(async () => {
    running = false;
  });
  const start = vi.fn(async () => {
    running = true;
    return { running: true };
  });
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => running,
      ownsProcess: pid => pid === 4321,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop,
      start,
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Code', pid: 4321 }],
    })),
  });
  const operation = vi.fn(async () =>
    managedDirectoryFailure(
      managedDirectoryFailureFromMessage('EBUSY: rename failed', 'C:\\extensions\\demo'),
    ),
  );

  const result = await coordinator.execute({
    operation,
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    manageRuntimeOnLock: true,
  });

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.message).not.toContain('Code (PID 4321)');
    expect(result.failure.message).not.toContain('占用程序：');
  }
  expect(operation).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
});

test('recovers the runtime when stop throws after the process has stopped', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  let running = true;
  const stop = vi.fn(async () => {
    running = false;
    throw new Error('stop acknowledgement failed');
  });
  const start = vi.fn(async () => {
    running = true;
    return { running: true };
  });
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => running,
      ownsProcess: pid => pid === 4321,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop,
      start,
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Gateway', pid: 4321 }],
    })),
  });
  const operation = vi.fn(async () =>
    managedDirectoryFailure(
      managedDirectoryFailureFromMessage('EBUSY: rename failed', 'C:\\extensions\\demo'),
    ),
  );

  await coordinator.execute({
    operation,
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    manageRuntimeOnLock: true,
  });

  expect(operation).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(running).toBe(true);
});

test('reports a runtime recovery failure with the original directory failure', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  let running = true;
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => running,
      ownsProcess: pid => pid === 4321,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop: vi.fn(async () => {
        running = false;
      }),
      start: vi.fn(async () => ({ running: false, message: 'port remains occupied' })),
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Gateway', pid: 4321 }],
    })),
  });
  const operation = vi.fn(async () =>
    managedDirectoryFailure(
      managedDirectoryFailureFromMessage('EBUSY: rename failed', 'C:\\extensions\\demo'),
    ),
  );

  const result = await coordinator.execute({
    operation,
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    manageRuntimeOnLock: true,
  });

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.message).toContain('port remains occupied');
  }
});

test('classifies EACCES as permission denied when no locking process is found', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const coordinator = new ManagedDirectoryOperationCoordinator({
    findLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
  });

  const result = await coordinator.execute({
    operation: async () =>
      managedDirectoryFailure(
        managedDirectoryFailureFromMessage('EACCES: rename denied', 'C:\\skills\\demo'),
      ),
    resourceName: 'skill directory',
    targetPath: 'C:\\skills\\demo',
  });

  expect(result.success).toBe(false);
  if (!result.success) expect(result.failure.reason).toBe('permission');
});

test('does not stop the runtime for a lock owned only by an external process', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const stop = vi.fn(async () => undefined);
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => true,
      ownsProcess: pid => pid === 4242,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop,
      start: vi.fn(async () => ({ running: true })),
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Explorer', pid: 10856 }],
    })),
  });
  const operation = vi.fn(async () =>
    managedDirectoryFailure(
      managedDirectoryFailureFromMessage('EBUSY: rename failed', 'C:\\extensions\\demo'),
    ),
  );

  const result = await coordinator.execute({
    operation,
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    manageRuntimeOnLock: true,
  });

  expect(result.success).toBe(false);
  expect(operation).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
});

test('hides app-managed processes without enabling runtime management for skill operations', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const appChildPid = 2345;
  const gatewayPid = 4242;
  const stop = vi.fn(async () => undefined);
  const coordinator = new ManagedDirectoryOperationCoordinator({
    ownsAppProcess: pid => pid === appChildPid,
    runtime: {
      isRunning: () => true,
      ownsProcess: pid => pid === gatewayPid,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop,
      start: vi.fn(async () => ({ running: true })),
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [
        { name: 'JustDo', pid: appChildPid },
        { name: 'OpenClaw Gateway', pid: gatewayPid },
        { name: 'Typora', pid: 38412 },
      ],
    })),
  });

  const result = await coordinator.execute({
    operation: async () =>
      managedDirectoryFailure(
        managedDirectoryFailureFromMessage('EBUSY: rename failed', 'C:\\skills\\demo'),
      ),
    resourceName: 'skill directory',
    targetPath: 'C:\\skills\\demo',
  });

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.message).toContain('Typora (PID 38412)');
    expect(result.failure.message).not.toContain(`PID ${appChildPid}`);
    expect(result.failure.message).not.toContain(`PID ${gatewayPid}`);
  }
  expect(stop).not.toHaveBeenCalled();
});

test('uses an internal lock message instead of listing the current app process', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const coordinator = new ManagedDirectoryOperationCoordinator({
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'JustDo', pid: process.pid }],
    })),
  });

  const result = await coordinator.execute({
    operation: async () =>
      managedDirectoryFailure(
        managedDirectoryFailureFromMessage('EBUSY: rename failed', 'C:\\skills\\demo'),
      ),
    resourceName: 'skill directory',
    targetPath: 'C:\\skills\\demo',
  });

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.message).not.toContain(`PID ${process.pid}`);
    expect(result.failure.message).not.toContain('占用程序：');
    expect(result.failure.message).toContain('仍在使用');
  }
});

test('preflight lock checks keep an external owner from seeing a live directory mutation', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const operation = vi.fn(async () => managedDirectorySuccess(undefined));
  const coordinator = new ManagedDirectoryOperationCoordinator({
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'Typora', pid: 38412 }],
    })),
  });

  const result = await coordinator.execute({
    operation,
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    preflightLockCheck: true,
  });

  expect(operation).not.toHaveBeenCalled();
  expect(result.success).toBe(false);
  if (!result.success) expect(result.failure.message).toContain('Typora (PID 38412)');
});

test('preflight lock checks stop an owning runtime before mutating the directory', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  let running = true;
  const stop = vi.fn(async () => {
    running = false;
  });
  const start = vi.fn(async () => {
    running = true;
    return { running: true };
  });
  const operation = vi.fn(async () => {
    expect(running).toBe(false);
    return managedDirectorySuccess(undefined);
  });
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => running,
      ownsProcess: pid => pid === 4242,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop,
      start,
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'OpenClaw Gateway', pid: 4242 }],
    })),
  });

  const result = await coordinator.execute({
    operation,
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    manageRuntimeOnLock: true,
    preflightLockCheck: true,
  });

  expect(result.success).toBe(true);
  expect(operation).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(running).toBe(true);
});

test('does not stop an owning runtime until its native work barrier is ready', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const prepareStop = vi.fn(async () => ({ ready: false }));
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ running: true }));
  const operation = vi.fn(async () => managedDirectorySuccess(undefined));
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => true,
      ownsProcess: pid => pid === 4242,
      prepareStop,
      stop,
      start,
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'OpenClaw Gateway', pid: 4242 }],
    })),
  });

  const result = await coordinator.execute({
    operation,
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    manageRuntimeOnLock: true,
    preflightLockCheck: true,
  });

  expect(result.success).toBe(false);
  if (!result.success) expect(result.failure.message).toContain('Gateway');
  expect(prepareStop).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(operation).not.toHaveBeenCalled();
});

test('reports an operation exception after stopping the runtime and still restores it', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  let running = true;
  const stop = vi.fn(async () => {
    running = false;
  });
  const start = vi.fn(async () => {
    running = true;
    return { running: true };
  });
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => running,
      ownsProcess: pid => pid === 4242,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop,
      start,
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'OpenClaw Gateway', pid: 4242 }],
    })),
  });

  const result = await coordinator.execute({
    operation: async () => {
      throw new Error('CLI launch failed');
    },
    resourceName: 'extension directory',
    targetPath: 'C:\\extensions\\demo',
    manageRuntimeOnLock: true,
    preflightLockCheck: true,
  });

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.reason).toBe('filesystem');
    expect(result.failure.message).toBe('CLI launch failed');
  }
  expect(stop).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(running).toBe(true);
});

test('reports a successful directory mutation as failed when runtime recovery fails', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  let running = true;
  const operation = vi.fn(async () => managedDirectorySuccess(undefined));
  const coordinator = new ManagedDirectoryOperationCoordinator({
    runtime: {
      isRunning: () => running,
      ownsProcess: pid => pid === 4242,
      prepareStop: async () => ({ ready: true, token: 'test-suspension' }),
      stop: vi.fn(async () => {
        running = false;
      }),
      start: vi.fn(async () => ({ running: false, message: 'bridge unavailable' })),
    },
    findLockingProcesses: vi.fn(async () => ({
      available: true,
      processes: [{ name: 'OpenClaw Gateway', pid: 4242 }],
    })),
  });

  const result = await coordinator.execute({
    operation,
    resourceName: 'skill directory',
    targetPath: 'C:\\skills\\demo',
    manageRuntimeOnLock: true,
    preflightLockCheck: true,
  });

  expect(operation).toHaveBeenCalledOnce();
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.reason).toBe('filesystem');
    expect(result.failure.message).toContain('bridge unavailable');
  }
});

test('preserves an unknown lock classification when diagnostics are unavailable', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const coordinator = new ManagedDirectoryOperationCoordinator({
    findLockingProcesses: vi.fn(async () => ({ available: false, processes: [] })),
  });

  const result = await coordinator.execute({
    operation: async () =>
      managedDirectoryFailure(
        managedDirectoryFailureFromMessage('EACCES: rename denied', 'C:\\skills\\demo'),
      ),
    resourceName: 'skill directory',
    targetPath: 'C:\\skills\\demo',
  });

  expect(result.success).toBe(false);
  if (!result.success) expect(result.failure.reason).toBe('locked');
});

test('rechecks an empty lock diagnosis before formatting the owner message', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const root = makeTempDir();
  const target = path.join(root, 'skills', 'demo');
  fs.mkdirSync(target, { recursive: true });
  const findLockingProcesses = vi
    .fn()
    .mockResolvedValueOnce({ available: true, processes: [] })
    .mockResolvedValueOnce({
      available: true,
      processes: [{ name: 'Typora', pid: 26532 }],
    });
  const coordinator = new ManagedDirectoryOperationCoordinator({ findLockingProcesses });

  const result = await coordinator.execute({
    operation: async () =>
      managedDirectoryFailure(managedDirectoryFailureFromMessage('EPERM: rmdir denied', target)),
    resourceName: 'skill directory',
    targetPath: target,
  });

  expect(findLockingProcesses).toHaveBeenCalledTimes(2);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.failure.reason).toBe('locked');
    expect(result.failure.message).toContain('Typora (PID 26532)');
  }
});

test('serializes operations that share a coordinator', async () => {
  const coordinator = new ManagedDirectoryOperationCoordinator();
  let active = 0;
  let maximumActive = 0;
  const operation = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return managedDirectorySuccess(undefined);
  };

  await Promise.all([
    coordinator.execute({ operation, resourceName: 'directory', targetPath: 'one' }),
    coordinator.execute({ operation, resourceName: 'directory', targetPath: 'two' }),
  ]);

  expect(maximumActive).toBe(1);
});
