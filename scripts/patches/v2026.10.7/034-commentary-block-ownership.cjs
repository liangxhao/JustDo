'use strict';

// Capability: identify complete generic commentary snapshots for application projection.
// Target: pristine openclaw@2026.10.7 has whole-message and mixed-phase block publishers.
// Scope: normalize scoped generic commentary at the shared native delivery boundary.
// Safety: retain complete native extraction, IDs, source/completion, Responses and no-scope paths.
// Remove when: native generic commentary consistently exposes complete message-snapshot facts.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { assertCurrentPatchContract, findFilesContaining, isGatewayBundlePath, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same, prepend, assertTargetPaths } = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_COMMENTARY_BLOCK_OWNERSHIP_V2026_10_7';
const TARGET = 'dist/builtin-openclaw-Ci5YBsOb.mjs';
const OWNER = 'createReplyDelivery';

function canonical(body) {
  // esbuild may lower local const declarations to let. Full-body comparison
  // still proves that none of those bindings are reassigned.
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
  // Reject the withdrawn block-splitting shape. The original publisher and its
  // whole-message sanitization must remain exactly native (plus 028 metadata).
  const publisher = functionRange(source, 'emitAssistantCommentaryStreamData');
  const ast = parse(publisher.text);
  const fn = ast.statements[0];
  if (!ts.isFunctionDeclaration(fn) || fn.parameters.length !== 4) throw new Error(`${file}: commentary parameters changed`);
  const text = node => node.getText(ast);
  const [ctx, message, final, prepared] = fn.parameters.map(parameter => text(parameter.name));
  const callName = name => one(collect(fn, node => ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) && new RegExp(`^${name}\\d*$`).test(text(node.expression))), `${file}/${name}`).expression.getText(ast);
  const responses = callName('isResponsesApiAssistantMessage');
  const scopeBlock = callName('scopeAssistantMessageToStreamBlock');
  const extract = callName('extractAssistantCommentaryText');
  const resolveItem = callName('resolveAssistantStreamItemId');
  const emit = one(collect(fn, node => ts.isCallExpression(node) && text(node.expression) === `${ctx}.emitAssistantStreamData`), file);
  if (emit.arguments.length !== 2) throw new Error(`${file}: commentary publication changed`);
  const options = text(emit.arguments[1]);
  if (!same(options, `({ finalMessage: ${final} })`) &&
      !same(options, `({ finalMessage: ${final}, sourceMessage: ${message}, messageComplete: ${final} })`))
    throw new Error(`${file}: commentary source/completion binding changed`);
  const originalPublisher = `function emitAssistantCommentaryStreamData(${ctx}, ${message}, ${final} = false, ${prepared}) {
    const isResponsesCommentary = ${responses}(${message});
    const { lastAssistantStreamContentIndex: index, lastAssistantStreamItemId: itemId } = ${ctx}.state;
    const commentaryMessage = isResponsesCommentary
      ? ${scopeBlock}(${message}, index, itemId) : ${message};
    const text = !isResponsesCommentary && ${prepared} !== undefined
      ? ${prepared} : ${extract}(commentaryMessage);
    if (text && (${final} || !isResponsesCommentary || ${ctx}.state.deltaBuffer !== text)) {
      const commentaryItemId = isResponsesCommentary ? itemId
        : ${resolveItem}({ message: ${message} });
      ${ctx}.emitAssistantStreamData({ text, delta: '', replace: true, phase: 'commentary', itemId: commentaryItemId }, ${options});
    }
  }`;
  if (canonical(publisher.text) !== canonical(originalPublisher))
    throw new Error(`${file}: historical, partial or changed commentary publisher; rebuild pristine runtime`);
  const range = functionRange(source, OWNER);
  const deliveryAst = parse(range.text);
  const delivery = deliveryAst.statements[0];
  const deliveryText = node => node.getText(deliveryAst);
  const emitter = one(collect(delivery, node => ts.isVariableDeclaration(node) &&
    /^emitAssistantStreamData\d*$/.test(deliveryText(node.name))), `${file}/delivery`).initializer;
  if (!ts.isArrowFunction(emitter) || !ts.isBlock(emitter.body) || emitter.parameters.length !== 2)
    throw new Error(`${file}: commentary delivery boundary changed`);
  const [data, streamOptions] = emitter.parameters.map(parameter => deliveryText(parameter.name));
  const assistantSource = one(collect(emitter.body, node => ts.isVariableDeclaration(node) &&
    /^assistantSource\d*$/.test(deliveryText(node.name))), `${file}/source`);
  const sourceCall = assistantSource.initializer;
  if (!sourceCall || !ts.isCallExpression(sourceCall) || sourceCall.arguments.length !== 1 ||
      !ts.isIdentifier(sourceCall.expression) || !/^readAgentAssistantSource\d*$/.test(deliveryText(sourceCall.expression)) ||
      !ts.isPropertyAccessExpression(sourceCall.arguments[0]) || sourceCall.arguments[0].name.text !== 'lastAssistant')
    throw new Error(`${file}: assistant source capture changed`);
  const state = deliveryText(sourceCall.arguments[0].expression);
  const statements = emitter.body.statements;
  if (canonical(`function seam(){${deliveryText(statements[0])}}`) !==
      canonical(`function seam(){if (${state}.unsubscribed) return;}`))
    throw new Error(`${file}: unsubscribe admission changed`);
  const normalization = `if (${data}.phase === 'commentary' &&
      typeof ${streamOptions}?.sourceMessage?.openclawDelivery?.messageScopeId === 'string' &&
      ${streamOptions}.sourceMessage.openclawDelivery.messageScopeId.length > 0 &&
      !${responses}(${streamOptions}.sourceMessage)) {
    ${data} = { ...${data}, text: ${extract}(${streamOptions}.sourceMessage),
      delta: '', replace: true, commentarySnapshot: 'message' };
  }`;
  const normalizationMatches = collect(emitter.body, node => ts.isBinaryExpression(node) &&
    deliveryText(node.left) === data && collect(node.right, property => ts.isPropertyAssignment(property) &&
      deliveryText(property.name) === 'commentarySnapshot').length > 0);
  const existing = statements[1];
  if (normalizationMatches.length) {
    if (normalizationMatches.length !== 1 || canonical(`function seam(){${deliveryText(existing)}}`) !==
        canonical(`function seam(){${normalization}}`) || statements[2] !== assistantSource.parent.parent)
      throw new Error(`${file}: partial commentary snapshot normalization`);
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT) || existing !== assistantSource.parent.parent)
    throw new Error(`${file}: historical or partial commentary snapshot normalization`);
  const at = range.start + existing.getStart(deliveryAst);
  return prepend(source.slice(0, at) + normalization + '\n' + source.slice(at), `// ${CONTRACT}\n`);
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const files = findFilesContaining(root, `function ${OWNER}(`);
  assertTargetPaths(root, files, [TARGET, ...bundle], 'commentary block publication');
  const plans = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, file) };
  });
  if (plans.some(plan => plan.source === plan.next) && plans.some(plan => plan.source !== plan.next))
    throw new Error('Mixed source/bundle commentary block publication; rebuild pristine runtime');
  if (verify && plans.some(plan => plan.source !== plan.next)) throw new Error('Native commentary block publication missing');
  return verify ? [] : plans.filter(plan => writeIfChanged(plan.file, plan.source, plan.next))
    .map(plan => path.relative(root, plan.file));
}

module.exports = { applyPatch: root => processTargets(root, false), verifyPatch: root => processTargets(root, true),
  __testing: { transform, TARGET, CONTRACT } };
