'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Compose an application entry over byte-verified native entries, without transforming native code. */
function syncNativeExtensionOverlay(sourceDir, targetDir) {
  const source = JSON.parse(fs.readFileSync(path.join(sourceDir, 'native-source.json'), 'utf8'));
  const nativePackage = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(targetDir, 'openclaw.plugin.json'), 'utf8'),
  );
  if (
    manifest.id !== source.id ||
    nativePackage.version !== source.version ||
    nativePackage.openclaw?.extensions?.[0] !== './index.js' ||
    manifest.capabilityCatalogEntry !== './capability-catalog.js'
  ) {
    throw new Error('Native extension overlay identity or entry contract changed');
  }
  const plans = Object.entries(source.entries).map(([name, expectedHash]) => {
    if (
      !['index.js', 'capability-catalog.js'].includes(name) ||
      !/^[a-f0-9]{64}$/.test(expectedHash)
    )
      throw new Error('Invalid native extension overlay source contract');
    const savedName = `native-${name.replace(/\.js$/, '.mjs')}`;
    const savedPath = path.join(targetDir, savedName);
    const bytes = fs.readFileSync(
      fs.existsSync(savedPath) ? savedPath : path.join(targetDir, name),
    );
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash)
      throw new Error(
        `Native ${source.id}/${name} differs from the locked pristine source; rebuild the runtime`,
      );
    return { name, savedName, savedPath, bytes };
  });
  if (plans.length !== 2)
    throw new Error('Native extension overlay requires both registration and catalog entries');
  // Finish every compilation before publishing either entry. Native imports
  // retain their original directory and therefore their module/worker identity.
  const outputs = plans.map(plan => ({
    ...plan,
    code: require('esbuild').buildSync({
      entryPoints: [path.join(sourceDir, plan.name.replace(/\.js$/, '.ts'))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      packages: 'external',
      external: plans.map(entry => `./${entry.savedName}`),
      write: false,
    }).outputFiles[0].contents,
  }));
  for (const output of outputs) {
    fs.writeFileSync(output.savedPath, output.bytes);
    fs.writeFileSync(path.join(targetDir, output.name), output.code);
  }
}

module.exports = { syncNativeExtensionOverlay };
