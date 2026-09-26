import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pluginPatch = require('../../scripts/openclaw/patch-mxc-sandbox-plugin.cjs') as {
  MARKER: string;
  HOST_PREP_MARKER: string;
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
  };
};
const runtimePatch =
  require('../../scripts/patches/v2026.9.6/025-mxc-external-skill-paths.cjs') as {
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
        JSON.stringify({ version: '2026.9.6' }),
      );
      const pristine = [
        pluginPatch.__testing.ORIGINAL,
        pluginPatch.__testing.HOST_PREP_ORIGINAL,
        pluginPatch.__testing.LIFECYCLE_ORIGINAL,
        pluginPatch.__testing.FILESYSTEM_ORIGINAL,
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
    expect(updated).toContain('output.includes("S-1-15-3-")');
    expect(updated).toContain('containerPath: materializedSkillsPath');
    expect(updated).not.toContain('containerJoin(params.workdir, "skills")');
    expect(pluginPatch.transformMxcPlugin(updated, 'dist/index.js')).toBe(updated);
  });

  it('emits native lifecycle cleanup without leaking the SDK policy field', () => {
    const fixture = `${pluginPatch.__testing.ORIGINAL}\n${pluginPatch.__testing.HOST_PREP_ORIGINAL}\n`;
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
    ].join('\n');
    const historical = pristine
      .replace(pluginPatch.__testing.ORIGINAL, pluginPatch.__testing.REPLACEMENT)
      .replace(
        pluginPatch.__testing.HOST_PREP_ORIGINAL,
        pluginPatch.__testing.HOST_PREP_REPLACEMENT,
      );
    expect(() => pluginPatch.transformMxcPlugin(historical)).toThrow(/rebuild from pristine/);
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
