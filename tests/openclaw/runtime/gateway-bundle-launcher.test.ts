import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { afterEach, describe, expect, test, vi } from 'vitest';

const {
  buildOpenClawCompileCacheEnvironment,
  buildOpenClawCompileCacheSetupSource,
  buildOpenClawGatewayBundleLauncherSource,
  ensureOpenClawGatewayBundleLauncher,
  GATEWAY_READY_MESSAGE,
} = require('../../../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs') as {
  buildOpenClawCompileCacheEnvironment: (env: NodeJS.ProcessEnv, directory: string, platform?: string) => NodeJS.ProcessEnv;
  buildOpenClawCompileCacheSetupSource: () => string;
  buildOpenClawGatewayBundleLauncherSource: () => string;
  GATEWAY_READY_MESSAGE: string;
  ensureOpenClawGatewayBundleLauncher: (runtimeRoot: string) => {
    changed: boolean;
    launcherPath: string;
    replaced: boolean;
  };
};

const temporaryRoots: string[] = [];

function createRuntime() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-launcher-test-'));
  temporaryRoots.push(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');
  return runtimeRoot;
}

function createArgvRuntime() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-launcher-argv-test-'));
  temporaryRoots.push(runtimeRoot);
  fs.writeFileSync(
    path.join(runtimeRoot, 'gateway-bundle.mjs'),
    `process.stdout.write(JSON.stringify(process.argv));\n`,
  );
  return runtimeRoot;
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('OpenClaw gateway bundle launcher', () => {
  test('disables cache before spawning Windows Node with an oversized cache directory', () => {
    const directory = `C:\\中文项目\\${'long'.repeat(55)}\\.compile-cache`;
    const inherited = { Node_Compile_Cache: 'unsafe-inherited', node_disable_compile_cache: '0', OTHER: 'kept' };
    const env = buildOpenClawCompileCacheEnvironment(inherited, directory, 'win32');
    expect(env).toEqual({ NODE_DISABLE_COMPILE_CACHE: '1', OTHER: 'kept' });
    expect(inherited.Node_Compile_Cache).toBe('unsafe-inherited');
    expect(buildOpenClawCompileCacheEnvironment({}, directory, 'linux').NODE_COMPILE_CACHE).toBe(directory);
    expect(buildOpenClawCompileCacheEnvironment({ NODE_DISABLE_COMPILE_CACHE: '1' }, 'C:\\short', 'win32'))
      .toEqual({ NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: 'C:\\short' });
  });

  test.each([
    ['C:\\short', undefined, true],
    ['C:\\short', '1', false],
    [`C:\\${'long'.repeat(55)}`, undefined, false],
  ])('launcher guards cache activation for %s with disabled=%s', (stateDir, disabled, expected) => {
    const enableCompileCache = vi.fn();
    const env = { OPENCLAW_STATE_DIR: stateDir, NODE_DISABLE_COMPILE_CACHE: disabled };
    vm.runInNewContext(buildOpenClawCompileCacheSetupSource(), {
      path: path.win32,
      process: { platform: 'win32', env, stderr: { write: vi.fn() } },
      require: () => ({ enableCompileCache, getCompileCacheDir: () => 'cache' }),
      __dirname: 'C:\\runtime',
    });
    expect(enableCompileCache).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (stateDir.length > 200) expect(env.NODE_DISABLE_COMPILE_CACHE).toBe('1');
  });

  test('waits for host readiness before flushing a pending Gateway import', async () => {
    const runtimeRoot = createRuntime();
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), [
      "import { getCompileCacheDir } from 'node:module';",
      "import { readdirSync } from 'node:fs';",
      'await new Promise(resolve => setTimeout(resolve, 5500));',
      "process.send({ phase: 'starting', files: readdirSync(getCompileCacheDir()).length });",
      "await new Promise(resolve => process.once('message', resolve));",
      'await new Promise(resolve => setTimeout(resolve, 5500));',
      "process.send({ phase: 'ready', files: readdirSync(getCompileCacheDir()).length });",
      'process.exit(0);',
    ].join('\n'));
    const { launcherPath } = ensureOpenClawGatewayBundleLauncher(runtimeRoot);
    const env = { ...process.env, OPENCLAW_STATE_DIR: runtimeRoot };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const child = spawn(process.execPath, [launcherPath, 'gateway'], {
      env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      const [starting] = await once(child, 'message');
      expect(starting).toEqual({ phase: 'starting', files: 0 });
      const ready = once(child, 'message');
      const exited = once(child, 'exit');
      child.send(GATEWAY_READY_MESSAGE);
      const [result] = await ready;
      expect(result.phase).toBe('ready');
      expect(result.files).toBeGreaterThan(0);
      await exited;
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 15_000);

  test('creates a syntactically valid launcher beside the bundle', () => {
    const runtimeRoot = createRuntime();

    const result = ensureOpenClawGatewayBundleLauncher(runtimeRoot);

    expect(result.changed).toBe(true);
    expect(result.replaced).toBe(false);
    expect(fs.readFileSync(result.launcherPath, 'utf8')).toBe(
      buildOpenClawGatewayBundleLauncherSource(),
    );
    expect(() => execFileSync(process.execPath, ['--check', result.launcherPath])).not.toThrow();
  });

  test('is idempotent and replaces a stale launcher', () => {
    const runtimeRoot = createRuntime();
    const launcherPath = path.join(runtimeRoot, 'gateway-launcher.cjs');
    fs.writeFileSync(launcherPath, 'stale');

    const replaced = ensureOpenClawGatewayBundleLauncher(runtimeRoot);
    const unchanged = ensureOpenClawGatewayBundleLauncher(runtimeRoot);

    expect(replaced).toMatchObject({ changed: true, replaced: true });
    expect(unchanged).toMatchObject({ changed: false, replaced: false });
  });

  test('normalizes Electron Node argv before loading one-shot CLI commands', () => {
    const runtimeRoot = createArgvRuntime();
    const { launcherPath } = ensureOpenClawGatewayBundleLauncher(runtimeRoot);
    const script = [
      `process.argv = ['electron.exe', ${JSON.stringify(launcherPath)}, 'browser', 'extension', 'pair', '--json'];`,
      `require(${JSON.stringify(launcherPath)});`,
    ].join('');

    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });

    expect(JSON.parse(output)).toEqual([
      'node',
      path.join(runtimeRoot, 'gateway-bundle.mjs'),
      'browser',
      'extension',
      'pair',
      '--json',
    ]);
  });

  test('refuses to generate a launcher without a gateway bundle', () => {
    const runtimeRoot = createRuntime();
    fs.rmSync(path.join(runtimeRoot, 'gateway-bundle.mjs'));

    expect(() => ensureOpenClawGatewayBundleLauncher(runtimeRoot)).toThrow(
      /gateway bundle not found/,
    );
  });

  test('flushes compile cache while the Gateway module import remains pending', () => {
    const runtimeRoot = createRuntime();
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), [
      "import { getCompileCacheDir } from 'node:module';",
      "import { readdirSync } from 'node:fs';",
      'await new Promise(resolve => setTimeout(resolve, 5500));',
      'process.stdout.write(JSON.stringify(readdirSync(getCompileCacheDir()).length));',
      'process.exit(0);',
    ].join('\n'));
    const { launcherPath } = ensureOpenClawGatewayBundleLauncher(runtimeRoot);
    const env = { ...process.env, OPENCLAW_STATE_DIR: runtimeRoot };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const output = execFileSync(process.execPath, [launcherPath, 'gateway'], {
      encoding: 'utf8', timeout: 9000,
      env,
    });
    expect(JSON.parse(output)).toBeGreaterThan(0);
  }, 10_000);
});
