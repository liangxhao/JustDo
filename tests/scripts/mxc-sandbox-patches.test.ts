import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const pluginPatch = require('../../scripts/openclaw/patch-mxc-sandbox-plugin.cjs') as {
  MARKER: string;
  HOST_PREP_MARKER: string;
  HOST_PROBE_MARKER: string;
  transformMxcPlugin: (content: string, filePath?: string) => string;
  verifyMxcSandboxPlugin: (directory: string) => void;
  __testing: {
    HOST_PREP_ORIGINAL: string;
    HOST_PREP_REPLACEMENT: string;
    ORIGINAL: string;
    REPLACEMENT: string;
    LIFECYCLE_ORIGINAL: string;
    LIFECYCLE_REPLACEMENT: string;
    FILESYSTEM_ORIGINAL: string;
    HOST_PROBE_ORIGINAL: string;
    HOST_PROBE_REPLACEMENT: string;
    HOST_PROBE_CALL_ORIGINAL: string;
    HOST_PROBE_REGISTRATION_ORIGINAL: string;
  };
};
const pristineHostReadiness = () =>
  [
    pluginPatch.__testing.HOST_PROBE_ORIGINAL,
    pluginPatch.__testing.HOST_PROBE_CALL_ORIGINAL,
    pluginPatch.__testing.HOST_PROBE_REGISTRATION_ORIGINAL,
  ].join('\n');
const runtimePatch =
  require('../../scripts/patches/v2026.9.8/025-mxc-external-skill-paths.cjs') as {
    __testing: {
      MARKER: string;
      transformSkillRuntimePaths: (content: string, filePath: string) => string;
    };
  };

