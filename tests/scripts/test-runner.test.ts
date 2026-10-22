import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, test, vi } from 'vitest';

const projectRoot = process.cwd();
const runnerPath = path.join(projectRoot, 'scripts/test/run-tests.cjs');
const npmCli = path.join(projectRoot, 'node_modules/npm/bin/npm-cli.js');
const vitestCli = path.join(projectRoot, 'node_modules/vitest/vitest.mjs');
const restoreScript = path.join(projectRoot, 'scripts/electron/rebuild-electron-native.cjs');

function runTestRunner(exitCodes: { verification?: number; tests?: number }) {
  const spawnSync = vi.fn((_executable: string, args: string[]) => ({
    status:
      args[0] === '-e'
        ? (exitCodes.verification ?? 0)
        : args[0] === vitestCli
          ? (exitCodes.tests ?? 0)
          : 0,
  }));
  const exit = vi.fn();
  const require = Object.assign(
    (id: string) => {
      if (id === 'node:child_process') return { spawnSync };
      if (id === 'node:path') return path;
      throw new Error(`Unexpected test runner dependency: ${id}`);
    },
    { resolve: () => path.join(projectRoot, 'node_modules/vitest/package.json') },
  );
  runInNewContext(fs.readFileSync(runnerPath, 'utf8'), {
    __dirname: path.dirname(runnerPath),
    require,
    console: { log: vi.fn(), error: vi.fn() },
    process: {
      env: { npm_execpath: npmCli },
      execPath: process.execPath,
      argv: [process.execPath, runnerPath],
      exit,
    },
  });
  return { commands: spawnSync.mock.calls.map(([, args]) => args[0]), exit };
}

test('stops before Vitest when the native binding fails verification after a successful rebuild', () => {
  const { commands, exit } = runTestRunner({ verification: 1 });

  expect(commands).toEqual([npmCli, '-e', restoreScript]);
  expect(exit).toHaveBeenCalledWith(1);
});

test('verifies the host binding before tests and restores Electron when tests fail', () => {
  const { commands, exit } = runTestRunner({ tests: 1 });

  expect(commands).toEqual([npmCli, '-e', vitestCli, restoreScript]);
  expect(exit).toHaveBeenCalledWith(1);
});
