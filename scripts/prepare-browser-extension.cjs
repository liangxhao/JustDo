'use strict';

const fs = require('fs');
const path = require('path');

const { resolveBuilderProductMetadata } = require('./electron-builder-product-metadata.cjs');

const PRODUCT_NAME_TOKEN = '{{PRODUCT_NAME}}';
const ICON_SIZES = [16, 32, 48, 128];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readProductName(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return resolveBuilderProductMetadata(packageJson.productName).productName;
}

function verifyBrowserExtension(extensionDir, productName) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Browser extension manifest is missing: ${manifestPath}`);
  }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (
    manifest.name !== productName ||
    manifest.action?.default_title !== productName ||
    !String(manifest.description || '').includes(productName)
  ) {
    throw new Error(`Browser extension branding does not match productName ${productName}.`);
  }
  if (manifestText.includes(PRODUCT_NAME_TOKEN)) {
    throw new Error('Browser extension manifest still contains a product-name placeholder.');
  }

  for (const relativePath of [
    'background.js',
    'popup.html',
    'popup.js',
    path.join('modules', 'relay-core.js'),
    'THIRD_PARTY_NOTICES.txt',
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
  for (const protocol of ['openclaw-extension-relay', 'openclaw-extension-token.']) {
    if (!relayCore.includes(protocol)) {
      throw new Error(`Browser extension relay protocol is missing: ${protocol}`);
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

  const productName = readProductName(repoRoot);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.cpSync(sourceDir, outputDir, { recursive: true, force: true });

  const manifestTemplatePath = path.join(outputDir, 'manifest.template.json');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifestTemplate = fs.readFileSync(manifestTemplatePath, 'utf8');
  if (!manifestTemplate.includes(PRODUCT_NAME_TOKEN)) {
    throw new Error('Browser extension manifest template has no product-name placeholder.');
  }
  fs.writeFileSync(
    manifestPath,
    manifestTemplate.replaceAll(PRODUCT_NAME_TOKEN, productName),
    'utf8',
  );
  fs.rmSync(manifestTemplatePath);

  const iconDir = path.join(outputDir, 'icons');
  fs.mkdirSync(iconDir, { recursive: true });
  for (const size of ICON_SIZES) {
    fs.copyFileSync(
      path.join(repoRoot, 'resources', 'icons', 'png', `${size}x${size}.png`),
      path.join(iconDir, `icon${size}.png`),
    );
  }

  verifyBrowserExtension(outputDir, productName);
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

module.exports = { prepareBrowserExtension, readProductName, verifyBrowserExtension };
