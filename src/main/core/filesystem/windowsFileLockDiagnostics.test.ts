import childProcess from 'child_process';
import fs from 'fs';
import { beforeEach, expect, test, vi } from 'vitest';

import { findWindowsLockingProcesses } from './windowsFileLockDiagnostics';

beforeEach(() => {
  vi.restoreAllMocks();
});

test('parses Windows lock owner details asynchronously', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'lstatSync').mockReturnValue({} as fs.Stats);
  const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation(((
    _file,
    _args,
    _options,
    callback,
  ) => {
    callback?.(
      null,
      JSON.stringify([
        { name: 'Code', pid: 1234, serviceName: '' },
        { name: 'Antivirus', pid: 5678, serviceName: 'scanner' },
      ]),
      '',
    );
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as typeof childProcess.execFile);

  await expect(findWindowsLockingProcesses('C:\\skills\\demo')).resolves.toEqual({
    available: true,
    processes: [
      { name: 'Code', pid: 1234 },
      { name: 'Antivirus', pid: 5678, serviceName: 'scanner' },
    ],
  });
  expect(execFile).toHaveBeenCalledWith(
    expect.stringMatching(/powershell\.exe$/i),
    expect.arrayContaining(['-EncodedCommand']),
    expect.objectContaining({
      env: expect.objectContaining({ JUSTDO_LOCK_TARGET: 'C:\\skills\\demo' }),
      timeout: 10_000,
      windowsHide: true,
    }),
    expect.any(Function),
  );
});

test.each(['ENOENT', 'ENOTDIR'])('skips an absent target without claiming that it is unlocked (%s)', async code => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
    throw Object.assign(new Error('Missing target'), { code });
  });
  const execFile = vi.spyOn(childProcess, 'execFile');

  await expect(findWindowsLockingProcesses('C:\\中文 空格\\not-installed')).resolves.toEqual({
    available: false, processes: [],
  });
  expect(execFile).not.toHaveBeenCalled();
});

test('does not mistake an inaccessible target for an absent one', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
    throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
  });
  const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation(((
    _file, _args, _options, callback,
  ) => {
    callback?.(null, '[]', '');
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as typeof childProcess.execFile);

  await expect(findWindowsLockingProcesses('C:\\protected')).resolves.toEqual({
    available: true, processes: [],
  });
  expect(execFile).toHaveBeenCalledOnce();
});

test('does not run Windows diagnostics on other platforms', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const execFile = vi.spyOn(childProcess, 'execFile');

  await expect(findWindowsLockingProcesses('/skills/demo')).resolves.toEqual({
    available: false,
    processes: [],
  });
  expect(execFile).not.toHaveBeenCalled();
});
