'use strict';

// Capability: keep manually opened MCP Apps on the session's actual runtime workspace.
// Target: pristine openclaw@2026.10.7 manual App preparation ignores persisted session cwd.
// Scope: manual MCP App extension runtime workspace selection and its current-owner fingerprint.
// Safety: reuse native ingress resolution; retain sharing, harness, sandbox, grant and session checks.
// Remove when: upstream manual Apps use the same persisted workspace resolution as session runs.
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

const CONTRACT = 'RUNTIME_MCP_APP_SESSION_WORKSPACE_V2026_10_7';
const HELPER = 'resolveIngressWorkspaceOverrideForSessionRun';
const IMPORT = `import { r as ${HELPER} } from "./spawned-context-CVsYdkyH.mjs";`;
const NATIVE = 'dist/mcp-app-extensions-abaft4XG.mjs';

function assertHelper(source, file) {
  if (isGatewayBundlePath(file)) {
    const ast = parse(functionRange(source, HELPER).text);
    const fn = ast.statements[0];
    const param = fn.parameters[0]?.name.getText(ast);
    const normalized = fn.body.statements[0]?.declarationList?.declarations[0]?.name.getText(ast);
    const expected = `function ${HELPER}(${param}) {
      const ${normalized} = normalizeSpawnedRunMetadata(${param});
      if (${normalized}.spawnedBy && ${normalized}.workspaceDir) return ${normalized}.workspaceDir;
      return normalizeOptionalString(${param}?.cwd);
    }`;
    if (!param || !normalized || !same(fn.getText(ast), expected))
      throw new Error(`${file}: native ingress workspace helper changed`);
    return;
  }
  const ast = parse(source);
  const imports = ast.statements.filter(
    node =>
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(element => element.name.text === HELPER),
  );
  if (one(imports, file).getText(ast) !== IMPORT)
    throw new Error(`${file}: ingress workspace import changed`);
}

function transform(source, file = NATIVE) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const edits = [];
  let current = 0;
  const range = functionRange(source, 'prepareMcpAppExtensionRuntime');
  const ast = parse('async ' + range.text);
  const fn = ast.statements[0];
  const declaration = one(
    collect(
      fn,
      node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'workspaceDir',
    ),
    file,
  );
  const expression = declaration.initializer.getText(ast);
  const fallback = expression.match(/resolveAgentWorkspaceDir\((\w+),\s*(\w+)\)$/)?.[0];
  const target = expression.match(/\b(\w+)\.entry\.spawnedWorkspaceDir\b/)?.[1];
  if (!target || !fallback) throw new Error(`${file}: manual App workspace topology changed`);
  const original = `${target}.entry.spawnedWorkspaceDir ?? ${fallback}`;
  const expected = `${HELPER}({ spawnedBy: ${target}.entry.spawnedBy, workspaceDir: ${target}.entry.spawnedWorkspaceDir, cwd: ${target}.entry.spawnedCwd }) ?? ${fallback}`;
  if (same(expression, expected)) current++;
  else if (same(expression, original))
    edits.push({
      start: range.start - 6 + declaration.initializer.getStart(ast),
      end: range.start - 6 + declaration.initializer.end,
      text: expected,
    });
  else throw new Error(`${file}: partial manual App workspace selection`);

  const selection = functionRange(source, 'runtimeSelection');
  const selectionAst = parse(selection.text);
  const selectionFn = selectionAst.statements[0];
  const entry = selectionFn.parameters[0]?.name.getText(selectionAst);
  const array = one(collect(selectionFn, ts.isArrayLiteralExpression), file);
  const originalFields = [
    `resolveSessionPinnedHarnessId(${entry})`,
    'model.provider',
    'model.model',
    'harnessId',
    ...[
      'agentRuntimeOverride',
      'modelSelectionLocked',
      'providerOverride',
      'modelOverride',
      'authProfileOverride',
      'authProfileOverrideSource',
      'sandboxMode',
    ].map(field => `${entry}.${field}`),
  ];
  const workspaceFields = ['spawnedBy', 'spawnedWorkspaceDir', 'spawnedCwd'].map(
    field => `${entry}.${field}`,
  );
  const originalArray = `[${originalFields.join(',')}]`;
  const expectedArray = `[${[...originalFields, ...workspaceFields].join(',')}]`;
  if (same(array.getText(selectionAst), expectedArray)) current++;
  else if (same(array.getText(selectionAst), originalArray))
    edits.push({
      start: selection.start + array.getStart(selectionAst),
      end: selection.start + array.end,
      text: expectedArray,
    });
  else throw new Error(`${file}: partial manual App owner fingerprint`);
  if (current && edits.length) throw new Error(`${file}: partially applied manual App workspace`);
  if (current === 2) {
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    assertHelper(source, file);
    return source;
  }
  if (source.includes(CONTRACT) || (!isGatewayBundlePath(file) && source.includes(HELPER)))
    throw new Error(`${file}: partial manual App workspace marker/import`);
  let next = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  if (!isGatewayBundlePath(file)) next = prepend(next, IMPORT + '\n');
  else assertHelper(next, file);
  return prepend(next, `// ${CONTRACT}\n`);
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const files = findFilesContaining(root, 'function prepareMcpAppExtensionRuntime(');
  assertTargetPaths(root, files, [NATIVE, ...bundle], 'manual App workspace');
  const plans = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, file) };
  });
  if (
    plans.some(plan => plan.source === plan.next) &&
    plans.some(plan => plan.source !== plan.next)
  )
    throw new Error('Source and bundle manual App workspace are partially applied');
  if (verify && plans.some(plan => plan.source !== plan.next))
    throw new Error('Manual App session workspace missing');
  return plans.flatMap(plan =>
    !verify && writeIfChanged(plan.file, plan.source, plan.next)
      ? [path.relative(root, plan.file)]
      : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT, HELPER, NATIVE },
};
