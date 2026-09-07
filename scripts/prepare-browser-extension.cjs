'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ICON_SIZES = [16, 32, 48, 128];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LOCKED_EXTENSION_FILES = {
  'THIRD_PARTY_NOTICES.txt': '70e8f0386d6fac35d1e0d29f20793f710880ff00725a5330296bcdc0ae4faad5',
  'background.js': 'f98b65adcc5cfcb1bd4ffb3b30f460bc5cf068c0bc7d2e1bd98748de79b13a29',
  'icons/icon128.png': 'a745c50e0ecc40e1b0ef9c0e841ed7c968078c218a5ef15818ba661c7310a04d',
  'icons/icon16.png': 'f374c44036f3ac0a30b9e5f99d6e902548616f7b11886bef18d20b8b8ce084a0',
  'icons/icon32.png': '092aea24a5edfc1907cf7964a5aaef7dbc5ae3b6c1fc581a7b4987f74a068268',
  'icons/icon48.png': '02619a3803614f185ccee73b7860dc8123d7074ce81f929125bc63bd3737d6d4',
  'manifest.json': '2edfb18bbf168c7b8ebb5e146e757699d53a2a4c0cadd32199e411dbd12ad7ad',
  'modules/native-bootstrap.js': '5965e593339eb1e94d187af27b783af1a5bb03502b5fd5991a8ef5772cd45f72',
  'modules/popup-background.js': 'b06867606445be77f850c54386a214aeaaf197135c38780c868b553f1777a44e',
  'modules/relay-auth-v2-crypto.js':
    '207b3bd5f4cb376cd83ab4f6b4284e531a1aff7e0f737d844534ede5fd37ece1',
  'modules/relay-auth-v2.js': 'a60cc11e197df11765c45dca3ca22f960683d34c95e2a047bac21ca580fc8b42',
  'modules/relay-command-handler.js':
    'a6f8c30560c43df77692d46e13cfe2707e4afef73ecd22edc529df7dfc9f4544',
  'modules/relay-connection.js': '845940f4602b16dc7196a6ce951e21cfaddd5223c9c75f5fe819e9a19ff66d43',
  'modules/relay-core.js': '068f371f0d6183cfb03f38166f0436ff3e4043735d1ca2c4c30c222a128b6373',
  'modules/relay-debugger.js': 'd6d2352bec8482d4a308aa53976789c750d28f216ad321a7ae66eb163e3509d6',
  'modules/relay-tab-groups.js': 'dd355dd039431579f11a64893412e8c33f1d80a0f1c2e447eaa9971441c5403f',
  'modules/tab-access-command-scope.js':
    '0ec625b939845f1f35c33695a1117dca54b670e0db10f2350b4f9ceddd1aef61',
  'modules/tab-access-events.js':
    '60fcd8d5c5e09c57dffe7c7f22c6ca624ac41b67f4c12465510f06326380181b',
  'modules/tab-access.js': 'e2399045603baf8a37a801c9fa70e0377ac5b9f4c85ce9bb1415b7e6c84bc19f',
  'modules/tab-document-provenance.js':
    '84c9c39dc1c7feb19c29ac70db6c437bbbd7f0691c9f8e95fdb05f9c5fa70660',
  'modules/tab-eligibility.js': '2d0f27e514014ed5e113510d35db6a1c5fc702783c3fe49706dd019c975a7e21',
  'modules/tab-group-revocations.js':
    '341b9489b8188d734fd19e622b7fb1f1844e4ffc6dcf119fbc34107bdc978936',
  'options.html': '39a2f3e94151c0eeca125412e0b2dee951edd37ab39a931242ce439967037ca5',
  'options.js': '91f3f74b307c834ad3537d87ea81a44350228bf4ac0c069591c7219dbc02b763',
  'popup.html': 'aeece4f271f407d4604cb8b0b0ea8223decb4a829f2cb74291f3357ed7fea321',
  'popup.js': '4900edd5e7e1995a3cf6bfcaf55428d05fa0385a47c0b2154a69db7e8f460c81',
};

function listRelativeFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listRelativeFiles(path.join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

function verifyBrowserExtension(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Browser extension manifest is missing: ${manifestPath}`);
  }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== 'OpenClaw' || manifest.action?.default_title !== 'OpenClaw') {
    throw new Error('Browser extension must preserve the locked OpenClaw extension identity.');
  }
  if (manifest.version !== '2.2.0') {
    throw new Error(`Unsupported OpenClaw browser extension version: ${manifest.version}.`);
  }

  for (const relativePath of [
    'background.js',
    'popup.html',
    'popup.js',
    'options.html',
    'options.js',
    path.join('modules', 'relay-core.js'),
    path.join('modules', 'relay-auth-v2.js'),
    path.join('modules', 'relay-connection.js'),
    ...ICON_SIZES.map(size => path.join('icons', `icon${size}.png`)),
  ]) {
    const filePath = path.join(extensionDir, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Browser extension resource is missing: ${filePath}`);
    }
  }

  for (const size of ICON_SIZES) {
    const iconPath = path.join(extensionDir, 'icons', `icon${size}.png`);
    const png = fs.readFileSync(iconPath);
    if (
      png.length < 24 ||
      !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      png.readUInt32BE(16) !== size ||
      png.readUInt32BE(20) !== size
    ) {
      throw new Error(`Browser extension icon must be a ${size}x${size} PNG: ${iconPath}`);
    }
  }

  const relayCore = fs.readFileSync(path.join(extensionDir, 'modules', 'relay-core.js'), 'utf8');
  for (const protocol of ['openclaw-extension-relay.v2', 'authVersion']) {
    if (!relayCore.includes(protocol)) {
      throw new Error(`Browser extension relay protocol is missing: ${protocol}`);
    }
  }

  const actualFiles = listRelativeFiles(extensionDir).sort();
  const expectedFiles = Object.keys(LOCKED_EXTENSION_FILES).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Browser extension files do not match the locked OpenClaw snapshot.');
  }
  for (const relativePath of expectedFiles) {
    const filePath = path.join(extensionDir, relativePath);
    const content = relativePath.endsWith('.png')
      ? fs.readFileSync(filePath)
      : Buffer.from(fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'));
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    if (digest !== LOCKED_EXTENSION_FILES[relativePath]) {
      throw new Error(`Browser extension file checksum mismatch: ${relativePath}`);
    }
  }
  return { extensionDir, manifest };
}

function prepareBrowserExtension(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const sourceDir = path.join(repoRoot, 'resources', 'browser-extension', 'chrome-extension');
  const outputDir = path.resolve(
    options.outputDir || path.join(repoRoot, 'build', 'browser-extension', 'chrome-extension'),
  );
  const allowedOutputRoot = path.join(repoRoot, 'build', 'browser-extension');
  const relativeOutput = path.relative(allowedOutputRoot, outputDir);
  if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error(`Browser extension output must be inside ${allowedOutputRoot}.`);
  }
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Browser extension source is missing: ${sourceDir}`);
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.cpSync(sourceDir, outputDir, { recursive: true, force: true });

  verifyBrowserExtension(outputDir);
  return { sourceDir, outputDir };
}

if (require.main === module) {
  try {
    const result = prepareBrowserExtension();
    console.log(`[prepare-browser-extension] Prepared OpenClaw extension: ${result.outputDir}`);
  } catch (error) {
    console.error(
      `[prepare-browser-extension] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = { prepareBrowserExtension, verifyBrowserExtension };
