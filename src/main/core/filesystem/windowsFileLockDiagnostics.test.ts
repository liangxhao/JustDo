import childProcess from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { findWindowsLockingProcesses } from './windowsFileLockDiagnostics';

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); });

function closingChild(): ReturnType<typeof childProcess.execFile> {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit('close', 0, null));
  return child as ReturnType<typeof childProcess.execFile>;
}

function mockLookupOutput(stdout: string, error: NodeJS.ErrnoException | null = null) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'lstatSync').mockReturnValue({} as fs.Stats);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(childProcess, 'execFile').mockImplementation(((
    _file, _args, _options, callback,
  ) => {
    callback?.(error, stdout, '');
    return closingChild();
  }) as typeof childProcess.execFile);
}

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
      [JSON.stringify({ name: 'Code', pid: 1234, serviceName: '' }),
        JSON.stringify({ name: 'Antivirus', pid: 5678, serviceName: 'scanner' }),
        '{"complete":true}'].join('\n'),
      '',
    );
    return closingChild();
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
      env: expect.objectContaining({ JUSTDO_LOCK_TARGET: 'C:\\skills\\demo', FILE_LOCK_PRIORITY_PID: String(process.pid) }),
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
    callback?.(null, '{"complete":true}\n', '');
    return closingChild();
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

test('physical target lookup matches aliases and always prioritizes the current application PID', async () => {
  const exec = mockLookupOutput('{"complete":true}\n');
  vi.stubEnv('FILE_LOCK_PRIORITY_PID', '999');
  vi.spyOn(fs.realpathSync, 'native').mockReturnValue('C:\\physical\\openclaw');

  await findWindowsLockingProcesses('C:\\profile-alias\\openclaw');

  expect(exec).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
    env: expect.objectContaining({ JUSTDO_LOCK_TARGET: 'C:\\physical\\openclaw', FILE_LOCK_PRIORITY_PID: String(process.pid) }),
  }), expect.any(Function));
});

test('a later scan timeout retains earlier complete process records but discards a truncated record', async () => {
  mockLookupOutput('{"name":"ObservedApp","pid":4321}\n{"name":"unfinished',
    Object.assign(new Error('lookup timed out'), { code: 'ETIMEDOUT' }));

  await expect(findWindowsLockingProcesses('C:\\profile\\openclaw')).resolves.toEqual({
    available: true, processes: [{ name: 'ObservedApp', pid: 4321 }],
  });
});

test.each([
  ['', null, false],
  ['{"complete":true}\n', null, true],
  ['{"complete":true}\n', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), false],
] as const)('only a completed successful scan establishes an empty result (%s)', async (stdout, error, available) => {
  mockLookupOutput(stdout, error);
  await expect(findWindowsLockingProcesses('C:\\profile\\openclaw')).resolves.toEqual({ available, processes: [] });
});

test('process records require a name and numeric PID and are deduplicated across lookup methods', async () => {
  mockLookupOutput([
    '{"name":"ObservedApp","pid":4321}',
    '{"name":"ObservedApp","pid":4321}',
    '{"pid":7000}',
    '{"name":"InvalidApp","pid":"7001"}',
    '{"name":"InvalidApp","pid":-1}',
    '[{"name":"InvalidApp","pid":7002}]',
    '{"complete":true}',
  ].join('\n'));
  await expect(findWindowsLockingProcesses('C:\\profile\\openclaw')).resolves.toEqual({
    available: true, processes: [{ name: 'ObservedApp', pid: 4321 }],
  });
});

test('an already cancelled lookup never starts a diagnostic child', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const controller = new AbortController();
  controller.abort();
  const execFile = vi.spyOn(childProcess, 'execFile');
  await expect(findWindowsLockingProcesses('C:\\history', { signal: controller.signal })).resolves.toEqual({
    available: false, processes: [],
  });
  expect(execFile).not.toHaveBeenCalled();
});

test('an aborted callback cannot report retirement before the owned child close', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'lstatSync').mockReturnValue({} as fs.Stats);
  const controller = new AbortController();
  const child = new EventEmitter();
  const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation(((
    _file, _args, options, callback,
  ) => {
    options.signal.addEventListener('abort', () => callback(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }), '', ''));
    return child as ReturnType<typeof childProcess.execFile>;
  }) as typeof childProcess.execFile);
  let retired = false;
  const result = findWindowsLockingProcesses('C:\\history', { signal: controller.signal })
    .then(value => { retired = true; return value; });
  controller.abort();
  await Promise.resolve();
  expect(retired).toBe(false);
  child.emit('close', null, 'SIGTERM');
  await expect(result).resolves.toEqual({ available: false, processes: [] });
  expect(execFile).toHaveBeenCalledOnce();
});

test('a synchronous diagnostic launch failure settles without a child to join', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(fs, 'lstatSync').mockReturnValue({} as fs.Stats);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(childProcess, 'execFile').mockImplementation(() => { throw new Error('spawn unavailable'); });
  await expect(findWindowsLockingProcesses('C:\\history')).resolves.toEqual({ available: false, processes: [] });
});
