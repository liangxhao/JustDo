'use strict';

const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { assertCurrentPatchContract, isGatewayBundlePath } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same, prepend } = require('./prepared-read-patch-shapes.js');
const PARSER_CONTRACT = 'RUNTIME_STRUCTURED_REASONING_PARSER_V2026_10_7';

function transformReasoningTagPartitioner(source, file = '<parser>') {
  assertCurrentPatchContract(source, PARSER_CONTRACT, file, false);
  let factoryName = 'createReasoningTagTextPartitioner';
  if (source.includes('function processCompletionsStream(')) {
    const owner = parse('async ' + functionRange(source, 'processCompletionsStream').text);
    const declaration = one(collect(owner, node => ts.isVariableDeclaration(node) &&
      /^reasoningTagTextPartitioner\d*$/.test(node.name.getText(owner))), file + '/partitioner owner');
    if (!ts.isCallExpression(declaration.initializer) ||
        !ts.isIdentifier(declaration.initializer.expression) ||
        !/^createReasoningTagTextPartitioner(?:\d+|\$\d+)?$/.test(declaration.initializer.expression.text))
      throw new Error(file + ': native partitioner owner changed');
    factoryName = declaration.initializer.expression.text;
  }
  const factory = functionRange(source, factoryName);
  const ast = parse(factory.text);
  const fn = ast.statements[0];
  const text = node => node.getText(ast);
  const edits = [];
  let current = 0;
  let pristine = 0;
  const replace = (node, value) => edits.push({ start: node.getStart(ast), end: node.end, value });
  const insert = (at, value) => edits.push({ start: at, end: at, value });
  const rewrite = (node, original, patched, label) => {
    if (same(text(node), patched)) current++;
    else if (same(text(node), original)) { pristine++; replace(node, patched); }
    else throw new Error(file + ': historical or partial ' + label);
  };
  const variable = (pattern, label) => one(collect(fn, node =>
    ts.isVariableDeclaration(node) && pattern.test(text(node.name))), file + '/' + label);
  const strict = variable(/^strictMode\d*$/, 'strict state');
  if (!same(text(strict.initializer), 'false')) throw new Error(file + ': native strict state changed');
  const strictName = text(strict.name);
  const structured = collect(fn, node => ts.isVariableDeclaration(node) &&
    /^structuredRecoveryMode\d*$/.test(text(node.name)));
  let structuredName = 'structuredRecoveryMode';
  if (structured.length) {
    const declaration = one(structured, file + '/structured state');
    structuredName = text(declaration.name);
    if (!same(text(declaration.initializer), 'false')) throw new Error(file + ': partial structured state');
    current++;
  } else {
    pristine++;
    insert(strict.parent.parent.end, '\nlet ' + structuredName + ' = false;\n');
  }
  const calls = collect(fn, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    /^reduceReasoningText(?:\d+|\$\d+)?$/.test(node.expression.text));
  if (calls.length !== 3) throw new Error(file + ': native reducer call topology changed');
  const reducerNames = new Set(calls.map(call => call.expression.text));
  if (reducerNames.size !== 1) throw new Error(file + ': native reducer binding changed');
  for (const [index, call] of calls.entries()) {
    const options = call.arguments[3];
    if (call.arguments.length !== 4 || !ts.isObjectLiteralExpression(options))
      throw new Error(file + ': native reducer options changed');
    const mode = one(options.properties.filter(node => ts.isPropertyAssignment(node) &&
      text(node.name) === 'mode'), file + '/recovery mode');
    rewrite(mode.initializer, index === 0 ? '"visible"' : strictName + ' ? "hide" : "visible"',
      strictName + ' ? "hide" : ' + structuredName + ' ? "structured" : "visible"', 'structured recovery mode');
  }
  const returned = one(fn.body.statements.filter(ts.isReturnStatement), file + '/partitioner surface').expression;
  if (!ts.isObjectLiteralExpression(returned)) throw new Error(file + ': native partitioner return changed');
  const structuredMethod = returned.properties.filter(node => ts.isMethodDeclaration(node) &&
    text(node.name) === 'markStructured');
  const expectedMethod = 'markStructured() {' + structuredName + ' = true;}';
  const methodSame = (actual, expected) =>
    canonicalHelper('function seam(){return {' + actual + '}}') ===
    canonicalHelper('function seam(){return {' + expected + '}}');
  if (structuredMethod.length) {
    const method = one(structuredMethod, file + '/structured method');
    if (!methodSame(text(method), expectedMethod)) throw new Error(file + ': partial structured method');
    current++;
  } else {
    pristine++;
    insert(returned.properties.pos, expectedMethod + ',\n');
  }
  const strictMethod = one(returned.properties.filter(node => ts.isMethodDeclaration(node) &&
    text(node.name) === 'markStrict'), file + '/native strict method');
  const hold = variable(/^holdStart\d*$/, 'native hold state');
  const emitted = variable(/^emitted\d*$/, 'native emitted state');
  const expectedStrict = 'markStrict(){' + strictName + '=true;' +
    text(hold.name) + '??=' + text(emitted.name) + ';}';
  if (!methodSame(text(strictMethod), expectedStrict)) throw new Error(file + ': native strict method changed');

  const reducerName = [...reducerNames][0];
  const reducer = functionRange(source, reducerName);
  const reducerAst = parse(reducer.text);
  const reducerFn = reducerAst.statements[0];
  if (reducerFn.parameters.length !== 4) throw new Error(file + ': native reducer parameters changed');
  const optionsName = reducerFn.parameters[3].name.getText(reducerAst);
  const orphanOriginal = optionsName + '.mode === "visible"';
  const orphanPatched = orphanOriginal + ' || ' + optionsName + '.mode === "structured"';
  const orphan = one(collect(reducerFn, ts.isIfStatement).filter(node =>
    same(node.expression.getText(reducerAst), orphanOriginal) ||
    same(node.expression.getText(reducerAst), orphanPatched)), file + '/orphan close policy');
  const reducerEdits = [];
  if (same(orphan.expression.getText(reducerAst), orphanPatched)) current++;
  else {
    pristine++;
    reducerEdits.push({ start: orphan.expression.getStart(reducerAst),
      end: orphan.expression.end, value: orphanPatched });
  }
  const inputName = reducerFn.parameters[0].name.getText(reducerAst);
  const spansName = reducerFn.parameters[1].name.getText(reducerAst);
  const start = one(collect(reducerFn, node => ts.isVariableDeclaration(node) &&
    /^start\d*$/.test(node.name.getText(reducerAst))), file + '/reducer start');
  const startName = start.name.getText(reducerAst);
  const scan = one(collect(reducerFn, node => ts.isVariableDeclaration(node) &&
    /^scan\d*$/.test(node.name.getText(reducerAst))), file + '/reducer scan');
  if (!ts.isCallExpression(scan.initializer) || !ts.isIdentifier(scan.initializer.expression) ||
      !/^scanReasoningTags(?:\d+|\$\d+)?$/.test(scan.initializer.expression.text))
    throw new Error(file + ': native reasoning scanner changed');
  const scannerName = scan.initializer.expression.text;
  if (!same(start.initializer.getText(reducerAst), optionsName + '.start ?? 0') ||
      !same(scan.initializer.getText(reducerAst), scannerName + '(' + inputName +
        '.slice(' + startName + '), ' + optionsName + '.final)'))
    throw new Error(file + ': native reasoning scan coordinates changed');
  // Non-final scanning identifies unfinished known/potential reasoning tags.
  // At EOF only structured recovery drops them; parser-owned code stays literal.
  const eofCondition = optionsName + '.final && ' + optionsName + '.mode === "structured"';
  const eofGuard = `if (${eofCondition}) {
    let structuredScanOffset = ${startName};
    while (structuredScanOffset < ${inputName}.length) {
      const pendingSyntax = ${scannerName}(${inputName}.slice(structuredScanOffset), false).pendingStart;
      if (pendingSyntax === undefined) break;
      const pendingSyntaxIndex = structuredScanOffset + pendingSyntax;
      const codeRegion = ${spansName}.find(([codeStart, codeEnd]) =>
        pendingSyntaxIndex >= codeStart && pendingSyntaxIndex < codeEnd);
      if (codeRegion) structuredScanOffset = codeRegion[1];
      else {
        ${inputName} = ${inputName}.slice(0, pendingSyntaxIndex);
        break;
      }
    }
  }`;
  const eofGuards = collect(reducerFn, ts.isIfStatement).filter(node =>
    same(node.expression.getText(reducerAst), eofCondition));
  if (eofGuards.length) {
    const guard = one(eofGuards, file + '/structured EOF guard');
    const scanStatement = scan.parent.parent;
    const scanIndex = reducerFn.body.statements.indexOf(scanStatement);
    if (reducerFn.body.statements[scanIndex - 1] !== guard ||
        canonicalHelper('function seam(){' + guard.getText(reducerAst) + '}') !==
          canonicalHelper('function seam(){' + eofGuard + '}'))
      throw new Error(file + ': historical or partial structured EOF guard');
    current++;
  } else {
    pristine++;
    const at = scan.parent.parent.getStart(reducerAst);
    reducerEdits.push({ start: at, end: at, value: eofGuard + '\n' });
  }
  const recover = one(collect(reducerFn, ts.isIfStatement).filter(node =>
    collect(node.expression, value => ts.isStringLiteral(value) &&
      value.text === 'static-preserve').length > 0), file + '/unclosed recovery');
  const pending = one(collect(reducerFn, node => ts.isVariableDeclaration(node) &&
    /^pending\d*$/.test(node.name.getText(reducerAst))), file + '/pending reasoning');
  const pendingName = pending.name.getText(reducerAst);
  const recovery = '(' + optionsName + '.mode === "static-preserve" || ' + optionsName +
    '.mode === "static-strict" && !' + pendingName + '.visibleBefore && !' + pendingName +
    '.protectedClose || ' + optionsName + '.mode === "visible" && !' + pendingName + '.protectedClose) && ' +
    optionsName + '.recoverUnclosed !== false';
  if (!same(recover.expression.getText(reducerAst), recovery))
    throw new Error(file + ': native unclosed reasoning recovery changed');
  if (current && pristine) throw new Error(file + ': partially applied structured reasoning parser');
  if (!pristine) {
    assertCurrentPatchContract(source, PARSER_CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(PARSER_CONTRACT)) throw new Error(file + ': partial structured parser marker');
  let factoryNext = factory.text;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    factoryNext = factoryNext.slice(0, edit.start) + edit.value + factoryNext.slice(edit.end);
  let reducerNext = reducer.text;
  for (const edit of reducerEdits.sort((left, right) => right.start - left.start))
    reducerNext = reducerNext.slice(0, edit.start) + edit.value + reducerNext.slice(edit.end);
  let next = source;
  for (const range of [{ ...factory, next: factoryNext }, { ...reducer, next: reducerNext }]
    .sort((left, right) => right.start - left.start))
    next = next.slice(0, range.start) + range.next + next.slice(range.end);
  return prepend(next, '// ' + PARSER_CONTRACT + '\n');
}

module.exports = { transformReasoningTagPartitioner, PARSER_CONTRACT };
