import { describe, expect, it } from 'vitest';

const pluginPatch = require('../../scripts/patch-mxc-sandbox-plugin.cjs') as {
  MARKER: string;
  HOST_PREP_MARKER: string;
  transformMxcPlugin: (content: string, filePath?: string) => string;
  __testing: {
    HOST_PREP_ORIGINAL: string;
    HOST_PREP_REPLACEMENT: string;
    ORIGINAL: string;
    REPLACEMENT: string;
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
  it('projects only the external materialized skill copy into ProcessContainer', () => {
    const original = `prefix\n${pluginPatch.__testing.ORIGINAL}\n${pluginPatch.__testing.HOST_PREP_ORIGINAL}\nsuffix`;
    const updated = pluginPatch.transformMxcPlugin(original, 'dist/index.js');

    expect(updated).toContain(pluginPatch.MARKER);
    expect(updated).toContain(pluginPatch.HOST_PREP_MARKER);
    expect(updated).toContain('output.includes("S-1-15-3-")');
    expect(updated).toContain('containerPath: materializedSkillsPath');
    expect(updated).not.toContain('containerJoin(params.workdir, "skills")');
    expect(pluginPatch.transformMxcPlugin(updated, 'dist/index.js')).toBe(updated);
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
