import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type AppPluginManifest } from '../../../../packages/app-plugin-sdk/contracts';
import { artifactDigest, inspectAppArtifact, retainAppArtifact } from './artifact';

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
  it('retains the complete graph independently of native uninstall', async () => {
    const { directory, root, artifact } = await fixture();
    const verified = await inspectAppArtifact(root);
    const retained = await retainAppArtifact(verified, path.join(directory, 'retained'));
    await rm(root, { recursive: true, force: true });
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
