'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ICON_SIZES = [16, 32, 48, 128];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PRODUCT_NAME_TOKEN = '__PRODUCT_NAME__';
const LOCKED_EXTENSION_FILES = {
  'THIRD_PARTY_NOTICES.txt': '63d37cb89bd2720875b6f196218f6800e6d12b7ac0f376b7a45af63e53b56053',
  'background.js': 'd1fc72415c17ddc54845ff7f820ce8982ca02d26ae148c91737da11a32656f52',
  'icons/icon128.png': '8f90c97fd5ac448444734af4bb203b8cbf9289d0c7f0f9e98d5b08d0c9b2b628',
  'icons/icon16.png': '784551a58eb2f3fbbbabb8f417034c487af92e0514d278935ad7dcae900d3770',
  'icons/icon32.png': '7466945442fa137cc0b8d11a15e6ddb57e3853e48548fd692c54cac2146753a9',
  'icons/icon48.png': '9c2791a5fe13c847aeccd747a2a25fcd385de11075058dc8c5187a23feea523b',
  'manifest.json': 'c490253b4e576959cc2db00bcb5479fb4a9f1f941b593b59486c95e6ccf59bfe',
  'modules/native-bootstrap.js': '5965e593339eb1e94d187af27b783af1a5bb03502b5fd5991a8ef5772cd45f72',
  'modules/popup-background.js': '2b8bf6741667558bc78cf0e76da54dc2ca0f073e367b08e106980392e1341fe8',
  'modules/relay-auth-v2-crypto.js':
    '207b3bd5f4cb376cd83ab4f6b4284e531a1aff7e0f737d844534ede5fd37ece1',
  'modules/relay-auth-v2.js': 'a60cc11e197df11765c45dca3ca22f960683d34c95e2a047bac21ca580fc8b42',
  'modules/relay-command-handler.js':
    'a6f8c30560c43df77692d46e13cfe2707e4afef73ecd22edc529df7dfc9f4544',
  'modules/relay-connection.js': '845940f4602b16dc7196a6ce951e21cfaddd5223c9c75f5fe819e9a19ff66d43',
  'modules/relay-core.js': '3af45365b6007454645bbeaeaeb5cc2face87872341368309313369ec9cbef60',
  'modules/relay-debugger.js': 'd6d2352bec8482d4a308aa53976789c750d28f216ad321a7ae66eb163e3509d6',
  'modules/relay-tab-groups.js': 'dd355dd039431579f11a64893412e8c33f1d80a0f1c2e447eaa9971441c5403f',
  'modules/tab-access-command-scope.js':
    '0ec625b939845f1f35c33695a1117dca54b670e0db10f2350b4f9ceddd1aef61',
  'modules/tab-access-events.js':
    '60fcd8d5c5e09c57dffe7c7f22c6ca624ac41b67f4c12465510f06326380181b',
  'modules/tab-access.js': 'a51e6ebd1726be757e950c1a2442123d17f43d3b61ce441278c581b263c5d374',
  'modules/tab-document-provenance.js':
    '84c9c39dc1c7feb19c29ac70db6c437bbbd7f0691c9f8e95fdb05f9c5fa70660',
  'modules/tab-eligibility.js': '2d0f27e514014ed5e113510d35db6a1c5fc702783c3fe49706dd019c975a7e21',
  'modules/tab-group-revocations.js':
    '341b9489b8188d734fd19e622b7fb1f1844e4ffc6dcf119fbc34107bdc978936',
  'options.html': 'b8441f94f67ff61a0c19bcf51b6530bc74503d8411a1cc649bfd281b9ee6aa8a',
  'options.js': 'e786144dba7d79bfeab7e0aed94a248be2854123fefd815641c2f23d1c418922',
  'popup.html': 'dfb8700f0674b14a68803dae8e35491da59067544a60298c583c3c1afc59ef12',
  'popup.js': 'cd3a28916fe60ce627d46f2ba11f6e77aa92c67b95199e8bd3af2de69eae04d9',
};

function listRelativeFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listRelativeFiles(path.join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

function resolveProductName(repoRoot, explicitProductName) {
  const productName =
    explicitProductName ??
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).productName;
  if (typeof productName !== 'string' || !/^[A-Za-z]{1,64}$/.test(productName)) {
    throw new Error('Browser extension productName must contain 1-64 ASCII letters.');
  }
  return productName;
}

function renderProductName(value, productName) {
  return value.replaceAll(PRODUCT_NAME_TOKEN, productName);
}

function renderBrowserExtension(extensionDir, productName) {
  for (const relativePath of listRelativeFiles(extensionDir)) {
    if (relativePath.endsWith('.png')) continue;
    const filePath = path.join(extensionDir, relativePath);
    const value = fs.readFileSync(filePath, 'utf8');
    if (value.includes(PRODUCT_NAME_TOKEN)) {
      fs.writeFileSync(filePath, renderProductName(value, productName), 'utf8');
    }
  }
}

function verifyBrowserExtension(extensionDir, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const sourceDir = path.join(repoRoot, 'resources', 'browser-extension', 'chrome-extension');
  const productName = resolveProductName(repoRoot, options.productName);
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Browser extension manifest is missing: ${manifestPath}`);
  }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== productName || manifest.action?.default_title !== productName) {
    throw new Error('Browser extension identity must match package.json productName.');
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
    const sourcePath = path.join(sourceDir, relativePath);
    const sourceContent = relativePath.endsWith('.png')
      ? fs.readFileSync(sourcePath)
      : Buffer.from(fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n'));
    const digest = crypto.createHash('sha256').update(sourceContent).digest('hex');
    if (digest !== LOCKED_EXTENSION_FILES[relativePath]) {
      throw new Error(`Browser extension source checksum mismatch: ${relativePath}`);
    }
    const expectedContent = relativePath.endsWith('.png')
      ? sourceContent
      : Buffer.from(renderProductName(sourceContent.toString('utf8'), productName));
    const actualContent = relativePath.endsWith('.png')
      ? fs.readFileSync(filePath)
      : Buffer.from(fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'));
    if (!actualContent.equals(expectedContent)) {
      throw new Error(`Browser extension file checksum mismatch: ${relativePath}`);
    }
  }
  return { extensionDir, manifest, productName };
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

  const productName = resolveProductName(repoRoot, options.productName);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.cpSync(sourceDir, outputDir, { recursive: true, force: true });
  renderBrowserExtension(outputDir, productName);

  verifyBrowserExtension(outputDir, { repoRoot, productName });
  return { sourceDir, outputDir, productName };
}

if (require.main === module) {
  try {
    const result = prepareBrowserExtension();
    console.log(
      `[prepare-browser-extension] Prepared ${result.productName} extension: ${result.outputDir}`,
    );
  } catch (error) {
    console.error(
      `[prepare-browser-extension] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = { prepareBrowserExtension, verifyBrowserExtension };
