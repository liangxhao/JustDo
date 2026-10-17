'use strict';

const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { functionRange, parse, collect, one, same } = require('./prepared-read-patch-shapes.js');

// A preview is replaceable UI state. Native commentary/error/tool classification
// still owns final delivery, so retract only that message's assistant preview.
function transformReasoningPreviewTerminal(source, file = '<runtime>') {
  const range = functionRange(source, 'handleMessageEnd');
  const ast = parse(range.text);
  const fn = ast.statements[0];
  const text = node => node.getText(ast);
  if (!ts.isFunctionDeclaration(fn) || fn.parameters.length !== 2) {
    throw new Error(`${file}: reasoning preview terminal parameters changed`);
  }
  const ctx = text(fn.parameters[0].name);
  const assistant = one(collect(fn, node => ts.isVariableDeclaration(node) &&
    text(node.name) === 'assistantMessage'), `${file}/terminal assistant`);
  const message = text(assistant.name);
  const branch = one(collect(fn, ts.isIfStatement).filter(node =>
    same(text(node.expression), 'suppressVisibleAssistantOutput')),
  `${file}/commentary terminal branch`);
  if (!ts.isBlock(branch.thenStatement)) {
    throw new Error(`${file}: commentary terminal block changed`);
  }
  const commentary = one(collect(branch.thenStatement, node => ts.isCallExpression(node) &&
    text(node.expression) === 'emitAssistantCommentaryStreamData'),
  `${file}/commentary terminal emission`);
  if (!same(text(commentary), `emitAssistantCommentaryStreamData(${ctx}, ${message}, true)`)) {
    throw new Error(`${file}: commentary terminal emission changed`);
  }
  const expected = `if (${message}.openclawDelivery?.structuredTextStreaming === true) {
    ${ctx}.emitAssistantStreamData(
      { text: '', delta: '', replace: true },
      { finalMessage: true, emitPartialReply: false }
    );
  }`;
  const metadata = collect(fn, node => ts.isPropertyAccessExpression(node) &&
    text(node.name) === 'structuredTextStreaming');
  if (metadata.length) {
    const guard = one(collect(branch.thenStatement, ts.isIfStatement).filter(node =>
      same(text(node.expression), `${message}.openclawDelivery?.structuredTextStreaming === true`)),
    `${file}/reasoning preview terminal guard`);
    const statements = branch.thenStatement.statements;
    const commentaryIndex = statements.indexOf(commentary.parent);
    if (metadata.length !== 1 || statements[commentaryIndex - 1] !== guard ||
      canonicalHelper(`function seam(){${text(guard)}}`) !==
      canonicalHelper(`function seam(){${expected}}`)) {
      throw new Error(`${file}: historical or partial reasoning preview terminal retraction`);
    }
    return source;
  }
  const at = commentary.parent.getStart(ast);
  const patched = range.text.slice(0, at) + expected + '\n' + range.text.slice(at);
  return source.slice(0, range.start) + patched + source.slice(range.end);
}

module.exports = { transformReasoningPreviewTerminal };
