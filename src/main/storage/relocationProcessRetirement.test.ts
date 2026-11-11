import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { assertStorageProcessesRetired, findStorageProcessIdentity, readStorageProcessIdentity, StorageProcessesStillRunningError } from './relocationProcessRetirement';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, execFileSync: mocks.execFileSync }));

const created = 1_700_000_000_000;
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.stubEnv('SystemRoot', process.cwd());
  mocks.execFile.mockReset();
  mocks.execFileSync.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function reportProcesses(rows: unknown) {
  mocks.execFile.mockImplementation(
    (_file, _args, _options, done: (error: null, stdout: string) => void) => {
      done(null, JSON.stringify(rows));
    },
  );
}

test('reports confirmed prior processes with a display name or PID only', async () => {
  reportProcesses([
    { pid: 101, creationTime: created, name: '资料助手' },
    { pid: 102, creationTime: created, name: 'C:/private/process.exe' },
    { pid: 103, creationTime: created + 60_000, name: 'another process' },
  ]);

  const retirement = assertStorageProcessesRetired([
    { pid: 101, creationTime: created },
    { pid: 102, creationTime: created + 0.25 },
    { pid: 103, creationTime: created },
  ]);

  await expect(retirement).rejects.toBeInstanceOf(StorageProcessesStillRunningError);
  await expect(retirement).rejects.toMatchObject({
    processes: [{ pid: 101, name: '资料助手' }, { pid: 102 }],
  });
});

test('fences a close creation-time match without attributing it to the old process', async () => {
  reportProcesses([{ pid: 101, creationTime: created + 500, name: 'unknown process' }]);

  const retirement = assertStorageProcessesRetired([{ pid: 101, creationTime: created }]);

  await expect(retirement).rejects.toThrow('An application process is still retiring.');
  await expect(retirement).rejects.not.toBeInstanceOf(StorageProcessesStillRunningError);
});

test('allows retirement when the prior PID is gone or reused with a different creation time', async () => {
  reportProcesses([{ pid: 101, creationTime: created + 60_000, name: 'another process' }]);

  await expect(assertStorageProcessesRetired([
    { pid: 101, creationTime: created },
    { pid: 102, creationTime: created },
  ])).resolves.toBeUndefined();
});

test('ignores an already exited Gateway when recording processes, while workers require a live identity', () => {
  mocks.execFileSync.mockReturnValue('null');

  expect(findStorageProcessIdentity(101)).toBeNull();
  expect(() => readStorageProcessIdentity(101)).toThrow('Process identity is unavailable.');
});
