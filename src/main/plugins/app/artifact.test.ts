import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { artifactDigest, inspectAppArtifact, readAppArtifactIndex, retainAppArtifact } from './artifact';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    expect(path.basename(directory).startsWith('app-artifact-test-')).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'app-artifact-test-'));
  directories.push(directory);
  const root = path.join(directory, 'package');
  await mkdir(root);
  const manifest: AppPluginManifest = {
    manifestVersion: 1,
    apiVersion: 1,
    id: 'fixture',
    nativePluginId: 'fixture',
    version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' },
    commands: [],
    capabilities: [],
    slots: [],
  };
  const content = {
    'main.mjs': 'export const register = () => ({commands: []});',
    'browser.mjs': 'export const register = () => {};',
    'child.mjs': 'export const value = 1;',
  };
  const files = Object.fromEntries(
    Object.entries(content).map(([name, bytes]) => [
      name,
      createHash('sha256').update(bytes).digest('hex'),
    ]),
  );
  await Promise.all(
    Object.entries(content).map(([name, bytes]) => writeFile(path.join(root, name), bytes)),
  );
  const artifact = { manifest, files, hash: artifactDigest(manifest, files) };
  await writeFile(path.join(root, 'app.artifact.json'), JSON.stringify(artifact));
  return { directory, root, artifact };
};

describe('app artifact identity and retention', () => {
  it('retains a historical host-entry hash without executing it or exposing it to the browser graph', async () => {
    const { root, artifact } = await fixture();
    const entry = 'relocation.mjs';
    const bytes = "import fs from 'node:fs'; throw new Error('Must never execute during file inspection');";
    artifact.manifest.entries.relocation = entry;
    artifact.files[entry] = createHash('sha256').update(bytes).digest('hex');
    artifact.hash = artifactDigest(artifact.manifest, artifact.files);
    await writeFile(path.join(root, entry), bytes);
    await writeFile(path.join(root, 'app.artifact.json'), JSON.stringify(artifact));

    const inspected = await inspectAppArtifact(root);

    expect(inspected.artifact.hash).toBe(artifact.hash);
    expect(inspected.moduleGraphs?.browser.has(entry)).toBe(false);
  });
  it.each(['directory', 'linked-parent'] as const)('retains the complete graph independently of native uninstall: %s', async layout => {
    const { directory, root, artifact } = await fixture();
    const index = await readAppArtifactIndex(root);
    const retentionRoot = path.join(directory, 'retained');
    if (layout === 'linked-parent') {
      const target = path.join(directory, 'retained-target');
      await mkdir(target);
      await symlink(target, retentionRoot, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const retained = await retainAppArtifact(index, retentionRoot);
    await rm(root, { recursive: true, force: true });
    expect(retained.root).toBe(await realpath(retained.root));
    expect(retained.moduleGraphs?.browser.has(artifact.manifest.entries.browser)).toBe(true);
    expect(retained.moduleGraphs?.browser.has(artifact.manifest.entries.main)).toBe(false);
    expect((await inspectAppArtifact(retained.root)).artifact.hash).toBe(artifact.hash);
  });
  it('rejects changes to a child even when the root entry is unchanged', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'child.mjs'), 'export const value = 2;');
    await expect(inspectAppArtifact(root)).rejects.toThrow('changed');
  });
  it('rejects a correctly hashed module that loads unapproved external code', async () => {
    const { root, artifact } = await fixture();
    const bytes = "import '../../outside.mjs'; export const register = () => ({commands: []});";
    await writeFile(path.join(root, 'main.mjs'), bytes);
    artifact.files['main.mjs'] = createHash('sha256').update(bytes).digest('hex');
    artifact.hash = artifactDigest(artifact.manifest, artifact.files);
    await writeFile(path.join(root, 'app.artifact.json'), JSON.stringify(artifact));
    await expect(inspectAppArtifact(root)).rejects.toThrow('escaped');
  });
  it('rejects unindexed dependencies and undeclared missing files', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'unindexed.mjs'), 'export const value = 3;');
    await expect(inspectAppArtifact(root)).rejects.toThrow('changed');
  });
  it('binds app capability changes to a different artifact identity', async () => {
    const { artifact } = await fixture();
    expect(
      artifactDigest(
        { ...artifact.manifest, capabilities: ['storage.transaction'] },
        artifact.files,
      ),
    ).not.toBe(artifact.hash);
  });
});
