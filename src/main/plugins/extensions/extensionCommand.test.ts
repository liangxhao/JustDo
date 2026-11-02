import type { ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { runExtensionCommand } from './extensionCommand';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn((_signal: NodeJS.Signals) => true);

  constructor(readonly pid: number | undefined) {
    super();
  }
}

const createCommand = (platform: NodeJS.Platform = 'win32') => {
  const target = new FakeChild(123);
  const helpers: FakeChild[] = [];
  const spawn = vi.fn((executable: string, _args: string[], _options: SpawnOptions) => {
    if (executable !== 'taskkill') return target as unknown as ChildProcess;
    const helper = new FakeChild(200 + helpers.length);
    helpers.push(helper);
    return helper as unknown as ChildProcess;
  });
  const onOutput = vi.fn();
  const command = runExtensionCommand(
    'native-cli',
    ['plugins', 'install', 'source'],
    { cwd: 'runtime', env: {}, successPattern: /^Final native receipt\.$/m, onOutput },
    { spawn, platform },
  );
  const resolved = vi.fn();
  const rejected = vi.fn();
  void command.then(resolved, rejected);
  return { target, helpers, spawn, onOutput, command, resolved, rejected };
};

const expectPending = (fixture: ReturnType<typeof createCommand>) => {
  expect(fixture.resolved).not.toHaveBeenCalled();
  expect(fixture.rejected).not.toHaveBeenCalled();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('keeps mutation guards pending after Windows termination helper exit, errors and escalation', async () => {
  const fixture = createCommand();
  fixture.target.stdout.emit('data', 'Final native receipt.\n');

  await vi.advanceTimersByTimeAsync(250);
  expect(fixture.spawn).toHaveBeenLastCalledWith(
    'taskkill',
    ['/pid', '123', '/T', '/F'],
    { stdio: 'ignore', windowsHide: true },
  );
  fixture.helpers[0].emit('exit', 0);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fixture.helpers).toHaveLength(2);
  fixture.helpers[1].emit('error', new Error('Termination helper failed'));
  fixture.target.emit('error', new Error('Target kill request failed'));
  await vi.advanceTimersByTimeAsync(50);
  expectPending(fixture);

  fixture.target.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(50);
  await expect(fixture.command).resolves.toMatchObject({ exitCode: 0 });
  expect(vi.getTimerCount()).toBe(0);
});

test('requires target exit after both POSIX graceful and forced termination requests', async () => {
  const fixture = createCommand('linux');
  fixture.target.stdout.emit('data', 'Final native receipt.\n');

  await vi.advanceTimersByTimeAsync(250);
  expect(fixture.target.kill).toHaveBeenLastCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fixture.target.kill).toHaveBeenLastCalledWith('SIGKILL');
  expectPending(fixture);

  fixture.target.emit('exit', null, 'SIGKILL');
  await vi.advanceTimersByTimeAsync(50);
  await expect(fixture.command).resolves.toMatchObject({ exitCode: 0 });
});

test('keeps a timeout sticky while waiting for exit despite a late success receipt', async () => {
  const fixture = createCommand('linux');
  fixture.target.kill.mockImplementation(() => {
    throw new Error('Termination rejected');
  });

  await vi.advanceTimersByTimeAsync(300_000);
  expect(fixture.target.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expectPending(fixture);
  fixture.target.stdout.emit('data', 'Final native receipt.\n');
  await vi.advanceTimersByTimeAsync(2_250);
  expect(fixture.target.kill).toHaveBeenCalledTimes(1);
  expectPending(fixture);

  fixture.target.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(50);
  const result = await fixture.command;
  expect(result).toMatchObject({
    exitCode: 124,
    timedOut: true,
    stdout: 'Final native receipt.\n',
  });
  expect(result).not.toHaveProperty('nativeReceiptObserved');
});

test('does not settle a timed-out Windows command when its termination helper fails', async () => {
  const fixture = createCommand();

  await vi.advanceTimersByTimeAsync(300_000);
  fixture.helpers[0].emit('error', new Error('taskkill could not start'));
  await vi.advanceTimersByTimeAsync(50);
  expectPending(fixture);

  fixture.target.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(50);
  await expect(fixture.command).resolves.toMatchObject({ exitCode: 124, timedOut: true });
});

test('holds the command after a post-spawn error, then finishes on exit without waiting for close', async () => {
  const fixture = createCommand();
  fixture.target.emit('spawn');
  fixture.target.emit('error', new Error('Target process error'));
  await vi.advanceTimersByTimeAsync(50);
  expectPending(fixture);

  fixture.target.emit('exit', 1);
  fixture.target.stderr.emit('data', 'Native failure details');
  await vi.advanceTimersByTimeAsync(50);
  await expect(fixture.command).resolves.toEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'Native failure details',
  });
  expect(fixture.onOutput).toHaveBeenCalledWith('Native failure details');
});

