'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ICON_SIZES = [16, 32, 48, 128];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PRODUCT_NAME_TOKEN = '__PRODUCT_NAME__';
const BROWSER_EXTENSION_ID = 'jboajogplelmaahjbomgflnfngpolgcb';
const BROWSER_EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAskQFUZFtJ36I7FXfGPJj+twgXrJgQDKju1ZFrXBQo+UgapYI3c+kcVgBbq+nNbivgYHHV30B/5iI7AxJcJSa1xxa5h34AzKrmg5CoFjdykj3qWZUyDLtueEiJVIKSKLZTdpphy6yqE8IIu7b5l5ZhRwFBio17S+Fo+M/oRzearW+qxYWioIrdF4qRu7KSdKYSHE1grVLI1PCl0g04rY22ITyuBLup13NlJM8w2I20O+Alk4Pe/uO2nxBnaKwB+LrDgQ7U8P6/AO5D/hN+xNVQLgS/gMhEf+W7WpQXjpCadi8xOdpb5YlKXfQtcg9jvDzbSvqNaWIqKlPup54R8hR0wIDAQAB';
// OpenClaw v2026.10.6 / fe06181dc5ecc01cf8904abbfc26925925efefbc.
const LOCKED_OPENCLAW_FILES = {
  "THIRD_PARTY_NOTICES.txt": "5463e636f0e9c20e5701af3b2cce03cc6bdce19e6e5bb831762a85072e907ff0",
  "background.js": "ddf3d12151de0a9911b8ec094a73d59c54ce8aef3e1d54dfd02c0937ccdfc96a",
  "icons/icon128.png": "a745c50e0ecc40e1b0ef9c0e841ed7c968078c218a5ef15818ba661c7310a04d",
  "icons/icon16.png": "f374c44036f3ac0a30b9e5f99d6e902548616f7b11886bef18d20b8b8ce084a0",
  "icons/icon32.png": "092aea24a5edfc1907cf7964a5aaef7dbc5ae3b6c1fc581a7b4987f74a068268",
  "icons/icon48.png": "02619a3803614f185ccee73b7860dc8123d7074ce81f929125bc63bd3737d6d4",
  "manifest.json": "dcdea285b73e8541b88ad313b402a8a1752de3859a67531789073324d735c1da",
  "modules/native-bootstrap.js": "23604ad0d6cf8d3fb3f037713bd3b9d5ee11b2ed6cea9bd0731ccf7819989330",
  "modules/popup-background.js": "92b46daaf3cd66cfbaa57a77a40fb69e6a313ef13c35080c953a97e2f4147aab",
  "modules/relay-auth-v2-crypto.js": "105b8345c06a0cfa590e3b15eda7fa24bd57548940e20918c9f2b557d1e24d07",
  "modules/relay-auth-v2.js": "1f227e39840d01f280cb8dea84a3053ccfbc96b9282d585ef6cd1b226d91a534",
  "modules/relay-command-handler.js": "cbc0ccef42e8aa2954fe2bc7210bed222a24a126c8ca054b5595ec66cfbbcb92",
  "modules/relay-connection.js": "2b561d2d0381a294ef424513aad040f08225bdea455b7cb9a85e5bb9d1e5795e",
  "modules/relay-core.js": "57156fda4877f9828d749fc62e05138e2a548e752f6baa31135dbdf24f267841",
  "modules/relay-debugger.js": "a1f1c5637901e48637926bba4ccd9d8337511ca05e070c84d70b058c096a8cdf",
  "modules/relay-tab-groups.js": "99765b42aca26dc403321f9e19ffcf32e1e8f5d9946f5e54a57fa15f31052e89",
  "modules/relay-url.js": "2979538f35e2ee028f2bf7502c6b8c702706f208ef53cfd81a09537bb282d55a",
  "modules/serial-queue.js": "889b1e79b5cdb85c7961a2a87f92b4c1dcf732cb8c000a84d8a5ade8774e0695",
  "modules/strict-json.js": "7efe5799f9650d7e32273e28d2e3acccd062ede3f05741821474aac86ac197a7",
  "modules/tab-access-command-scope.js": "e92c4b80f461deb9836f850e2d0c9d33afe80926bc9b79651603a665ac08b9a7",
  "modules/tab-access-events.js": "b0e572d8c2731753bcd21654741d2bff3d0eaafa98450252e3bd3d74a9d939c4",
  "modules/tab-access.js": "36a50ae14732fd27482e9dc4bdb7db2682477a77be86655af4787ced4daf104a",
  "modules/tab-document-provenance.js": "ef9b98cae4d8ab536a565def6bf315774ee43806f07582f187ca9cad7a40bb12",
  "modules/tab-eligibility.js": "dae0c6ed52e639ec8cec82362d39b78c76244a065fb27a606917f472e7db40bf",
  "modules/tab-group-revocations.js": "341b9489b8188d734fd19e622b7fb1f1844e4ffc6dcf119fbc34107bdc978936",
  "options.html": "39a2f3e94151c0eeca125412e0b2dee951edd37ab39a931242ce439967037ca5",
  "options.js": "80770f948d40eabd3b112e402675549e497ebf28bb304db4de8de412b0157aac",
  "popup.html": "aeece4f271f407d4604cb8b0b0ea8223decb4a829f2cb74291f3357ed7fea321",
  "popup.js": "93013bcd39aa821a7a7e2b878688ff73669adfb085cb9cd1ff1caa08dfa4ad08"
};
const CONVERSATION_OVERLAY_FILES = [
  'THIRD_PARTY_NOTICES.append.txt',
  'appearance.css',
  'modules/appearance.js',
  'modules/appearance-settings.js',
  'modules/options-i18n.js',
  'modules/app-server-background.js',
  'modules/relay-bootstrap.js',
  'modules/conversation-client.js',
  'modules/sidepanel-markdown.js',
  'modules/sidepanel-rich-content.js',
  'modules/sidepanel-rich-content.css',
  'modules/sidepanel-state.js',
  'modules/sidepanel-i18n.js',
  'modules/sidepanel-messages.js',
  'modules/sidepanel-activity.js',
  'modules/sidepanel-stream.js',
  'options.css',
  'options.html',
  'options.js',
  'sidepanel.css',
  'sidepanel.html',
  'sidepanel.js',
];

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

