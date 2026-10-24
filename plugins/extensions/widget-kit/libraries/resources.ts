import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFFLINE_LIBRARY_IDS, type OfflineLibraryId } from './schema';
import upstreamManifest from './upstreams.json';

export type OfflineLibraryResource = {
  id: OfflineLibraryId;
  path: string;
  file: string;
};

type ResourceIntegrity = { file: string; bytes: number; sha256: string };

const RESOURCE_FAILURE = 'Offline widget library resource unavailable';

function resourceDefinitions(): readonly Readonly<OfflineLibraryResource>[] {
  const upstreams = upstreamManifest as {
    schemaVersion: number;
    libraries: { id: string; version: string; resourcePath: string }[];
  };
  if (upstreams.schemaVersion !== 1 || upstreams.libraries.length !== OFFLINE_LIBRARY_IDS.length)
    throw new Error(RESOURCE_FAILURE);
  return Object.freeze(
    OFFLINE_LIBRARY_IDS.map(id => {
      const matches = upstreams.libraries.filter(library => library.id === id);
      const upstream = matches[0];
      if (matches.length !== 1 || !/^\d+\.\d+\.\d+$/.test(upstream.version))
        throw new Error(RESOURCE_FAILURE);
      const filename = `${id}-${upstream.version}.js`;
      const resourcePath = `/__widget_kit__/libraries/${filename}`;
      if (upstream.resourcePath !== resourcePath) throw new Error(RESOURCE_FAILURE);
      return Object.freeze({ id, path: resourcePath, file: `libraries/${filename}` });
    }),
  );
}

/** Only these versioned paths can be served; the preparation verifier owns artifact hashes. */
export const OFFLINE_LIBRARY_RESOURCES = resourceDefinitions();

export function createOfflineLibraryResourceReader(assetRoot: URL) {
  const assetsDirectory = fileURLToPath(assetRoot);
  const resources = new Map(OFFLINE_LIBRARY_RESOURCES.map(resource => [resource.path, resource]));
  let pendingIntegrity: Promise<ReadonlyMap<string, Readonly<ResourceIntegrity>>> | undefined;
  const loadIntegrity = async () => {
    const manifest = JSON.parse(await readFile(new URL('./integrity.json', assetRoot), 'utf8')) as {
      schemaVersion: number;
      resources: Record<string, ResourceIntegrity>;
    };
    if (
      manifest.schemaVersion !== 1 ||
      !manifest.resources ||
      Object.keys(manifest.resources).length !== resources.size
    )
      throw new Error(RESOURCE_FAILURE);
    return new Map(
      OFFLINE_LIBRARY_RESOURCES.map(resource => {
        const record = manifest.resources[resource.path];
        if (
          !record ||
          record.file !== resource.file ||
          !Number.isSafeInteger(record.bytes) ||
          record.bytes < 1 ||
          record.bytes > 64 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(record.sha256)
        )
          throw new Error(RESOURCE_FAILURE);
        return [resource.path, Object.freeze({ ...record })] as const;
      }),
    );
  };
  return async (resourcePath: string) => {
    const resource = resources.get(resourcePath);
    if (!resource) return undefined;
    try {
      pendingIntegrity ??= loadIntegrity();
      const [integrity, directory, filename] = await Promise.all([
        pendingIntegrity,
        realpath(assetsDirectory),
        realpath(path.join(assetsDirectory, resource.file)),
      ]);
      const relative = path.relative(directory, filename);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error(RESOURCE_FAILURE);
      const body = await readFile(filename);
      const expected = integrity.get(resourcePath)!;
      if (
        body.byteLength !== expected.bytes ||
        createHash('sha256').update(body).digest('hex') !== expected.sha256
      )
        throw new Error(RESOURCE_FAILURE);
      return { body, contentType: 'text/javascript; charset=utf-8' };
    } catch {
      throw new Error(RESOURCE_FAILURE);
    }
  };
}
