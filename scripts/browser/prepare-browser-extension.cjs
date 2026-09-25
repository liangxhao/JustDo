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
const LOCKED_OPENCLAW_FILES = {
"THIRD_PARTY_NOTICES.txt": "aaef41044f3a3841c8c17351113c5f4f577845d82a5ba4f1650089b99323a2c7",
"background.js": "f98b65adcc5cfcb1bd4ffb3b30f460bc5cf068c0bc7d2e1bd98748de79b13a29",
"icons/icon128.png": "a745c50e0ecc40e1b0ef9c0e841ed7c968078c218a5ef15818ba661c7310a04d",
"icons/icon16.png": "f374c44036f3ac0a30b9e5f99d6e902548616f7b11886bef18d20b8b8ce084a0",
"icons/icon32.png": "092aea24a5edfc1907cf7964a5aaef7dbc5ae3b6c1fc581a7b4987f74a068268",
"icons/icon48.png": "02619a3803614f185ccee73b7860dc8123d7074ce81f929125bc63bd3737d6d4",
"manifest.json": "dcdea285b73e8541b88ad313b402a8a1752de3859a67531789073324d735c1da",
"modules/native-bootstrap.js": "279029948909215bd7caebe3b2e43862140d2ff5b5459e1c111b07831f93aa2f",
"modules/popup-background.js": "07cecec0f82f1025fc613a2ace1e6875943b4de1e515faebe1173271ce9b6162",
"modules/relay-auth-v2-crypto.js": "207b3bd5f4cb376cd83ab4f6b4284e531a1aff7e0f737d844534ede5fd37ece1",
"modules/relay-auth-v2.js": "a60cc11e197df11765c45dca3ca22f960683d34c95e2a047bac21ca580fc8b42",
"modules/relay-command-handler.js": "cbc0ccef42e8aa2954fe2bc7210bed222a24a126c8ca054b5595ec66cfbbcb92",
"modules/relay-connection.js": "845940f4602b16dc7196a6ce951e21cfaddd5223c9c75f5fe819e9a19ff66d43",
"modules/relay-core.js": "068f371f0d6183cfb03f38166f0436ff3e4043735d1ca2c4c30c222a128b6373",
"modules/relay-debugger.js": "d6d2352bec8482d4a308aa53976789c750d28f216ad321a7ae66eb163e3509d6",
"modules/relay-tab-groups.js": "dd355dd039431579f11a64893412e8c33f1d80a0f1c2e447eaa9971441c5403f",
"modules/tab-access-command-scope.js": "0ec625b939845f1f35c33695a1117dca54b670e0db10f2350b4f9ceddd1aef61",
"modules/tab-access-events.js": "b0e572d8c2731753bcd21654741d2bff3d0eaafa98450252e3bd3d74a9d939c4",
"modules/tab-access.js": "d5ddc87962ac118cc127be0d2deebcef36ec5e921a95142a807e1db3049287a6",
"modules/tab-document-provenance.js": "ef9b98cae4d8ab536a565def6bf315774ee43806f07582f187ca9cad7a40bb12",
"modules/tab-eligibility.js": "2d0f27e514014ed5e113510d35db6a1c5fc702783c3fe49706dd019c975a7e21",
"modules/tab-group-revocations.js": "341b9489b8188d734fd19e622b7fb1f1844e4ffc6dcf119fbc34107bdc978936",
"options.html": "39a2f3e94151c0eeca125412e0b2dee951edd37ab39a931242ce439967037ca5",
"options.js": "91f3f74b307c834ad3537d87ea81a44350228bf4ac0c069591c7219dbc02b763",
"popup.html": "aeece4f271f407d4604cb8b0b0ea8223decb4a829f2cb74291f3357ed7fea321",
"popup.js": "4900edd5e7e1995a3cf6bfcaf55428d05fa0385a47c0b2154a69db7e8f460c81"
};
const CONVERSATION_OVERLAY_FILES = [
  'THIRD_PARTY_NOTICES.append.txt',
  'appearance.css',
  'modules/appearance.js',
  'modules/appearance-settings.js',
  'modules/app-server-background.js',
  'modules/conversation-client.js',
  'modules/sidepanel-markdown.js',
  'modules/sidepanel-rich-content.js',
  'modules/sidepanel-rich-content.css',
  'modules/sidepanel-state.js',
  'modules/sidepanel-stream.js',
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
      'import { handleAppServerMessage } from "./modules/app-server-background.js";',
    'background import',
  );
  result = replaceIntegrationAnchor(
    result,
    'const RELAY_AUTH_TIMEOUT_MS = 10_000;',
    'const RELAY_AUTH_TIMEOUT_MS = 10_000;\n\n' +
      'void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });',
    'side panel behavior',
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
  manifest.description = manifest.description.replaceAll("OpenClaw", PRODUCT_NAME_TOKEN);
  manifest.key = BROWSER_EXTENSION_PUBLIC_KEY;
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

function applyPairingLayoutOverlay(value) {
  let result = replaceIntegrationAnchor(value,
    '<h2>Advanced manual pairing</h2>',
    '<h2>Connect to __PRODUCT_NAME__</h2>', 'manual pairing title');
  result = replaceIntegrationAnchor(result,
    'Use this only for a direct remote Gateway or when automatic setup reports that manual action\n        is required.',
    'In __PRODUCT_NAME__, open Settings &gt; Browser, copy the extension pairing information,\n        then paste it below.', 'manual pairing instructions');
  return replaceIntegrationAnchor(result,
    '<script type="module" src="options.js"></script>',
    '<link rel="stylesheet" href="appearance.css" />\n' +
      '    <script type="module" src="modules/appearance-settings.js"></script>\n' +
      '    <script type="module" src="options.js"></script>',
    'conversation appearance settings');
}

function applyPairingBehaviorOverlay(value) {
  let result = replaceIntegrationAnchor(value,
    ': "Paired; relay unavailable"',
    ': status.state === "connecting" ? "Connecting…" : "Paired; relay unavailable"',
    'pairing connection state');
  result = replaceIntegrationAnchor(
    result,
    `async function showResult(task, success) {
  try {
    const result = await task();
    if (result?.ok === false) {
      throw new Error(result.error ?? "Operation failed.");
    }
    message.textContent = success;
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
  }
  await refresh();
}`,
    `async function showResult(task, success) {
  let succeeded = false;
  try {
    const result = await task();
    if (result?.ok === false) {
      throw new Error(result.error ?? "Operation failed.");
    }
    message.textContent = success;
    succeeded = true;
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
  }
  await refresh();
  return succeeded;
}`,
    'pairing result handling',
  );
  result = replaceIntegrationAnchor(
    result,
    `pair.addEventListener("click", () => {
  void showResult(
    () =>
      chrome.runtime.sendMessage({
        type: "pair",
        pairingString: pairingString.value,
        accessMode: accessMode.value,
      }),
    "Manual pairing saved.",
  );
});`,
    `pair.addEventListener("click", () => {
  const pendingPairingString = pairingString.value;
  void showResult(
    () =>
      chrome.runtime.sendMessage({
        type: "pair",
        pairingString: pendingPairingString,
        accessMode: accessMode.value,
      }),
    "Pairing saved.",
  ).then(succeeded => {
    if (succeeded) pairingString.value = "";
  });
});`,
    'pairing submit behavior',
  );
  return replaceIntegrationAnchor(
    result,
    'void refresh();',
    `void refresh();
const statusRefreshTimer = setInterval(() => {
  if (!document.hidden) void refresh();
}, 2_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
window.addEventListener("pagehide", () => clearInterval(statusRefreshTimer), { once: true });`,
    'pairing status refresh',
  );
}

function buildExpectedExtensionFiles(repoRoot, productName) {
  const sourceRoot = path.join(repoRoot, 'resources', 'browser-extension');
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
  files.set(
    'options.html',
    Buffer.from(applyPairingLayoutOverlay(files.get('options.html').toString('utf8'))),
  );
  files.set(
    'options.js',
    Buffer.from(applyPairingBehaviorOverlay(files.get('options.js').toString('utf8'))),
  );

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
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
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
  for (const protocol of ['openclaw-extension-relay.v2', 'authVersion']) {
    if (!relayCore.includes(protocol)) {
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
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
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
