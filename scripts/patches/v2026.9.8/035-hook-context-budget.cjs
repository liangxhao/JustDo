'use strict';

// Capability: expose the resolved native attempt budget to prompt-build hooks.
// Target: pristine openclaw@2026.9.8 prepareEmbeddedAttemptPromptAssembly prompt hook context.
// Scope: read-only metadata; do not change model resolution or context guards.
// Safety: report the existing resolved attempt budget without altering admission or model policy.
// Remove when: upstream populates PluginHookAgentContext.contextTokenBudget.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');
const CONTRACT = 'JUSTDO_HOOK_CONTEXT_BUDGET_V2026_9_8';
const signature = 'function prepareEmbeddedAttemptPromptAssembly(';

function transform(source, file = '<runtime>') {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const start = source.indexOf(signature);
  if (start < 0 || source.indexOf(signature, start + 1) >= 0)
    throw new Error(`${file}: prompt assembly topology changed`);
  const paren = source.indexOf('(', start);
  const close = findMatchingDelimiter(source, paren, '(', ')', file);
  const open = source.indexOf('{', close);
  const end = findMatchingDelimiter(source, open, '{', '}', file);
  const body = source.slice(start, end + 1);
  const ast = ts.createSourceFile(
    'assembly.js',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const candidates = [];
  const visit = node => {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(p => p.name?.getText(ast) === 'modelProviderId')
    )
      candidates.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (candidates.length !== 1) throw new Error(`${file}: native prompt hook context changed`);
  const object = candidates[0];
  const properties = name => object.properties.filter(p => p.name?.getText(ast) === name);
  const provider = properties('modelProviderId');
  const model = properties('modelId');
  if (
    provider.length !== 1 ||
    model.length !== 1 ||
    !ts.isPropertyAssignment(provider[0]) ||
    !ts.isPropertyAssignment(model[0])
  )
    throw new Error(`${file}: native model identity changed`);
  const providerText = provider[0].initializer.getText(ast).replace(/\s+/g, '');
  const attempt = providerText.match(/^([\w$]+)\.model\.provider$/)?.[1];
  if (!attempt || model[0].initializer.getText(ast).replace(/\s+/g, '') !== `${attempt}.model.id`)
    throw new Error(`${file}: native attempt identity changed`);
  const fields = properties('contextTokenBudget');
  const expected = `${attempt}.contextTokenBudget`;
  if (fields.length) {
    if (
      fields.length !== 1 ||
      !ts.isPropertyAssignment(fields[0]) ||
      fields[0].initializer.getText(ast).replace(/\s+/g, '') !== expected
    )
      throw new Error(`${file}: historical or partial hook context budget`);
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT))
    throw new Error(`${file}: partial hook budget patch; rebuild pristine runtime`);
  const position = start + provider[0].getStart(ast);
  const patched =
    source.slice(0, position) + `contextTokenBudget: ${expected},\n` + source.slice(position);
  const headerEnd = patched.startsWith('#!') ? patched.indexOf('\n') + 1 : 0;
  return patched.slice(0, headerEnd) + `// ${CONTRACT}\n` + patched.slice(headerEnd);
}

function processTargets(root, verify) {
  const files = findFilesContaining(root, signature);
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 5 : 4;
  if (files.length !== expected)
    throw new Error(`Hook context budget topology changed: ${files.length}, expected ${expected}`);
  const changes = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    const next = transform(source, file);
    if (verify && next !== source) throw new Error(`${file}: hook context budget patch missing`);
    return { file, source, next };
  });
  return changes.flatMap(({ file, source, next }) =>
    !verify && writeIfChanged(file, source, next) ? [path.relative(root, file)] : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT },
};
