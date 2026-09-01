import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

type PatchModule = {
  applyPatch: (runtimeDir: string) => string[];
  verifyPatch: (runtimeDir: string) => void;
  __testing?: Record<string, unknown>;
};

const patchRoot = path.resolve('scripts/patches/v2026.8.1');
const runtimeRoot = path.resolve('vendor/openclaw-runtime/win-x64');
const patchFiles = fs
  .readdirSync(patchRoot)
  .filter(name => /^\d{3}-.*\.cjs$/u.test(name))
  .sort();
const patches = new Map(
  patchFiles.map(name => [name.slice(0, 3), require(path.join(patchRoot, name)) as PatchModule]),
);

const runtimeIsV2026_8_1 = (() => {
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, 'runtime-build-info.json'), 'utf8'),
    ) as { openclawVersion?: string };
    return info.openclawVersion === 'v2026.8.1';
  } catch {
    return false;
  }
})();

describe('OpenClaw v2026.8.1 capability patches', () => {
  test('contains exactly the nine retained capability patches', () => {
    expect(patchFiles).toEqual([
      '001-managed-pip-config-environment.cjs',
      '002-windows-mcp-package-runner.cjs',
      '003-chrome-mcp-launch-diagnostics.cjs',
      '004-chrome-mcp-empty-page-recovery.cjs',
      '005-final-system-prompt-replacements.cjs',
      '006-agent-request-metadata.cjs',
      '007-request-purpose-metadata.cjs',
      '008-app-startup-task-recovery-boundary.cjs',
      '009-memory-force-reembed-opt-in.cjs',
    ]);
  });

  test('accepts only exact app-proven managed Python values', () => {
    const testing = patches.get('001')?.__testing as {
      resolveJustDoManagedPipConfigFile: (env: Record<string, string>) => string | undefined;
      resolveJustDoManagedPythonUserBase: (
        env: Record<string, string>,
      ) => string | undefined;
    };
    expect(
      testing.resolveJustDoManagedPipConfigFile({
        PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
      }),
    ).toBe('C:\\managed\\pip.ini');
    expect(
      testing.resolveJustDoManagedPipConfigFile({
        PIP_CONFIG_FILE: 'C:\\attacker\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
      }),
    ).toBeUndefined();
    expect(
      testing.resolveJustDoManagedPythonUserBase({
        PYTHONUSERBASE: 'C:\\managed\\python',
        JUSTDO_MANAGED_PYTHON_USER_BASE: 'C:\\managed\\python',
      }),
    ).toBe('C:\\managed\\python');
  });

  test('rewrites only Windows npm and npx Chrome launchers', () => {
    const testing = patches.get('003')?.__testing as {
      resolveJustDoChromeMcpLaunch: (
        command: string,
        args: string[],
        platform: string,
        environment: Record<string, string>,
      ) => { command: string; args: string[]; env?: Record<string, string> };
    };
    const environment = {
      JUSTDO_NPM_BIN_DIR: 'C:\\runtime\\npm',
      JUSTDO_ELECTRON_PATH: 'C:\\app\\electron.exe',
      JUSTDO_WINDOWS_HIDE_PRELOAD: 'C:\\app\\hide-child-process-windows.cjs',
    };
    expect(
      testing.resolveJustDoChromeMcpLaunch('npx.cmd', ['chrome-devtools-mcp'], 'win32', environment),
    ).toMatchObject({
      command: 'C:\\app\\electron.exe',
      args: ['C:\\runtime\\npm\\npx-cli.js', 'chrome-devtools-mcp'],
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    });
    expect(
      testing.resolveJustDoChromeMcpLaunch('npx', ['chrome-devtools-mcp'], 'linux', environment),
    ).toEqual({ command: 'npx', args: ['chrome-devtools-mcp'], env: undefined });
  });

  test('keeps Gateway restarts but retires tasks from a prior JustDo app start', () => {
    const testing = patches.get('008')?.__testing as {
      readJustDoAppStartedAtMs: (value: unknown) => number | undefined;
      isPriorAppActiveTask: (
        task: { status?: string; createdAt?: unknown },
        startedAt: number | undefined,
      ) => boolean;
    };
    expect(testing.readJustDoAppStartedAtMs('200')).toBe(200);
    expect(testing.readJustDoAppStartedAtMs('invalid')).toBeUndefined();
    expect(testing.isPriorAppActiveTask({ status: 'running', createdAt: 100 }, 200)).toBe(true);
    expect(testing.isPriorAppActiveTask({ status: 'queued', createdAt: 200 }, 200)).toBe(false);
    expect(testing.isPriorAppActiveTask({ status: 'completed', createdAt: 100 }, 200)).toBe(
      false,
    );
  });

  test('manual no-cache reindex transform is idempotent and rejects ambiguity', () => {
    const testing = patches.get('009')?.__testing as {
      CACHE_SEED: string;
      FUNCTION_SIGNATURE: string;
      OPT_IN_ENV: string;
      transformMemoryManager: (content: string, filePath: string) => string;
    };
    const source = `class MemoryManager {\n  ${testing.FUNCTION_SIGNATURE}\n    ${testing.CACHE_SEED}\n  }\n}`;
    const transformed = testing.transformMemoryManager(source, 'memory.js');
    expect(transformed).toContain(`process.env.${testing.OPT_IN_ENV} !== "1"`);
    expect(testing.transformMemoryManager(transformed, 'memory.js')).toBe(transformed);
    expect(() =>
      testing.transformMemoryManager(`${source}\n${source}`, 'ambiguous-memory.js'),
    ).toThrow('ambiguous');
  });

  test.skipIf(!runtimeIsV2026_8_1)(
    'verifies source, worker, and esbuild bundle contracts idempotently',
    () => {
      for (const patch of patches.values()) {
        expect(patch.applyPatch(runtimeRoot)).toEqual([]);
        expect(() => patch.verifyPatch(runtimeRoot)).not.toThrow();
      }
    },
    60_000,
  );
});
