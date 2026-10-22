'use strict';
// Uses the actual Windows tar/zstd producer and final packaged-asset verifier.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.agent-tasks/drawio/packaged');
const {
  packMultipleSources,
  compressTarArchive,
} = require('../../scripts/openclaw/pack-openclaw-tar.cjs');
const { verifyPackagedDrawioAssets } = require('../../plugins/extensions/drawio/scripts/verify-packaged.cjs');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const archive = path.join(output, 'runtime.tar');
  const stage = fs.mkdtempSync(path.join(output, 'runtime-'));
  const assets = path.join(stage, 'dist/extensions/drawio/assets');
  fs.mkdirSync(path.dirname(assets), { recursive: true });
  fs.cpSync(path.join(root, 'plugins/extensions/drawio/assets'), assets, { recursive: true });
  packMultipleSources([{ dir: stage, prefix: 'cfmind' }], archive);
  await compressTarArchive(archive, path.join(output, 'win-resources.tar.zst'));
  await verifyPackagedDrawioAssets(output, true);
  console.log('All offline editor assets and licenses survived Windows tar/zstd packaging.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
