'use strict';
// Uses the actual Windows tar/zstd producer and final packaged-asset verifier.
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createZstdDecompress } = require('node:zlib');
const tar = require('tar');
const {
  containsAssetPath,
  listBundledExtensionAssets,
  verifyBundledExtensionAssets,
} = require('../../../scripts/plugins/bundled-extension-assets.cjs');

const root = path.resolve(__dirname, '../../..');
const output = path.join(root, '.agent-tasks/drawio/packaged');
const {
  PACKAGED_RUNTIME_EXCLUDES,
  packMultipleSources,
  compressTarArchive,
} = require('../../../scripts/packaging/pack-runtime-resources.cjs');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const archive = path.join(output, 'runtime.tar');
  const stage = fs.mkdtempSync(path.join(output, 'runtime-'));
  const bundle = listBundledExtensionAssets(root).find(({ id }) => id === 'drawio');
  if (!bundle) throw new Error('Missing draw.io asset declaration');
  const assets = path.join(stage, bundle.runtimeDirectory);
  fs.mkdirSync(path.dirname(assets), { recursive: true });
  fs.cpSync(bundle.sourceDirectory, assets, { recursive: true });
  packMultipleSources(
    [{
      dir: stage,
      prefix: 'cfmind',
      exclude: PACKAGED_RUNTIME_EXCLUDES,
      preserve: [bundle.runtimeDirectory],
    }],
    archive,
  );
  const compressedArchive = path.join(output, 'win-resources.tar.zst');
  await compressTarArchive(archive, compressedArchive);
  const extractionParent = fs.realpathSync(output);
  const extraction = fs.mkdtempSync(path.join(extractionParent, 'archive-'));
  const archiveAssetDirectories = [`cfmind/${bundle.runtimeDirectory}`];
  try {
    await pipeline(
      fs.createReadStream(compressedArchive),
      createZstdDecompress(),
      tar.extract({
        cwd: extraction,
        filter: entryPath =>
          containsAssetPath(entryPath.replaceAll('\\', '/').replace(/^\.\//, ''), archiveAssetDirectories),
      }),
    );
    verifyBundledExtensionAssets([bundle], path.join(extraction, 'cfmind'));
  } finally {
    const physical = fs.realpathSync(extraction);
    if (path.dirname(physical) !== extractionParent) throw new Error('Invalid archive extraction directory');
    fs.rmSync(physical, { recursive: true, force: true });
  }
  console.log('All offline editor assets and licenses survived Windows tar/zstd packaging.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
