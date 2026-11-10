'use strict';

// Capability: retain requester tools after an ordinary top-level ACP child completes.
// Target: pristine openclaw@2026.10.7 omits the ACP child's structural spawn envelope.
// Scope: structural metadata in the disabled-admission branch used by top-level ACP spawn.
// Safety: preserve the early return, all enabled admission checks and strict completion proofs.
// Remove when: native ACP creation persists its structural envelope without enabling nested limits.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { assertCurrentPatchContract, findFilesContaining, isGatewayBundlePath, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same, prepend, assertTargetPaths } = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_ACP_COMPLETION_LINEAGE_V2026_10_7';
const TARGET = 'dist/spawn-thread-binding-CKE2AseF.mjs';
const OWNER = 'resolveSpawnAdmission';

function canonical(body) {
  const result = ts.transform(parse(body), [context => {
    const visit = node => ts.isVariableDeclarationList(node)
      ? ts.factory.createVariableDeclarationList(ts.visitNodes(node.declarations, visit), ts.NodeFlags.Let)
      : ts.visitEachChild(node, visit, context);
    return root => ts.visitNode(root, visit);
  }]);
  try { return canonicalHelper(ts.createPrinter().printFile(result.transformed[0])); }
  finally { result.dispose(); }
}

function transform(source, file = TARGET) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const range = functionRange(source, OWNER);
  const ast = parse(range.text);
  const fn = ast.statements[0];
  if (!ts.isFunctionDeclaration(fn) || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name))
    throw new Error(`${file}: spawn admission parameters changed`);
  const text = node => node.getText(ast);
  const params = text(fn.parameters[0].name);
  const maximum = one(collect(fn, node => ts.isVariableDeclaration(node) &&
    /^maxSpawnDepth\d*$/.test(text(node.name))), `${file}/spawn depth`);
  if (!maximum.initializer || !same(text(maximum.initializer), `${params}.cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 5`))
    throw new Error(`${file}: native spawn depth default changed`);
  const nativeCapabilities = one(collect(fn, node => ts.isVariableDeclaration(node) &&
    /^capabilities\d*$/.test(text(node.name))), `${file}/native capabilities`);
  const call = nativeCapabilities.initializer;
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) ||
      !/^resolveSubagentCapabilities\d*$/.test(text(call.expression)) || call.arguments.length !== 1)
    throw new Error(`${file}: native capability resolver changed`);
  const helper = text(call.expression);
  const guard = one(collect(fn, node => ts.isIfStatement(node) &&
    same(text(node.expression), `${params}.enabled === false`)), `${file}/disabled admission`);
  if (guard.elseStatement || guard.end >= maximum.getStart(ast))
    throw new Error(`${file}: disabled admission no longer returns before depth lookup`);
  const replacement = `{
    const completionCapabilities = ${helper}({ depth: 1, maxSpawnDepth: ${text(maximum.initializer)} });
    return {
      ok: true,
      childSessionPatch: {
        spawnDepth: completionCapabilities.depth,
        subagentRole: completionCapabilities.role === 'main' ? null : completionCapabilities.role,
        subagentControlScope: completionCapabilities.controlScope,
      },
    };
  }`;
  const actual = canonical(`function seam() ${ts.isBlock(guard.thenStatement) ? text(guard.thenStatement) : `{ ${text(guard.thenStatement)} }`}`);
  if (actual === canonical(`function seam() ${replacement}`)) {
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT) || actual !== canonical('function seam() { return { ok: true }; }'))
    throw new Error(`${file}: historical, partial or changed ACP spawn lineage; rebuild pristine runtime`);
  const start = range.start + guard.thenStatement.getStart(ast);
  const end = range.start + guard.thenStatement.end;
  return prepend(source.slice(0, start) + replacement + source.slice(end), `// ${CONTRACT}\n`);
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const files = findFilesContaining(root, `function ${OWNER}(`);
  assertTargetPaths(root, files, [TARGET, ...bundle], 'ACP completion lineage');
  const plans = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, file) };
  });
  if (plans.some(plan => plan.source === plan.next) && plans.some(plan => plan.source !== plan.next))
    throw new Error('Mixed source/bundle ACP completion lineage; rebuild pristine runtime');
  if (verify && plans.some(plan => plan.source !== plan.next)) throw new Error('Native ACP completion lineage missing');
  return verify ? [] : plans.filter(plan => writeIfChanged(plan.file, plan.source, plan.next))
    .map(plan => path.relative(root, plan.file));
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, TARGET, CONTRACT },
};
