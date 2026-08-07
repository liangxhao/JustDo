import childProcess from 'child_process';
import { beforeEach, expect, test, vi } from 'vitest';

import { findWindowsLockingProcesses } from './windowsFileLockDiagnostics';

beforeEach(() => {
  vi.restoreAllMocks();
});

test('parses Windows lock owner details asynchronously', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
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

test('does not run Windows diagnostics on other platforms', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const execFile = vi.spyOn(childProcess, 'execFile');

  await expect(findWindowsLockingProcesses('/skills/demo')).resolves.toEqual({
    available: false,
    processes: [],
  });
  expect(execFile).not.toHaveBeenCalled();
});
