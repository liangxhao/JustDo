'use strict';

// Capability: display the desktop product name in fresh operator terminals.
// Target: pristine openclaw@2026.9.8 terminal intro in the manager, recovery and both workers.
// Scope: presentation only; leave native seeding, buffers, offsets and PTY output unchanged.
// Safety: use validated build-time product metadata, never renderer text or escape sequences.
// Remove when: upstream offers a product-owned terminal intro setting.
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const {
  resolveBuilderProductMetadata,
} = require('../../packaging/electron-builder-product-metadata.cjs');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_TERMINAL_PRODUCT_BANNER_V2026_9_8';
const SIGNATURE = 'function composeTerminalIntroBanner()';
const NATIVE_BODY =
  'return `\\r\\n${`\\x1b[33mWelcome to the Claw.${RESET}`}\\r\\n\\r\\n${`\\x1b[91m${TERMINAL_INTRO_ART.join("\\r\\n")}\\r\\n\\r\\n`}${RESET}`;';
const canonical = body =>
  transformSync(`function banner() { ${body} }`, {
    minifySyntax: true,
    minifyWhitespace: true,
    legalComments: 'none',
  }).code;

function transform(source, productName, file = '<runtime>') {
  const brand = resolveBuilderProductMetadata(productName).productName;
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const start = source.indexOf(SIGNATURE);
  if (start < 0 || source.indexOf(SIGNATURE, start + 1) >= 0)
    throw new Error(`${file}: terminal intro topology changed`);
  const open = source.indexOf('{', start);
  const end = findMatchingDelimiter(source, open, '{', '}', file);
  const body = source.slice(open + 1, end);
  const expected = `return ${JSON.stringify(`\r\n\x1b[33mWelcome to the ${brand}.\x1b[0m\r\n\r\n`)};`;
  if (canonical(body) === canonical(expected)) {
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT) || canonical(body) !== canonical(NATIVE_BODY))
    throw new Error(
      `${file}: historical or partial terminal intro; rebuild the locked pristine runtime`,
    );
  const patched = source.slice(0, open + 1) + `\n  ${expected}\n` + source.slice(end);
  return `// ${CONTRACT}\n` + patched;
}

function processTargets(root, verify, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '../../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const files = findFilesContaining(root, SIGNATURE);
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 5 : 4;
  if (files.length !== expected)
    throw new Error(`Terminal intro topology changed: ${files.length}, expected ${expected}`);
  const plans = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, pkg.productName, file) };
  });
  const sources = plans.filter(({ file }) => !isGatewayBundlePath(file));
  if (
    sources.some(({ source }) => source.includes(CONTRACT)) &&
    sources.some(({ source }) => !source.includes(CONTRACT))
  )
    throw new Error(
      'Mixed pristine and patched terminal intros; rebuild the locked pristine runtime',
    );
  if (verify) {
    for (const { file, source, next } of plans)
      if (source !== next) throw new Error(`${file}: product terminal intro missing`);
    return [];
  }
  return plans.flatMap(({ file, source, next }) =>
    writeIfChanged(file, source, next) ? [path.relative(root, file)] : [],
  );
}

module.exports = {
  applyPatch: (root, options) => processTargets(root, false, options),
  verifyPatch: (root, options) => processTargets(root, true, options),
  __testing: { CONTRACT, NATIVE_BODY, transform },
};
