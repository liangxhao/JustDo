'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { createZstdDecompress } = require('node:zlib');
const tar = require('tar');
const { verifyDrawioAssets } = require('./prepare.cjs');

async function verifyPackagedDrawioAssets(resourcesRoot, windows) {
  const relative = 'cfmind/dist/extensions/drawio/assets';
  if (!windows) {
    verifyDrawioAssets(path.join(resourcesRoot, relative));
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-packaged-assets-'));
  try {
    await pipeline(
      fs.createReadStream(path.join(resourcesRoot, 'win-resources.tar.zst')),
      createZstdDecompress(),
      tar.extract({
        cwd: temporary,
        filter: entry => {
          const name = entry.replaceAll('\\', '/').replace(/^\.\//, '');
          return name === relative || name.startsWith(relative + '/');
        },
      }),
    );
    verifyDrawioAssets(path.join(temporary, relative));
  } finally {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()))
      throw new Error('Invalid diagram verification directory');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log('[DiagramEditor] Packaged offline assets verified');
}
module.exports = { verifyPackagedDrawioAssets };
