import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { VerifiedAppArtifact } from './artifact';

const routes = new Map<string, { artifact: VerifiedAppArtifact; file: string }>();
export const appAssetPath = (hash: string, epoch: string, file: string): string =>
  `assets/app-plugins/${hash}/${epoch}/${file}`;
export const appPresentationAssetPath = (hash: string, file: string): string =>
  appAssetPath(hash, 'presentation', file);

/** Only an admitted immutable browser graph is published; installation roots are never HTTP roots. */
export const publishAppAssets = (
  artifact: VerifiedAppArtifact,
  epoch: string,
  kind: 'browser' | 'presentation' = 'browser',
): (() => void) => {
  const resources: { route: string; resource: { artifact: VerifiedAppArtifact; file: string } }[] =
    [];
  const graph =
    artifact.moduleGraphs?.[kind] ??
    new Set([
      kind === 'browser'
        ? artifact.artifact.manifest.entries.browser
        : artifact.artifact.manifest.entries.presentation,
    ]);
  for (const file of Object.keys(artifact.artifact.files)) {
    // Keep the privilege boundary even if a caller supplies an incomplete graph.
    if (file === artifact.artifact.manifest.entries.main) continue;
    if (!graph.has(file) && (kind === 'presentation' || !/\.(?:css|png|svg|woff2?)$/u.test(file)))
      continue;
    const route = appAssetPath(artifact.artifact.hash, epoch, file);
    const resource = { artifact, file };
    routes.set(route, resource);
    resources.push({ route, resource });
  }
  return () =>
    resources.forEach(({ route, resource }) => {
      if (routes.get(route) === resource) routes.delete(route);
    });
};

export const readAppAsset = async (route: string): Promise<Buffer | null> => {
  const resource = routes.get(route);
  if (!resource) return null;
  try {
    const absolute = path.join(resource.artifact.root, resource.file);
    if (
      (await realpath(resource.artifact.root)) !== resource.artifact.root ||
      (await realpath(absolute)) !== absolute ||
      (await lstat(absolute)).isSymbolicLink()
    )
      return null;
    const bytes = await readFile(absolute);
    if (
      routes.get(route) !== resource ||
      createHash('sha256').update(bytes).digest('hex') !==
        resource.artifact.artifact.files[resource.file]
    )
      return null;
    return bytes;
  } catch {
    return null;
  }
};
