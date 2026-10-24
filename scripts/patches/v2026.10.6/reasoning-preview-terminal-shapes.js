'use strict';

const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { functionRange, parse, collect, one } = require('./prepared-read-patch-shapes.js');

function transformReasoningPreviewTerminal(source, file = '<runtime>') {
  const range = functionRange(source, 'handleMessageEnd');
  const ast = parse(range.text);
  const fn = ast.statements[0];
  const text = node => node.getText(ast);
  const call = one(collect(fn, node => ts.isCallExpression(node) &&
    text(node.expression) === 'emitAssistantCommentaryStreamData'), file);
  const [ctx, message] = call.arguments.map(text);
  const condition = `typeof ${message}.openclawDelivery?.messageScopeId === 'string' &&
    ${message}.openclawDelivery.messageScopeId.length > 0`;
  const guard = `if (${condition}) {
    ${ctx}.emitAssistantStreamData({ text: '', delta: '', replace: true },
      { finalMessage: true, emitPartialReply: false, sourceMessage: ${message}, messageComplete: true });
  }`;
  const current = collect(fn, node => ts.isIfStatement(node) &&
    canonicalHelper(`function seam(){if (${text(node.expression)}) {}}`) ===
      canonicalHelper(`function seam(){if (${condition}) {}}`));
  if (current.length) {
    if (canonicalHelper(`function seam(){${text(one(current, file))}}`) !==
        canonicalHelper(`function seam(){${guard}}`)) throw new Error(`${file}: partial terminal buffer reconciliation`);
    return source;
  }
  if (range.text.includes('withAssistantPublicationBatch') || range.text.includes('structuredTextStreaming') ||
      range.text.includes('messageScopeId'))
    throw new Error(`${file}: historical reasoning preview transfer; rebuild pristine runtime`);
  const at = call.parent.getStart(ast);
  return source.slice(0, range.start) + range.text.slice(0, at) + guard + '\n' +
    range.text.slice(at) + source.slice(range.end);
}

module.exports = { transformReasoningPreviewTerminal };
