import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  APP_PLUGIN_ARTIFACT,
  type AppPluginArtifact,
  isAppArtifactPath,
  parseAppPluginManifest,
} from '../../../../packages/app-plugin-sdk/contracts';
import { type AppModuleGraphs,verifyAppModuleGraph } from './moduleGraph';

const digest = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export const artifactDigest = (
  manifest: AppPluginArtifact['manifest'],
  files: Record<string, string>,
): string =>
  digest(
    JSON.stringify({
      manifest: parseAppPluginManifest(manifest),
      files: Object.fromEntries(
        Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    }),
  );
export interface VerifiedAppArtifact {
  root: string;
  artifact: AppPluginArtifact;
  moduleGraphs?: AppModuleGraphs;
}

/** Verify an immutable, complete graph, not just its entry module. */
export const inspectAppArtifact = async (directory: string): Promise<VerifiedAppArtifact> => {
  const root = await realpath(directory);
  const indexPath = path.join(root, APP_PLUGIN_ARTIFACT);
  if ((await lstat(indexPath)).isSymbolicLink()) throw new Error('App artifact index is a link');
  const indexBytes = await readFile(indexPath);
  if (indexBytes.length > 1024 * 1024) throw new Error('App artifact index is too large');
  const input = JSON.parse(indexBytes.toString('utf8')) as AppPluginArtifact;
  const manifest = parseAppPluginManifest(input.manifest);
  if (
    !input.files ||
    Array.isArray(input.files) ||
    typeof input.files !== 'object' ||
    typeof input.hash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.hash)
  )
    throw new Error('Invalid app artifact');
  const files: Record<string, string> = {};
  let total = 0;
  const actual = new Set<string>();
  const sources = new Map<string, string>();
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink() || (await realpath(absolute)) !== absolute)
      throw new Error('App artifact contains a link');
    if (stats.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        if (!isAppArtifactPath(child)) throw new Error('Invalid app artifact path');
        await visit(child);
      }
    } else {
      if (relative === APP_PLUGIN_ARTIFACT) return;
      if (!stats.isFile() || stats.size > 64 * 1024 * 1024 || actual.size >= 4096)
        throw new Error('Invalid app artifact size');
      total += stats.size;
      if (total > 256 * 1024 * 1024) throw new Error('App artifact is too large');
      const bytes = await readFile(absolute);
      const expected = input.files[relative];
      if (typeof expected !== 'string' || digest(bytes) !== expected)
        throw new Error('App artifact changed');
      actual.add(relative);
      files[relative] = expected;
      if (/\.[cm]?js$/u.test(relative)) sources.set(relative, bytes.toString('utf8'));
    }
  };
  await visit('');
  const moduleGraphs = verifyAppModuleGraph(manifest, sources, actual);
  if (
    Object.keys(input.files).length !== actual.size ||
    !actual.has(manifest.entries.main) ||
    !actual.has(manifest.entries.browser) ||
    (manifest.entries.presentation !== undefined && !actual.has(manifest.entries.presentation)) ||
    artifactDigest(manifest, files) !== input.hash
  )
    throw new Error('App artifact identity mismatch');
  return { root, artifact: { manifest, files, hash: input.hash }, moduleGraphs };
};

/** Copy verified bytes away from the native install directory before loading any code. */
export const retainAppArtifact = async (
  source: VerifiedAppArtifact,
  directory: string,
): Promise<VerifiedAppArtifact> => {
  const destination = path.resolve(directory, source.artifact.manifest.id, source.artifact.hash);
  const relative = path.relative(path.resolve(directory), destination);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid app retention root');
  try {
    const existing = await inspectAppArtifact(destination);
    if (existing.artifact.hash !== source.artifact.hash)
      throw new Error('Retained app artifact mismatch');
    return existing;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }
  const staged = `${destination}.stage-${createHash('sha256').update(String(process.hrtime.bigint())).digest('hex').slice(0, 16)}`;
  await mkdir(staged, { recursive: true });
  try {
    for (const [name, expected] of Object.entries(source.artifact.files)) {
      const bytes = await readFile(path.join(source.root, name));
      if (digest(bytes) !== expected) throw new Error('App source changed during retention');
      await mkdir(path.dirname(path.join(staged, name)), { recursive: true });
      await writeFile(path.join(staged, name), bytes, { flag: 'wx' });
    }
    await writeFile(path.join(staged, APP_PLUGIN_ARTIFACT), JSON.stringify(source.artifact), {
      flag: 'wx',
    });
    await inspectAppArtifact(staged);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(staged, destination);
    return inspectAppArtifact(destination);
  } finally {
    // This generated sibling stays under the already checked retention root.
    await rm(staged, { recursive: true, force: true });
  }
};
