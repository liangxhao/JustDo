import path from 'node:path';

import { browserProfileFromPartition } from '../../shared/browser/browser';

export const BROWSER_CACHE_DIRECTORIES: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
]);

export function isManagedBrowserPartitionDirectory(name: string): boolean {
  return browserProfileFromPartition(`persist:${name}`) !== null;
}

export function isBrowserCacheRelativePath(relativePath: string): boolean {
  const [root, partition, directory] = relativePath.split(path.sep);
  return BROWSER_CACHE_DIRECTORIES.has(root) ||
    (root === 'Partitions' && isManagedBrowserPartitionDirectory(partition ?? '') &&
      BROWSER_CACHE_DIRECTORIES.has(directory));
}
