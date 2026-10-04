import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';
const patch = require('../../../../scripts/patches/v2026.9.8/025-mxc-external-skill-paths.cjs');
test('verifies exact source and comment-stripped bundle MXC skill paths, rejecting old or partial patches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mxc-path-verifier-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    const original =
      'function resolveSandboxSkillRuntimeInputs(params) { const skillsPromptWorkspaceDir = params.sandbox.workspaceAccess === "rw" && params.sandbox.skillsWorkspaceDir && params.sandbox.containerWorkdir ? containerJoin(params.sandbox.containerWorkdir, ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS) : params.sandbox.containerWorkdir ?? skillsWorkspaceDir; }';
    for (const name of ['a.mjs', 'b.mjs'])
      fs.writeFileSync(path.join(root, 'dist', name), original);
    patch.applyPatch(root);
    const current = fs.readFileSync(path.join(root, 'dist/a.mjs'), 'utf8');
    const bundled = current
      .replace('/*' + patch.__testing.MARKER + '*/ ', '')
      .replace('containerJoin(', 'containerJoin2(');
    const bundleFile = path.join(root, 'gateway-bundle.mjs');
    fs.writeFileSync(bundleFile, bundled);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    fs.writeFileSync(bundleFile, current.replaceAll('V2026_9_8', 'V2026_9_6'));
    expect(() => patch.verifyPatch(root)).toThrow();
    fs.writeFileSync(bundleFile, bundled.replace('backendId === "mxc"', 'backendId === "docker"'));
    expect(() => patch.verifyPatch(root)).toThrow();
    fs.writeFileSync(bundleFile, bundled);
    fs.writeFileSync(path.join(root, 'dist/a.mjs'), bundled);
    expect(() => patch.verifyPatch(root)).toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
