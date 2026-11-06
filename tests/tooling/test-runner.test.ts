import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, test, vi } from 'vitest';

const projectRoot = process.cwd();
const runnerPath = path.join(projectRoot, 'scripts/test/run-tests.cjs');
const npmCli = path.join(projectRoot, 'node_modules/npm/bin/npm-cli.js');
const vitestCli = path.join(projectRoot, 'node_modules/vitest/vitest.mjs');
const patchScript = path.join(projectRoot, 'scripts/runtime/patch-http-mitm-proxy.cjs');
const sqliteModule = path.join(projectRoot, 'build/test-dependencies/fixture/lib/index.js');
const suites = ['team-fixture', 'workflow-fixture'].map(name => ({
  root: path.join(projectRoot, 'plugins/extensions', name),
  config: path.join(projectRoot, 'plugins/extensions', name, 'vitest.config.ts'),
}));

function runTestRunner(exitCodes: {
  verification?: number; tests?: number; plugins?: number[]; args?: string[];
  patch?: number; cleanupFails?: boolean;
}) {
  let pluginIndex = 0;
  const spawnSync = vi.fn((_executable: string, args: string[], _options: unknown) => ({
    status: args[0] === patchScript ? exitCodes.patch ?? 0
      : args.includes('--config') ? exitCodes.plugins?.[pluginIndex++] ?? 0
      : exitCodes.tests ?? 0,
  }));
  const dispose = vi.fn(() => { if (exitCodes.cleanupFails) throw new Error('Cleanup failed'); });
  const prepare = vi.fn(() => {
    if (exitCodes.verification) throw new Error('SQLite verification failed');
    return { modulePath: sqliteModule, dispose };
  });
  const discover = vi.fn(() => suites);
  const exit = vi.fn();
  const require = Object.assign(
    (id: string) => {
      if (id === 'node:child_process') return { spawnSync };
      if (id === 'node:path') return path;
      if (id === './sqlite-test-module.cjs') return { prepareSqliteTestModule: prepare };
      if (id === './app-plugin-test-suites.cjs') return { discoverAppPluginTestSuites: discover };
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
      argv: [process.execPath, runnerPath, ...(exitCodes.args ?? [])],
      exit,
    },
  });
  return { commands: spawnSync.mock.calls.map(([, args]) => args[0]), spawnSync, prepare, dispose, discover, exit };
}

test('stops before suites when isolated SQLite verification fails without rebuilding shared dependencies', () => {
  const { commands, exit, prepare, discover } = runTestRunner({ verification: 1 });

  expect(commands).toEqual([patchScript]);
  expect(prepare).toHaveBeenCalledOnce();
  expect(discover).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(1);
});

test('runs independent plugin suites after a failed main suite and disposes the private driver', () => {
  const { commands, exit, dispose, spawnSync } = runTestRunner({ tests: 1 });

  expect(commands).toEqual([patchScript, vitestCli, vitestCli, vitestCli]);
  expect(dispose).toHaveBeenCalledOnce();
  for (const [, , options] of spawnSync.mock.calls.slice(1)) {
    expect(options).toMatchObject({
      env: { SQLITE_TEST_MODULE: sqliteModule, APP_PLUGIN_TEST_SQLITE_MODULE: sqliteModule },
      windowsHide: true,
    });
  }
  expect(exit).toHaveBeenCalledWith(1);
});

test('continues to the last independent plugin after an earlier plugin fails', () => {
  const result = runTestRunner({ plugins: [2, 0] });
  expect(result.spawnSync.mock.calls.slice(2).map(([, args]) => args)).toEqual(
    suites.map(suite => [vitestCli, 'run', '--config', suite.config]),
  );
  expect(result.exit).toHaveBeenCalledWith(2);
  expect(result.dispose).toHaveBeenCalledOnce();
});

test('keeps a focused invocation focused and releases its isolated native dependency', () => {
  const result = runTestRunner({ args: ['src/focused.test.ts'] });
  expect(result.commands).toEqual([patchScript, vitestCli]);
  expect(result.spawnSync.mock.calls[1][1]).toEqual([vitestCli, 'run', 'src/focused.test.ts']);
  expect(result.discover).not.toHaveBeenCalled();
  expect(result.dispose).toHaveBeenCalledOnce();
  expect(result.exit).toHaveBeenCalledWith(0);
});

test('fails before preparing or executing suites when the required dependency patch fails', () => {
  const result = runTestRunner({ patch: 1 });
  expect(result.commands).toEqual([patchScript]);
  expect(result.prepare).not.toHaveBeenCalled();
  expect(result.exit).toHaveBeenCalledWith(1);
});

test('reports private-driver cleanup failure even if all suites passed', () => {
  const result = runTestRunner({ cleanupFails: true });
  expect(result.commands).toHaveLength(4);
  expect(result.dispose).toHaveBeenCalledOnce();
  expect(result.exit).toHaveBeenCalledWith(1);
});
