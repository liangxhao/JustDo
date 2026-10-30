import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { parseAppPluginManifest } from '@app-plugin/sdk/contracts';

const ownRequire = createRequire(import.meta.url);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
};
const canonical = file => (existsSync(file) ? realpathSync(file) : path.resolve(file));

export function sourceEntry(source, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name))
    throw new Error('App build entry must be a relative package path');
  const file = path.resolve(source, name);
  if (!inside(source, file)) throw new Error('App build entry escaped package');
  return file;
}

export async function readAppPluginSource(source) {
  source = path.resolve(source);
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const manifest = parseAppPluginManifest(
    JSON.parse(await readFile(path.join(source, 'app.plugin.json'), 'utf8')),
  );
  const nativeManifest = JSON.parse(
    await readFile(path.join(source, 'openclaw.plugin.json'), 'utf8'),
  );
  if (!pkg.app || manifest.nativePluginId !== manifest.id || pkg.version !== manifest.version)
    throw new Error('Invalid app build declaration');
  if (nativeManifest.id !== manifest.nativePluginId)
    throw new Error('App and native plugin identities must match');
  if (!Array.isArray(pkg.openclaw?.extensions) || pkg.openclaw.extensions.length !== 1)
    throw new Error('App package must have one native entry');
  for (const entry of [pkg.openclaw.extensions[0], pkg.app.main, pkg.app.browser])
    sourceEntry(source, entry);
  if (Boolean(pkg.app.presentation) !== Boolean(manifest.entries.presentation))
    throw new Error('App history presentation build declaration mismatch');
  if (pkg.app.presentation) sourceEntry(source, pkg.app.presentation);
  return { source, pkg, manifest };
}

/** A declared but broken companion is an error; an existing empty inventory is valid. */
export async function discoverAppPluginSources(sourceRoot) {
  const result = [];
  const ids = new Set();
  for (const entry of (await readdir(sourceRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceRoot, entry.name);
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let hasManifest = true;
    try {
      await readFile(path.join(source, 'app.plugin.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hasManifest = false;
    }
    if (!hasManifest && pkg?.app === undefined) continue;
    const value = await readAppPluginSource(source);
    if (value.manifest.id !== entry.name || ids.has(value.manifest.id))
      throw new Error('Invalid or duplicate app plugin source identity: ' + entry.name);
    ids.add(value.manifest.id);
    result.push(value);
  }
  return result;
}

function packageRoot(file, name) {
  let directory = path.dirname(file);
  for (;;) {
    const metadata = path.join(directory, 'package.json');
    if (existsSync(metadata)) {
      const value = JSON.parse(readFileSync(metadata, 'utf8'));
      if (value.name === name && typeof value.version === 'string') return canonical(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Resolved dependency escaped its package: ' + name);
    directory = parent;
  }
}

/** Resolve installed exports, including workspace packages, without any source aliases. */
export function sourceBoundary(source, pkg, options = {}) {
  const root = canonical(source);
  const require = createRequire(path.join(source, 'package.json'));
  const allowed = new Set([root]);
  const forbidden = (options.forbiddenSourceRoots ?? []).map(canonical);
  const declared = new Set(
    Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }),
  );
  const recursion = {};
  return {
    name: 'app-plugin-source-boundary',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === recursion || (args.namespace && args.namespace !== 'file')) return;
        if (/^@\/|^@shared\//u.test(args.path))
          throw new Error('App plugin cannot import application source: ' + args.path);
        if (isBuiltin(args.path)) return;
        const bare = !path.isAbsolute(args.path) && !args.path.startsWith('.');
        const name = bare
          ? args.path
              .split('/')
              .slice(0, args.path.startsWith('@') ? 2 : 1)
              .join('/')
          : undefined;
        const fromSource = !args.importer || inside(root, canonical(args.importer));
        if (
          bare &&
          fromSource &&
          name !== '@app-plugin/sdk' &&
          name !== 'openclaw' &&
          !declared.has(name)
        )
          throw new Error('App plugin dependency is not declared: ' + name);
        let specifier = args.path;
        if (name === '@app-plugin/sdk') {
          try {
            specifier = require.resolve(args.path);
          } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            specifier = ownRequire.resolve(args.path);
          }
        }
        const resolved = await builder.resolve(specifier, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: recursion,
        });
        if (
          resolved.errors.length ||
          resolved.external ||
          !resolved.path ||
          resolved.namespace !== 'file'
        )
          return { ...resolved, pluginData: undefined };
        const file = canonical(resolved.path);
        if (forbidden.some(directory => inside(directory, file)))
          throw new Error('App plugin imported application source: ' + file);
        if (name) {
          const directory = packageRoot(file, name);
          allowed.add(directory);
          options.onDependencyRoot?.(directory);
        }
        if (![...allowed].some(directory => inside(directory, file)))
          throw new Error(
            'App plugin imported source outside its package or installed dependencies: ' + file,
          );
        return { ...resolved, pluginData: undefined };
      });
    },
  };
}
