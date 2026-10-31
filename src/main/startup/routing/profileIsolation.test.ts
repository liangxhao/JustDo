import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { findWindowsLockingProcesses } from '../../core/filesystem/windowsFileLockDiagnostics';
import { getHistoryLockDiagnostic } from '../history/historyFailure';
import { archiveRequiredProfileEntry, releaseStartupProfileWorkingDirectory } from './profileIsolation';

vi.mock('../../core/filesystem/windowsFileLockDiagnostics', () => ({
  findWindowsLockingProcesses: vi.fn(),
}));

const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.mocked(findWindowsLockingProcesses).mockReset().mockResolvedValue({ available: false, processes: [] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-isolation-'));
  roots.push(userData);
  const source = path.join(userData, 'openclaw');
  const relative = path.join('backups', 'transaction', 'retired', 'openclaw');
  const destination = path.join(userData, relative);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'original'), 'retained data');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  return { userData, source, destination, relative,
    options: { assertActive: vi.fn(), beforeRetry: vi.fn() } };
}

test.each(['openclaw', 'outbound-header-proxy', 'developer'])(
  'releases a working directory inherited inside %s before new children can inherit it', entry => {
    const userData = path.resolve(os.tmpdir(), 'profile-cwd');
    const name = process.platform === 'win32' ? entry.toUpperCase() : entry;
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(userData, name, 'nested'));
    const change = vi.spyOn(process, 'chdir').mockImplementation(() => {});
    expect(releaseStartupProfileWorkingDirectory(userData)).toBe(name);
    expect(change).toHaveBeenCalledExactlyOnceWith(userData);
  },
);

test('does not change ordinary working directories or match sibling path prefixes', () => {
  const userData = path.resolve(os.tmpdir(), 'profile-cwd');
  const current = vi.spyOn(process, 'cwd');
  const change = vi.spyOn(process, 'chdir').mockImplementation(() => {});
  for (const directory of [userData, `${userData}-other/openclaw`, path.join(userData, 'openclaw-other'),
    path.join(userData, 'backups', 'openclaw')]) {
    current.mockReturnValue(directory);
    expect(releaseStartupProfileWorkingDirectory(userData)).toBeUndefined();
  }
  expect(change).not.toHaveBeenCalled();
});

test('retries a transient Windows sharing error and moves the original directory', async () => {
  const f = fixture();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const rename = fs.promises.rename.bind(fs.promises);
  const move = vi.spyOn(fs.promises, 'rename')
    .mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code: 'EPERM' }))
    .mockImplementation(rename);
  const operation = archiveRequiredProfileEntry(f.userData, 'openclaw', f.relative, f.options);
  await vi.runAllTimersAsync();
  await operation;
  expect(move).toHaveBeenCalledTimes(2);
  expect(f.options.beforeRetry).toHaveBeenCalledOnce();
  expect(findWindowsLockingProcesses).not.toHaveBeenCalled();
  expect(fs.existsSync(f.source)).toBe(false);
  expect(fs.readFileSync(path.join(f.destination, 'original'), 'utf8')).toBe('retained data');
});

test('persistent Windows denial exhausts a bounded retry and preserves the original error and data', async () => {
  const f = fixture();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const failure = Object.assign(new Error('permanent denial'), { code: 'EPERM' });
  const move = vi.spyOn(fs.promises, 'rename').mockRejectedValue(failure);
  vi.mocked(findWindowsLockingProcesses).mockResolvedValue({
    available: true, processes: [{ name: 'fixture-app', pid: process.pid }, { name: 'fixture-holder', pid: process.pid + 1 }],
  });
  const result = expect(archiveRequiredProfileEntry(f.userData, 'openclaw', f.relative, f.options)).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  await result;
  expect(move).toHaveBeenCalledTimes(6);
  expect(findWindowsLockingProcesses).toHaveBeenCalledExactlyOnceWith(f.source);
  expect(getHistoryLockDiagnostic(failure)).toEqual({
    targetPath: f.source, available: true,
    processes: [
      { name: 'fixture-app', pid: process.pid, isMainProcess: true },
      { name: 'fixture-holder', pid: process.pid + 1, isMainProcess: false },
    ],
  });
  expect(fs.readFileSync(path.join(f.source, 'original'), 'utf8')).toBe('retained data');
  expect(fs.existsSync(f.destination)).toBe(false);
  expect(console.warn).toHaveBeenLastCalledWith(
    '[StartupCoordinator] Required profile archive failed:', expect.objectContaining({
      entry: 'openclaw', attempts: 6, lockDiagnosticsAvailable: true,
      processesWithDirectoryHandles: [
        { name: 'fixture-app', pid: process.pid, isMainProcess: true },
        { name: 'fixture-holder', pid: process.pid + 1, isMainProcess: false },
      ],
    }),
  );
});

