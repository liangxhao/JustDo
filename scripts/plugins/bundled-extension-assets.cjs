'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceTree = path.join('plugins', 'extensions');

function resourcePath(value) {
  if (
    typeof value !== 'string' ||
    !value.split('/').every(part => /^[a-zA-Z0-9._-]+$/.test(part) && part !== '.' && part !== '..')
  ) {
    throw new Error('Bundled extension asset paths must be relative and use literal path segments');
  }
  return value;
}

function listBundledExtensionAssets(repoRoot) {
  const extensions = path.join(repoRoot, sourceTree);
  if (!fs.existsSync(extensions)) return [];
  const bundles = [];
  const entries = fs
    .readdirSync(extensions, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourceRoot = path.join(extensions, entry.name);
    const packageFile = path.join(sourceRoot, 'package.json');
    if (!fs.existsSync(packageFile)) continue;
    const { bundledAssets } = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (bundledAssets === undefined) continue;
    if (!bundledAssets || !Array.isArray(bundledAssets.inputs)) {
      throw new Error(`Invalid bundledAssets declaration in ${packageFile}`);
    }
    const directory = resourcePath(bundledAssets.directory);
    const script = resourcePath(bundledAssets.prepare);
    const prepare = path.resolve(sourceRoot, script);
    if (
      !script.endsWith('.cjs') ||
      fs.realpathSync(prepare) !== path.resolve(fs.realpathSync(sourceRoot), script)
    ) {
      throw new Error(
        `Bundled extension asset builder must resolve inside its source package: ${prepare}`,
      );
    }
    const id = resourcePath(entry.name);
    bundles.push({
      id,
      sourceDirectory: path.join(sourceRoot, directory),
      runtimeDirectory: `dist/extensions/${id}/${directory}`,
      prepare,
      inputs: [
        packageFile,
        prepare,
        ...bundledAssets.inputs.map(file => path.join(sourceRoot, resourcePath(file))),
      ],
    });
  }
  return bundles;
}

function verifyBundledExtensionAssets(bundles, runtimeRoot, { checkSources = true } = {}) {
  for (const bundle of bundles) {
    const { verifyBundledAssets } = require(bundle.prepare);
    if (typeof verifyBundledAssets !== 'function') {
      throw new Error(
        `Bundled extension asset builder must export verifyBundledAssets: ${bundle.prepare}`,
      );
    }
    const directory = runtimeRoot
      ? path.join(runtimeRoot, bundle.runtimeDirectory)
      : bundle.sourceDirectory;
    verifyBundledAssets(directory, checkSources);
  }
}

function containsAssetPath(relativePath, assetDirectories) {
  return assetDirectories.some(
    directory => relativePath === directory || relativePath.startsWith(directory + '/'),
  );
}

if (require.main === module) {
  const repoRoot = path.join(__dirname, '../..');
  try {
    for (const bundle of listBundledExtensionAssets(repoRoot)) {
      const result = spawnSync(process.execPath, [bundle.prepare, ...process.argv.slice(2)], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        break;
      }
    }
  } catch (error) {
    console.error(`[BundledExtensionAssets] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { containsAssetPath, listBundledExtensionAssets, verifyBundledExtensionAssets };