test('rejects a proven spawn failure and clears its timeout', async () => {
  const failure = new Error('Executable not found');
  const target = new FakeChild(undefined);
  const spawn = vi.fn(() => target as unknown as ChildProcess);
  const command = runExtensionCommand('missing-cli', [], { cwd: 'runtime', env: {} }, { spawn });
  const assertion = expect(command).rejects.toBe(failure);

  target.emit('error', failure);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

test('preserves a native failure that exits before receipt-triggered termination starts', async () => {
  const fixture = createCommand();
  fixture.target.stdout.emit('data', 'Final native receipt.\n');
  await vi.advanceTimersByTimeAsync(100);
  fixture.target.stderr.emit('data', 'Native finalization failed');
  fixture.target.emit('exit', 1);

  await vi.advanceTimersByTimeAsync(200);
  await expect(fixture.command).resolves.toMatchObject({
    exitCode: 1,
    stderr: 'Native finalization failed',
  });
  expect(fixture.helpers).toHaveLength(0);
});

test('preserves both the native receipt and a failure after a Windows termination helper fails', async () => {
  const fixture = createCommand();
  fixture.target.stdout.emit('data', 'Final native receipt.\n');
  await vi.advanceTimersByTimeAsync(250);
  fixture.helpers[0].emit('error', new Error('taskkill could not start'));
  fixture.target.stderr.emit('data', 'Native finalization failed');

  fixture.target.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(50);

  await expect(fixture.command).resolves.toMatchObject({
    exitCode: 1,
    stderr: 'Native finalization failed',
    nativeReceiptObserved: true,
  });
});

test('waits for a late Windows cleanup outcome after the target exit without using the flush timer as evidence', async () => {
  const fixture = createCommand();
  fixture.target.stdout.emit('data', 'Final native receipt.\n');
  await vi.advanceTimersByTimeAsync(250);
  fixture.target.emit('exit', 1);

  await vi.advanceTimersByTimeAsync(50);
  expectPending(fixture);
  fixture.helpers[0].emit('exit', 0);

  await expect(fixture.command).resolves.toMatchObject({
    exitCode: 0,
    nativeReceiptObserved: true,
  });
});

test('does not wait for a Windows helper to classify an actual zero exit', async () => {
  const fixture = createCommand();
  fixture.target.stdout.emit('data', 'Final native receipt.\n');
  await vi.advanceTimersByTimeAsync(250);

  fixture.target.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(50);

  await expect(fixture.command).resolves.toMatchObject({
    exitCode: 0,
    nativeReceiptObserved: true,
  });
});

test('does not wait for Windows helpers to classify a sticky timeout after target exit', async () => {
  const fixture = createCommand();
  fixture.target.stdout.emit('data', 'Final native receipt.\n');
  await vi.advanceTimersByTimeAsync(300_000);

  fixture.target.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(50);

  await expect(fixture.command).resolves.toMatchObject({
    exitCode: 124,
    timedOut: true,
    nativeReceiptObserved: true,
  });
});

test('observes a final receipt flushed after target exit without scheduling termination', async () => {
  const fixture = createCommand();
  fixture.target.emit('exit', 1);
  fixture.target.stdout.emit('data', 'Final native receipt.\n');

  await vi.advanceTimersByTimeAsync(50);

  await expect(fixture.command).resolves.toMatchObject({
    exitCode: 1,
    nativeReceiptObserved: true,
  });
  expect(fixture.helpers).toHaveLength(0);
});

test.each(['accepted', 'refused', 'thrown'] as const)(
  'preserves a natural POSIX failure after a termination request was %s',
  async outcome => {
    const fixture = createCommand('linux');
    fixture.target.kill.mockImplementation(() => {
      if (outcome === 'thrown') throw new Error('Termination rejected');
      return outcome === 'accepted';
    });
    fixture.target.stdout.emit('data', 'Final native receipt.\n');
    await vi.advanceTimersByTimeAsync(250);
    fixture.target.stderr.emit('data', 'Native finalization failed');

    fixture.target.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(50);

    await expect(fixture.command).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Native finalization failed',
    });
  },
);
