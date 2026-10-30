import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { bundleProductExtension } = require('../openclaw/sync-openclaw-runtime-resources.cjs');
const { assertNoRunningGateways } = require('./app-plugin-runtime-processes.cjs');
const { findRetiredAppPlugins, retireAppPlugins } = require('./retired-app-plugins.cjs');
const repo = path.resolve(import.meta.dirname, '../..');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Development prepares Native/Main/UI together, before any Gateway loads the package. */
export function prepareDevelopmentAppPlugins(options = {}) {
  const workspace = options.repoRoot ?? repo;
  const alias = options.runtimeRoot ?? path.join(workspace, 'vendor/openclaw-runtime/current');
  if (!existsSync(alias)) return { prepared: [] };
  const runtime = realpathSync(alias);
  const catalog = JSON.parse(
    readFileSync(path.join(workspace, 'build/app-plugins/catalog.json'), 'utf8'),
  );
  if (!Array.isArray(catalog)) throw new Error('Invalid app plugin catalog');
  const changes = [];
  for (const entry of catalog) {
    if (!/^[a-z][a-z0-9-]{0,95}$/u.test(entry.id) || !/^[a-f0-9]{64}$/u.test(entry.hash))
      throw new Error('Invalid app plugin catalog identity');
    const source = path.join(workspace, 'build/app-plugins/packages', entry.id, entry.hash);
    const binding = JSON.parse(readFileSync(path.join(source, 'app/native.binding.json'), 'utf8'));
    if (binding.entry !== 'index.js' || binding.sha256 !== sha(path.join(source, 'index.js')))
      throw new Error(`Invalid Native build for ${entry.id}`);
    const target = path.join(runtime, 'dist/extensions', entry.id);
    const current = path.join(target, 'index.js');
    const currentManifest = path.join(target, 'openclaw.plugin.json');
    const currentArtifact = path.join(target, 'app/app.artifact.json');
    if (
      existsSync(current) &&
      statSync(current).isFile() &&
      sha(current) === binding.sha256 &&
      existsSync(currentManifest) &&
      sha(currentManifest) === sha(path.join(source, 'openclaw.plugin.json')) &&
      existsSync(currentArtifact) &&
      sha(currentArtifact) === sha(path.join(source, 'app/app.artifact.json'))
    )
      continue;
    changes.push({ id: entry.id, target, nativeSha: binding.sha256 });
  }
  const retired = findRetiredAppPlugins(workspace, alias);
  if (changes.length || retired.length) {
    assertNoRunningGateways([alias, runtime], options.findRunningGateways);
    retireAppPlugins(workspace, alias, options);
    for (const { id, target, nativeSha } of changes) {
      bundleProductExtension(path.join(workspace, 'plugins/extensions', id), target);
      if (sha(path.join(target, 'index.js')) !== nativeSha)
        throw new Error(`Native plugin preparation did not converge: ${id}`);
    }
  }
  return {
    prepared: changes.map(item => item.id),
    ...(retired.length ? { removed: retired.map(item => item.id) } : {}),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(prepareDevelopmentAppPlugins()));
}