describe('MXC sandbox version-locked patches', () => {
  it('blocks packaging when native policy cleanup is missing or corrupted', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mxc-patch-'));
    try {
      fs.mkdirSync(path.join(directory, 'dist'));
      fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({ version: '2026.9.8' }),
      );
      const pristine = [
        pluginPatch.__testing.ORIGINAL,
        pluginPatch.__testing.HOST_PREP_ORIGINAL,
        pluginPatch.__testing.LIFECYCLE_ORIGINAL,
        pluginPatch.__testing.FILESYSTEM_ORIGINAL,
        pristineHostReadiness(),
      ].join('\n');
      const current = pluginPatch.transformMxcPlugin(pristine);
      const entry = path.join(directory, 'dist', 'index.js');
      fs.writeFileSync(entry, current);
      expect(() => pluginPatch.verifyMxcSandboxPlugin(directory)).not.toThrow();
      for (const invalid of [
        current.replace(
          pluginPatch.__testing.LIFECYCLE_REPLACEMENT,
          pluginPatch.__testing.LIFECYCLE_ORIGINAL,
        ),
        current + '\nclearPolicyOnExit: true',
        current.replace('preservePolicy: false', 'preservePolicy: true'),
        current.replace(
          pluginPatch.__testing.HOST_PROBE_REPLACEMENT,
          pluginPatch.__testing.HOST_PROBE_ORIGINAL,
        ),
        current.replace(
          'assertMxcReadiness({ mxcBinaryPath: config.mxcBinaryPath });',
          'assertMxcReadiness();',
        ),
      ]) {
        fs.writeFileSync(entry, invalid);
        expect(() => pluginPatch.verifyMxcSandboxPlugin(directory)).toThrow(
          /rebuild from pristine/,
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('projects only the external materialized skill copy into ProcessContainer', () => {
    const original = Object.entries(pluginPatch.__testing)
      .filter(([key]) => key === 'ORIGINAL' || key.endsWith('_ORIGINAL'))
      .map(([, value]) => value)
      .join('\n');
    const updated = pluginPatch.transformMxcPlugin(original, 'dist/index.js');

    expect(updated).toContain(pluginPatch.MARKER);
    expect(updated).toContain(pluginPatch.HOST_PREP_MARKER);
    expect(updated).toContain(pluginPatch.HOST_PROBE_MARKER);
    expect(updated).toContain('output.includes("S-1-15-3-")');
    expect(updated).toContain('containerPath: materializedSkillsPath');
    expect(updated).not.toContain('containerJoin(params.workdir, "skills")');
    expect(pluginPatch.transformMxcPlugin(updated, 'dist/index.js')).toBe(updated);
  });

  it('emits native lifecycle cleanup without leaking the SDK policy field', () => {
    const fixture = `${pluginPatch.__testing.ORIGINAL}\n${pluginPatch.__testing.HOST_PREP_ORIGINAL}\n${pristineHostReadiness()}\n`;
    const config = `return { lifecycle: { destroyOnExit: true }, filesystem: {
\t\treadonlyPaths: ['C:/skills'],
\t\tdeniedPaths: [],
\t\treadwritePaths,
\t\tclearPolicyOnExit: true
    } };`;
    const updated = pluginPatch.transformMxcPlugin(fixture + config);
    const buildConfig = new Function(
      'readwritePaths',
      updated.slice(updated.indexOf('return { lifecycle:')),
    );
    const result = buildConfig(['C:/workspace']);

    expect(result.lifecycle).toEqual({ destroyOnExit: true, preservePolicy: false });
    expect(result.filesystem).toEqual({
      readonlyPaths: ['C:/skills'],
      deniedPaths: [],
      readwritePaths: ['C:/workspace'],
    });
    expect(updated).not.toContain('clearPolicyOnExit');
    expect(pluginPatch.transformMxcPlugin(updated)).toBe(updated);
  });

  it('rejects historical, partial and ambiguous plugin patches instead of upgrading them', () => {
    const pristine = [
      pluginPatch.__testing.ORIGINAL,
      pluginPatch.__testing.HOST_PREP_ORIGINAL,
      pluginPatch.__testing.LIFECYCLE_ORIGINAL,
      pluginPatch.__testing.FILESYSTEM_ORIGINAL,
      pristineHostReadiness(),
    ].join('\n');
    const historical = pristine
      .replace(pluginPatch.__testing.ORIGINAL, pluginPatch.__testing.REPLACEMENT)
      .replace(
        pluginPatch.__testing.HOST_PREP_ORIGINAL,
        pluginPatch.__testing.HOST_PREP_REPLACEMENT,
      );
    expect(() => pluginPatch.transformMxcPlugin(historical)).toThrow(/rebuild from pristine/);
    const previousRevision = pluginPatch
      .transformMxcPlugin(pristine)
      .replace(
        pluginPatch.__testing.HOST_PROBE_REPLACEMENT,
        pluginPatch.__testing.HOST_PROBE_ORIGINAL,
      );
    expect(() => pluginPatch.transformMxcPlugin(previousRevision)).toThrow(/rebuild from pristine/);
    const current = pluginPatch.transformMxcPlugin(pristine);
    expect(() =>
      pluginPatch.transformMxcPlugin(
        current.replace('preservePolicy: false', 'preservePolicy: true'),
      ),
    ).toThrow(/rebuild from pristine/);
    expect(() =>
      pluginPatch.transformMxcPlugin(
        pristine.replace(pluginPatch.__testing.FILESYSTEM_ORIGINAL, ''),
      ),
    ).toThrow(/expected one MXC native policy anchor/);
    expect(() =>
      pluginPatch.transformMxcPlugin(pristine + pluginPatch.__testing.LIFECYCLE_ORIGINAL),
    ).toThrow(/expected one MXC native policy anchor/);
  });

  it('probes the configured executor and retains native tier warnings without querying services', () => {
    const binaryPath = 'C:\\Custom MXC\\wxc-exec.exe';
    const resolveBinary = vi.fn((override?: string) => override ?? 'bundled-executor.exe');
    const execFileSync = vi.fn(() =>
      JSON.stringify({
        tier: 'appcontainer-bfs',
        warnings: ['Native tier warning', 123],
      }),
    );
    const warn = vi.fn();
    const assertReadiness = new Function(
      'resolveMxcBinaryPath',
      `${pluginPatch.__testing.HOST_PROBE_REPLACEMENT}\nreturn assertMxcExecutorHostReady;`,
    )(resolveBinary);

    assertReadiness({ mxcBinaryPath: binaryPath, warn }, { execFileSync });

    expect(resolveBinary).toHaveBeenCalledWith(binaryPath);
    expect(execFileSync).toHaveBeenCalledWith(
      binaryPath,
      ['--probe'],
      expect.objectContaining({
        timeout: 5_000,
        windowsHide: true,
        stdio: 'pipe',
      }),
    );
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith('[mxc] Native tier warning');
  });

  it.each(['invalid JSON', 'null', '{}', '{"tier":"isolation_session"}'])(
    'fails plugin readiness for an invalid native probe: %s',
    output => {
      const assertReadiness = new Function(
        'resolveMxcBinaryPath',
        `${pluginPatch.__testing.HOST_PROBE_REPLACEMENT}\nreturn assertMxcExecutorHostReady;`,
      )(() => 'bundled-executor.exe');

      expect(() => assertReadiness({}, { execFileSync: () => output })).toThrow(
        /host probe failed/,
      );
    },
  );

  it('preserves native probe launch failures instead of activating the backend', () => {
    const assertReadiness = new Function(
      'resolveMxcBinaryPath',
      `${pluginPatch.__testing.HOST_PROBE_REPLACEMENT}\nreturn assertMxcExecutorHostReady;`,
    )(() => 'bundled-executor.exe');

    expect(() =>
      assertReadiness(
        {},
        {
          execFileSync: () => {
            throw new Error('native timeout');
          },
        },
      ),
    ).toThrow(/host probe failed: native timeout/);
  });

  it('selects the canonical external skill path only for the mxc backend', () => {
    const original =
      'const skillsPromptWorkspaceDir = params.sandbox.workspaceAccess === "rw" && params.sandbox.skillsWorkspaceDir && params.sandbox.containerWorkdir ? containerJoin(params.sandbox.containerWorkdir, ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS) : params.sandbox.containerWorkdir ?? skillsWorkspaceDir;';
    const updated = runtimePatch.__testing.transformSkillRuntimePaths(original, 'runtime.js');

    expect(updated).toContain('params.sandbox.backendId === "mxc"');
    expect(updated).toContain('params.sandbox.skillsWorkspaceDir.replace(/\\\\/g, "/")');
    expect(updated).toContain(runtimePatch.__testing.MARKER);
    expect(updated).toContain('params.sandbox.workspaceAccess === "rw"');
    expect(runtimePatch.__testing.transformSkillRuntimePaths(updated, 'runtime.js')).toBe(updated);

    const resolvePromptPath = new Function(
      'params',
      'skillsWorkspaceDir',
      'containerJoin',
      'MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS',
      `${updated} return skillsPromptWorkspaceDir;`,
    ) as (...args: unknown[]) => string;
    expect(
      resolvePromptPath(
        {
          sandbox: {
            backendId: 'mxc',
            skillsWorkspaceDir: 'C:\\Users\\tester\\skills-runtime',
          },
        },
        '',
        () => '',
        [],
      ),
    ).toBe('C:/Users/tester/skills-runtime');
  });

  it('restores the verification marker stripped by esbuild without changing behavior', () => {
    const bundled =
      'const skillsPromptWorkspaceDir = params.sandbox.backendId === "mxc" && params.sandbox.skillsWorkspaceDir ? params.sandbox.skillsWorkspaceDir.replace(/\\\\/g, "/") : params.sandbox.workspaceAccess === "rw" && params.sandbox.skillsWorkspaceDir && params.sandbox.containerWorkdir ? containerJoin2(params.sandbox.containerWorkdir, ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS) : params.sandbox.containerWorkdir ?? skillsWorkspaceDir;';
    const updated = runtimePatch.__testing.transformSkillRuntimePaths(
      bundled,
      'gateway-bundle.mjs',
    );

    expect(updated).toContain(runtimePatch.__testing.MARKER);
    expect(updated.replace(` /*${runtimePatch.__testing.MARKER}*/`, '')).toBe(bundled);
  });

  it('rejects marker-only or malformed runtime patch shapes', () => {
    const original =
      'const skillsPromptWorkspaceDir = params.sandbox.workspaceAccess === "rw" && params.sandbox.skillsWorkspaceDir && params.sandbox.containerWorkdir ? containerJoin(params.sandbox.containerWorkdir, ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS) : params.sandbox.containerWorkdir ?? skillsWorkspaceDir;';

    expect(() =>
      runtimePatch.__testing.transformSkillRuntimePaths(
        `${original} /*${runtimePatch.__testing.MARKER}*/`,
        'runtime.js',
      ),
    ).toThrow(/partial MXC external skill runtime path patch/);

    const valid = runtimePatch.__testing.transformSkillRuntimePaths(original, 'runtime.js');
    expect(() =>
      runtimePatch.__testing.transformSkillRuntimePaths(
        valid.replace('.replace(/\\\\/g, "/")', ''),
        'runtime.js',
      ),
    ).toThrow(/partial MXC external skill runtime path patch/);
  });
});
