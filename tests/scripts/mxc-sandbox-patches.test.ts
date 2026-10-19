import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const pluginPatch = require('../../scripts/openclaw/patch-mxc-sandbox-plugin.cjs');
const runtimePatch = require('../../scripts/patches/v2026.10.4/013-mxc-external-skill-paths.cjs');
const nativeContracts = [
  'assertMxcReadiness({ executablePath: mxcBinaryPath });',
  'probeMxcIsolationTier(params.executablePath)',
  'MxcProbeOutputSchema.safeParse(probe)',
  'lifecycle: { destroyOnExit: true, preservePolicy: false }',
].join('\n');
const pristine = () => [pluginPatch.__testing.ORIGINAL, pluginPatch.__testing.HOST_PREP_ORIGINAL, nativeContracts].join('\n');

it.each(['x64', 'arm64'])('omits Linux executors from the Windows %s SDK while retaining native assets', arch => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-target-'));
  const sdk = path.join(root, 'node_modules/@microsoft/mxc-sdk');
  try {
    for (const name of ['x64', 'arm64']) {
      const bin = path.join(sdk, 'bin', name);
      fs.mkdirSync(bin, { recursive: true });
      for (const file of ['wxc-exec.exe', 'lxc-exec', 'wslcsdk.dll']) fs.writeFileSync(path.join(bin, file), file);
      fs.mkdirSync(path.join(sdk, 'node_modules/node-pty/prebuilds', 'win32-' + name), { recursive: true });
    }
    pluginPatch.pruneMxcSandboxPluginForTarget(root, 'win-' + arch);
    expect(fs.readdirSync(path.join(sdk, 'bin'))).toEqual([arch]);
    expect(fs.readdirSync(path.join(sdk, 'bin', arch)).sort()).toEqual(['wslcsdk.dll', 'wxc-exec.exe']);
    expect(fs.readdirSync(path.join(sdk, 'node_modules/node-pty/prebuilds'))).toEqual(['win32-' + arch]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
describe('MXC 10.4 native readiness and retained integration', () => {
  it('keeps native executor probing and policy cleanup while projecting external skills', () => {
    const source = pristine();
    const current = pluginPatch.transformMxcPlugin(source);
    expect(current).toContain(nativeContracts);
    expect(current).toContain('containerPath: materializedSkillsPath');
    expect(current).toContain('output.includes("S-1-15-3-")');
    expect(current).not.toContain('containerJoin(params.workdir, "skills")');
    expect(pluginPatch.transformMxcPlugin(current)).toBe(current);
  });
  it.each([
    (s: string) => s.replace('preservePolicy: false', 'preservePolicy: true'),
    (s: string) => s.replace('destroyOnExit: true', 'destroyOnExit: false'),
    (s: string) => s.replace('assertMxcReadiness({ executablePath: mxcBinaryPath });', 'assertMxcReadiness();'),
    (s: string) => s.replace('MxcProbeOutputSchema.safeParse(probe)', 'probe'),
    (s: string) => s + '\nclearPolicyOnExit: true',
    (s: string) => s + '\nJUSTDO_MXC_EXECUTOR_HOST_PROBE_V2026_9_8',
  ])('refuses native contract drift or historical build shapes', mutate => {
    expect(() => pluginPatch.transformMxcPlugin(mutate(pristine()))).toThrow();
  });
  it('rejects incomplete and ambiguous retained seams before packaging', () => {
    const source = pristine();
    const current = pluginPatch.transformMxcPlugin(source);
    for (const invalid of [
      current.replace(pluginPatch.__testing.HOST_PREP_REPLACEMENT, pluginPatch.__testing.HOST_PREP_ORIGINAL),
      current.replace('containerPath: materializedSkillsPath', 'containerPath: "other"'),
      source + '\n' + pluginPatch.__testing.ORIGINAL,
    ]) expect(() => pluginPatch.transformMxcPlugin(invalid)).toThrow();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-patch-'));
    try {
      fs.mkdirSync(path.join(directory, 'dist'));
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2026.10.4' }));
      const entry = path.join(directory, 'dist/index.js');
      fs.writeFileSync(entry, current);
      expect(() => pluginPatch.verifyMxcSandboxPlugin(directory)).not.toThrow();
      fs.writeFileSync(entry, source);
      expect(() => pluginPatch.verifyMxcSandboxPlugin(directory)).toThrow(/missing/);
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2026.9.8' }));
      expect(() => pluginPatch.verifyMxcSandboxPlugin(directory)).toThrow(/supports/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
