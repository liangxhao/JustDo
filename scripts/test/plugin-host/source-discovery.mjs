import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isAppIdentifier, parseAppPluginManifest } from '../../../plugins/sdk/app-plugin-sdk/contracts.ts';

/** Empty optional inventories are valid; missing source roots and broken declared packages fail. */
export async function discoverAppPluginSources(sourceRoot =
  process.env.APP_PLUGIN_PROBE_SOURCE_ROOT ?? path.resolve('plugins/extensions')) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const result = [];
  const ids = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.resolve(sourceRoot, entry.name);
    let contents;
    try {
      contents = await readFile(path.join(directory, 'app.plugin.json'), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        let pkg;
        try {
          pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        } catch (packageError) {
          if (packageError?.code === 'ENOENT') continue;
          throw packageError;
        }
        if (pkg?.app !== undefined)
          throw new Error(`Declared app plugin manifest is missing: ${entry.name}`);
        continue;
      }
      throw error;
    }
    const manifest = parseAppPluginManifest(JSON.parse(contents));
    if (ids.has(manifest.id) || manifest.id !== entry.name)
      throw new Error(`Invalid or duplicate app plugin source identity: ${entry.name}`);
    ids.add(manifest.id);
    result.push({ id: manifest.id, directory, manifest });
  }
  const requested = process.env.APP_PLUGIN_PROBE_IDS?.split(',').map(id => id.trim()).filter(Boolean);
  if (!requested?.length) return result;
  if (requested.some(id => !isAppIdentifier(id) || !ids.has(id)))
    throw new Error('An explicitly selected probe plugin is missing or invalid.');
  return result.filter(source => requested.includes(source.id));
}
