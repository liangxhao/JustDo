'use strict';

// Capability: finish canonical readiness against the reader's admitted database owner.
// Target: pristine openclaw@2026.10.4 canonical deferral and validation receipt.
// Scope: use the captured native identity filename instead of SQLite's Windows namespace alias.
// Safety: explicit paths, agent identity, physical generation and revocation checks remain native.
// Remove when: upstream uses its admitted filename at both canonical-read fallback boundaries.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');
const {
  functionRange,
  parse,
  collect,
  one,
  same,
  prepend,
  assertTargetPaths,
} = require('./prepared-read-patch-shapes.js');
const CONTRACT = 'RUNTIME_CANONICAL_READINESS_OWNER_PATH_V2026_10_4';
const NAMES = ['deferCanonicalSessionValidation', 'canonicalValidationReceipt'];

function transform(source, file = '<runtime>') {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const edits = [];
  let current = 0;
  for (const name of NAMES) {
    if (!source.includes(`function ${name}(`)) continue;
    const range = functionRange(source, name);
    const ast = parse(range.text);
    const fn = ast.statements[0];
    const database = fn.parameters[0]?.name.getText(ast);
    if (!database || fn.parameters.length !== 1)
      throw new Error(`${file}: canonical owner parameters changed`);
    const declaration = one(
      collect(fn, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'pathname'),
      name,
    );
    let identity;
    if (name === 'deferCanonicalSessionValidation') {
      const peer = functionRange(source, 'assertCanonicalSqliteSessionKeysCurrent').text;
      identity = one(
        [
          ...new Set(
            [...peer.matchAll(/\b(findOpenClawAgentDatabaseIdentity\d*)\(/g)].map(m => m[1]),
          ),
        ],
        name,
      );
      if (
        !/\b\w+\.pending/.test(range.text) ||
        !range.text.includes('CanonicalSessionValidationDeferred')
      )
        throw new Error(`${file}: canonical deferral ownership changed`);
    } else {
      identity = one(
        [
          ...new Set(
            [...range.text.matchAll(/\b(findOpenClawAgentDatabaseIdentity\d*)\(/g)].map(m => m[1]),
          ),
        ],
        name,
      );
      if (!range.text.includes('matchesValidation') || !range.text.includes('.isOpen'))
        throw new Error(`${file}: canonical receipt admission changed`);
    }
    const prefix = name === 'canonicalValidationReceipt' ? `${database}.path ?? ` : '';
    const original = `${prefix}${database}.db.location()`;
    const expected = `${prefix}${identity}(${database})?.filename ?? ${database}.db.location()`;
    const actual = declaration.initializer.getText(ast);
    if (same(actual, expected)) {
      current++;
      continue;
    }
    if (!same(actual, original))
      throw new Error(`${file}: historical or partial canonical readiness path`);
    edits.push({
      start: range.start + declaration.initializer.getStart(ast),
      end: range.start + declaration.initializer.end,
      text: expected,
    });
  }
  if (current + edits.length === 0)
    throw new Error(`${file}: canonical readiness boundary missing`);
  if (current && edits.length)
    throw new Error(`${file}: partially applied canonical readiness path`);
  if (current) {
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT)) throw new Error(`${file}: partial canonical readiness marker`);
  let next = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return prepend(next, `// ${CONTRACT}\n`);
}

function processTargets(root, verify) {
  const bundlePaths = fs.existsSync(path.join(root, 'gateway-bundle.mjs'))
    ? ['gateway-bundle.mjs']
    : [];
  const groups = NAMES.map(name => findFilesContaining(root, `function ${name}(`));
  const worker = 'dist/state/openclaw-state-read.worker.js';
  const nativePaths = [
    ['dist/session-canonical-key-D1TSJMmX.mjs', worker],
    ['dist/openclaw-agent-db-validation-cache-_HDeZNQr.mjs', worker],
  ];
  for (const [index, files] of groups.entries())
    assertTargetPaths(root, files, [...nativePaths[index], ...bundlePaths], NAMES[index]);
  const files = [...new Set(groups.flat())];
  const plans = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, file) };
  });
  const native = plans.filter(p => !isGatewayBundlePath(p.file));
  if (
    native.some(p => p.source.includes(CONTRACT)) &&
    native.some(p => !p.source.includes(CONTRACT))
  )
    throw new Error('Mixed pristine and patched canonical readiness paths');
  const bundle = plans.find(p => isGatewayBundlePath(p.file));
  if (bundle && native.every(p => p.source.includes(CONTRACT)) !== (bundle.source === bundle.next))
    throw new Error('Source and bundle canonical readiness are partially applied');
  if (verify && plans.some(p => p.source !== p.next))
    throw new Error('Canonical readiness owner path missing');
  return plans.flatMap(p =>
    !verify && writeIfChanged(p.file, p.source, p.next) ? [path.relative(root, p.file)] : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT },
};
