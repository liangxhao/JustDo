import { expect, it, vi } from 'vitest';

const { runningGateways, assertNoRunningGateways } =
  require('../../scripts/plugins/app-plugin-runtime-processes.cjs');

it.each(['linux', 'darwin'] as const)('reads real process arguments on %s instead of assuming a cold runtime', platform => {
  const execFileSync = vi.fn(() => [
    '  100 /usr/bin/node /workspace/managed-runtime/gateway-launcher.cjs --gateway',
    '  101 /usr/bin/node /workspace/application/scripts/plugins/build-app-plugins.mjs',
    '  102 ps -ax -o pid= -o command=',
  ].join('\n'));
  expect(runningGateways(['/workspace/managed-runtime'], { platform, execFileSync })).toEqual([100]);
  expect(execFileSync).toHaveBeenCalledWith('ps', ['-ax', '-o', 'pid=', '-o', 'command='],
    expect.objectContaining({ encoding: 'utf8', windowsHide: true }));
  expect(() => assertNoRunningGateways(['/workspace/managed-runtime'], roots =>
    runningGateways(roots, { platform, execFileSync }))).toThrow('Gateway PID: 100');
});

it('admits a POSIX inventory containing no Gateway and rejects unknown ownership', () => {
  const read = (output: string) => () => output;
  expect(runningGateways(['/workspace/runtime'], {
    platform: 'linux', execFileSync: read('100 /usr/bin/node /workspace/application/main.js\n101 ps -ax'),
  })).toEqual([]);
  for (const output of ['', 'not a process inventory', '100 /usr/bin/node gateway-launcher.cjs']) {
    expect(() => runningGateways(['/workspace/runtime'], {
      platform: 'linux', execFileSync: read(output),
    })).toThrow(/unavailable/u);
  }
});

it('keeps Windows process matching and refuses unreadable command lines', () => {
  expect(runningGateways(['C:\\runtime'], { platform: 'win32', execFileSync: () => JSON.stringify([
    { ProcessId: 100, CommandLine: 'node "C:\\runtime\\gateway-launcher.cjs"' },
    { ProcessId: 101, CommandLine: 'node C:\\application\\main.js' },
  ]) })).toEqual([100]);
  expect(() => runningGateways(['C:\\runtime'], { platform: 'win32', execFileSync: () =>
    JSON.stringify([{ ProcessId: 100, CommandLine: null }]),
  })).toThrow('unavailable');
});