function normalizedFileContent(filePath, relativePath) {
  return relativePath.endsWith('.png')
    ? fs.readFileSync(filePath)
    : Buffer.from(fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'));
}

function verifySourceFiles(sourceDir, expectedFiles, label) {
  const actualFiles = listRelativeFiles(sourceDir).sort();
  const sortedExpectedFiles = [...expectedFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(sortedExpectedFiles)) {
    throw new Error(`Browser extension ${label} files do not match the expected source layout.`);
  }
}

function verifyLockedSource(sourceDir, lockedFiles, label) {
  const expectedFiles = Object.keys(lockedFiles);
  verifySourceFiles(sourceDir, expectedFiles, label);
  for (const relativePath of expectedFiles) {
    const content = normalizedFileContent(path.join(sourceDir, relativePath), relativePath);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    if (digest !== lockedFiles[relativePath]) {
      throw new Error(`Browser extension ${label} checksum mismatch: ${relativePath}`);
    }
  }
}

function replaceIntegrationAnchor(value, anchor, replacement, label) {
  const firstIndex = value.indexOf(anchor);
  if (firstIndex < 0 || value.indexOf(anchor, firstIndex + anchor.length) >= 0) {
    throw new Error(`OpenClaw browser extension integration anchor changed: ${label}`);
  }
  return value.replace(anchor, replacement);
}

function applyBackgroundOverlay(value) {
  let result = replaceIntegrationAnchor(
    value,
    'import { createPopupMessageHandler } from "./modules/popup-background.js";',
    'import { createPopupMessageHandler } from "./modules/popup-background.js";\n' +
      'import { handleAppServerMessage } from "./modules/app-server-background.js";\n' +
      'import { requestLocalBootstrap } from "./modules/relay-bootstrap.js";',
    'background import',
  );
  result = replaceIntegrationAnchor(
    result,
    'const RELAY_AUTH_TIMEOUT_MS = 10_000;',
    'const RELAY_AUTH_TIMEOUT_MS = 10_000;\n\n' +
      'void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });',
    'side panel behavior',
  );
  result = replaceIntegrationAnchor(
    result,
    'nativeBootstrap = createNativeBootstrapController({\n  getPairing: getConfig,',
    'nativeBootstrap = createNativeBootstrapController({\n  requestBootstrap: requestLocalBootstrap,\n  getPairing: getConfig,',
    'product relay bootstrap transport',
  );
  result = replaceIntegrationAnchor(
    result,
    'getNativeBootstrapStatus: async () => {\n    await tabAccessReady;\n    if (!retiredCopilotCustodyBlocked) {\n      await nativeBootstrap.attempt();\n    }\n    return await nativeBootstrap.status();\n  },',
    'getNativeBootstrapStatus: async () => {\n    await tabAccessReady;\n    return await nativeBootstrap.status();\n  },',
    'passive product bootstrap status',
  );
  return replaceIntegrationAnchor(
    result,
    'chrome.runtime.onMessage.addListener((msg, _sender, reply) => handlePopupMessage(msg, reply));',
    'chrome.runtime.onMessage.addListener(\n' +
      '  (msg, _sender, reply) =>\n' +
      '    handleAppServerMessage(msg, reply) || handlePopupMessage(msg, reply),\n' +
      ');',
    'runtime message dispatch',
  );
}

function applyManifestOverlay(value) {
  const manifest = JSON.parse(value);
  manifest.name = PRODUCT_NAME_TOKEN;
  manifest.action.default_title = PRODUCT_NAME_TOKEN;
  manifest.description = manifest.description.replaceAll('OpenClaw', PRODUCT_NAME_TOKEN);
  manifest.key = BROWSER_EXTENSION_PUBLIC_KEY;
  // Desktop discovery and relay use loopback independently of optional page access.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.optional_host_permissions = ['http://*/*', 'https://*/*'];
  manifest.permissions = [
    'activeTab',
    ...manifest.permissions.filter(permission => permission !== 'activeTab'),
    'nativeMessaging',
    'scripting',
    'sidePanel',
  ].filter((permission, index, permissions) => permissions.indexOf(permission) === index);
  delete manifest.action.default_popup;
  manifest.side_panel = { default_path: 'sidepanel.html' };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function buildExpectedExtensionFiles(repoRoot, productName) {
  const sourceRoot = path.join(repoRoot, 'plugins', 'browser-extensions', 'browser-assistant');
  const openClawDir = path.join(sourceRoot, 'openclaw');
  const overlayDir = path.join(sourceRoot, 'conversation-overlay');
  verifyLockedSource(openClawDir, LOCKED_OPENCLAW_FILES, 'OpenClaw baseline');
  verifySourceFiles(overlayDir, CONVERSATION_OVERLAY_FILES, 'conversation overlay');

  const files = new Map();
  for (const relativePath of Object.keys(LOCKED_OPENCLAW_FILES)) {
    const content = normalizedFileContent(path.join(openClawDir, relativePath), relativePath);
    files.set(relativePath, content);
  }
  for (const relativePath of CONVERSATION_OVERLAY_FILES) {
    if (relativePath === 'THIRD_PARTY_NOTICES.append.txt') continue;
    const content = normalizedFileContent(path.join(overlayDir, relativePath), relativePath);
    files.set(relativePath, content);
  }

  const noticesAppend = fs
    .readFileSync(path.join(overlayDir, 'THIRD_PARTY_NOTICES.append.txt'), 'utf8')
    .replace(/\r\n/g, '\n');
  files.set(
    'THIRD_PARTY_NOTICES.txt',
    Buffer.from(
      `${files.get('THIRD_PARTY_NOTICES.txt').toString('utf8').trimEnd()}\n\n${noticesAppend.trim()}\n`,
    ),
  );
  files.set(
    'background.js',
    Buffer.from(applyBackgroundOverlay(files.get('background.js').toString('utf8'))),
  );
  files.set(
    'manifest.json',
    Buffer.from(applyManifestOverlay(files.get('manifest.json').toString('utf8'))),
  );
  let bootstrap = files.get('modules/native-bootstrap.js').toString('utf8');
  bootstrap = replaceIntegrationAnchor(
    bootstrap,
    'export function createNativeBootstrapController({ chromeApi = chrome, getPairing, applyPairing }) {',
    'export function createNativeBootstrapController({ chromeApi = chrome, getPairing, applyPairing, requestBootstrap = sendNativeBootstrap }) {',
    'native bootstrap transport injection',
  );
  bootstrap = replaceIntegrationAnchor(
    bootstrap,
    'response = await sendNativeBootstrap(chromeApi, {\n          v: 1,\n          op: "bootstrap",',
    'response = await requestBootstrap(chromeApi, {\n          v: 1,\n          op: "bootstrap",',
    'native bootstrap transport call',
  );
  files.set('modules/native-bootstrap.js', Buffer.from(bootstrap));
  for (const size of ICON_SIZES) {
    files.set(
      `icons/icon${size}.png`,
      fs.readFileSync(path.join(repoRoot, 'resources', 'icons', 'png', `${size}x${size}.png`)),
    );
  }

  for (const [relativePath, content] of files) {
    if (relativePath.endsWith('.png')) continue;
    const text = ['options.html', 'options.js', 'popup.html', 'popup.js'].includes(relativePath)
      ? content.toString('utf8').replaceAll('OpenClaw', PRODUCT_NAME_TOKEN)
      : content.toString('utf8');
    files.set(relativePath, Buffer.from(renderProductName(text, productName)));
  }
  return { files, openClawDir, overlayDir };
}

function writeExpectedExtensionFiles(outputDir, files) {
  for (const [relativePath, content] of files) {
    const filePath = path.join(outputDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

function verifyBrowserExtension(extensionDir, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../../../..'));
  const productName = resolveProductName(repoRoot, options.productName);
  const expected = buildExpectedExtensionFiles(repoRoot, productName);
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Browser extension manifest is missing: ${manifestPath}`);
  }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.name !== productName || manifest.action?.default_title !== productName) {
    throw new Error('Browser extension identity must match package.json productName.');
  }
  if (manifest.version !== '2.3.0') {
    throw new Error(`Unsupported OpenClaw browser extension version: ${manifest.version}.`);
  }

  for (const relativePath of [
    'background.js',
    'popup.html',
    'popup.js',
    'options.html',
    'options.js',
    'sidepanel.html',
    'sidepanel.css',
    'sidepanel.js',
    path.join('modules', 'app-server-background.js'),
    path.join('modules', 'conversation-client.js'),
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
  for (const permission of ['activeTab', 'nativeMessaging', 'scripting', 'sidePanel']) {
    if (!manifest.permissions?.includes(permission)) {
      throw new Error(`Browser extension side chat permission is missing: ${permission}`);
    }
  }
  for (const origin of ['http://*/*', 'https://*/*']) {
    if (!manifest.optional_host_permissions?.includes(origin)) {
      throw new Error(`Browser extension page context permission is missing: ${origin}`);
    }
  }
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['http://127.0.0.1/*'])) {
    throw new Error('Browser extension loopback permission must be explicit and limited to 127.0.0.1.');
  }
  if (manifest.side_panel?.default_path !== 'sidepanel.html') {
    throw new Error('Browser extension side chat entry is missing.');
  }
  const extensionId = [
    ...crypto
      .createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest()
      .subarray(0, 16),
  ]
    .flatMap(byte => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))])
    .join('');
  if (extensionId !== BROWSER_EXTENSION_ID) {
    throw new Error('Browser extension key does not match the native host allowlist.');
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
  const relayAuth = fs.readFileSync(path.join(extensionDir, 'modules', 'relay-auth-v2.js'), 'utf8');
  for (const [protocol, owner] of [
    ['openclaw-extension-relay.v2', relayAuth],
    ['authVersion', relayCore],
  ]) {
    if (!owner.includes(protocol)) {
      throw new Error(`Browser extension relay protocol is missing: ${protocol}`);
    }
  }

  const actualFiles = listRelativeFiles(extensionDir).sort();
  const expectedFiles = [...expected.files.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Browser extension files do not match the composed locked snapshots.');
  }
  for (const relativePath of expectedFiles) {
    const filePath = path.join(extensionDir, relativePath);
    const expectedContent = expected.files.get(relativePath);
    const actualContent = normalizedFileContent(filePath, relativePath);
    if (!actualContent.equals(expectedContent)) {
      throw new Error(`Browser extension file checksum mismatch: ${relativePath}`);
    }
  }
  return { extensionDir, manifest, productName };
}

function prepareBrowserExtension(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../../../..'));
  const outputDir = path.resolve(
    options.outputDir || path.join(repoRoot, 'build', 'browser-extension', 'chrome-extension'),
  );
  const allowedOutputRoot = path.join(repoRoot, 'build', 'browser-extension');
  const relativeOutput = path.relative(allowedOutputRoot, outputDir);
  if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error(`Browser extension output must be inside ${allowedOutputRoot}.`);
  }
  const productName = resolveProductName(repoRoot, options.productName);
  const expected = buildExpectedExtensionFiles(repoRoot, productName);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  writeExpectedExtensionFiles(outputDir, expected.files);

  verifyBrowserExtension(outputDir, { repoRoot, productName });
  return {
    sourceDir: expected.openClawDir,
    overlayDir: expected.overlayDir,
    outputDir,
    productName,
  };
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