test('a diagnostic failure leaves the original sharing error intact', async () => {
  const f = fixture();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const failure = Object.assign(new Error('permanent denial'), { code: 'EPERM' });
  vi.spyOn(fs.promises, 'rename').mockRejectedValue(failure);
  vi.mocked(findWindowsLockingProcesses).mockRejectedValue(new Error('diagnostic process unavailable'));
  const result = expect(archiveRequiredProfileEntry(f.userData, 'openclaw', f.relative, f.options)).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  await result;
  expect(getHistoryLockDiagnostic(failure)).toEqual({ targetPath: f.source, available: false, processes: [] });
  expect(console.warn).toHaveBeenLastCalledWith(
    '[StartupCoordinator] Required profile archive failed:', expect.objectContaining({ lockDiagnosticsAvailable: false }),
  );
});

test('a destination appearing during a retry is preserved and never overwritten', async () => {
  const f = fixture();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const move = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
    fs.mkdirSync(f.destination);
    fs.writeFileSync(path.join(f.destination, 'other'), 'another original');
    throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
  });
  const result = expect(archiveRequiredProfileEntry(f.userData, 'openclaw', f.relative, f.options))
    .rejects.toThrow(/conflicting destination/);
  await vi.runAllTimersAsync();
  await result;
  expect(move).toHaveBeenCalledOnce();
  expect(fs.readFileSync(path.join(f.destination, 'other'), 'utf8')).toBe('another original');
  expect(fs.existsSync(f.source)).toBe(true);
});

test('a source disappearing during a retry does not turn an uncertain move into success', async () => {
  const f = fixture();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const move = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
    fs.renameSync(f.source, `${f.source}-external`);
    throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  });
  const result = expect(archiveRequiredProfileEntry(f.userData, 'openclaw', f.relative, f.options))
    .rejects.toThrow(/source entry is missing/);
  await vi.runAllTimersAsync();
  await result;
  expect(move).toHaveBeenCalledOnce();
  expect(fs.existsSync(`${f.source}-external`)).toBe(true);
  expect(fs.existsSync(f.destination)).toBe(false);
});

test('checks the destination again after retry history verification completes', async () => {
  const f = fixture();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const move = vi.spyOn(fs.promises, 'rename')
    .mockRejectedValue(Object.assign(new Error('sharing violation'), { code: 'EPERM' }));
  f.options.beforeRetry.mockImplementation(() => { fs.mkdirSync(f.destination); });
  const result = expect(archiveRequiredProfileEntry(f.userData, 'openclaw', f.relative, f.options))
    .rejects.toThrow(/conflicting destination/);
  await vi.runAllTimersAsync();
  await result;
  expect(move).toHaveBeenCalledOnce();
  expect(fs.existsSync(f.source)).toBe(true);
  expect(fs.existsSync(f.destination)).toBe(true);
});

test.each(['ENOSPC', 'EIO'])('does not retry a storage failure (%s)', async code => {
  const f = fixture();
  const failure = Object.assign(new Error('storage failure'), { code });
  const move = vi.spyOn(fs.promises, 'rename').mockRejectedValue(failure);
  await expect(archiveRequiredProfileEntry(f.userData, 'openclaw', f.relative, f.options)).rejects.toBe(failure);
  expect(move).toHaveBeenCalledOnce();
  expect(f.options.beforeRetry).not.toHaveBeenCalled();
  expect(findWindowsLockingProcesses).not.toHaveBeenCalled();
});
