'use strict';

// Capability: admit public previews and expose source/completion/replay facts.
// Target: pristine openclaw@2026.10.4 AI completions transport and Agent subscriber.
// Scope: Completions streaming extension; display ownership stays in the Renderer.
// Safety: retain terminal phase/error ownership, tag fallback and durable delivery gates.
// Remove when: native public previews and ownership/replay facts satisfy the audited contract.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { PROVIDER_TRANSPORT_PATH, PROVIDER_PARTITIONER_PATH } =
  require('../../openclaw/openclaw-patch-dependencies.cjs');
const { transformReasoningTagPartitioner } = require('./structured-reasoning-stream.js');
const { transformReasoningPreviewTerminal } =
  require('./reasoning-preview-terminal-shapes.js');
const { transformReasoningTextScope, transformReasoningScopeSnapshot } = require('./reasoning-text-scope-shapes.js');
const {
  assertCurrentPatchContract, findFilesContaining, isGatewayBundlePath, writeIfChanged,
} = require('./_patch-utils.js');
const {
  functionRange, parse, collect, one, same, prepend, assertTargetPaths,
} = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_STRUCTURED_REASONING_TEXT_STREAM_V2026_10_4';
const TRANSPORT = 'processCompletionsStream';
const SUBSCRIBER = 'handleMessageUpdate';
const TERMINAL = 'handleMessageEnd';
const SUBSCRIBER_PATH = 'dist/builtin-openclaw-qVsnLx0N.mjs';

function transformFunction(body, kind, file) {
  const prefix = kind === TRANSPORT ? 'async ' : '';
  const ast = parse(prefix + body);
  const fn = ast.statements[0];
  const text = node => node.getText(ast);
  const edits = [];
  let current = 0;
  let pristine = 0;
  const replace = (node, value) => edits.push({
    start: node.getStart(ast) - prefix.length, end: node.end - prefix.length, value,
  });
  const insert = (at, value) => edits.push({
    start: at - prefix.length, end: at - prefix.length, value: '\n' + value + '\n',
  });
  const variable = name => one(collect(fn,
    node => ts.isVariableDeclaration(node) && text(node.name) === name), `${file}/${name}`);
  const rewrite = (node, original, patched, label) => {
    if (same(text(node), patched)) current++;
    else if (same(text(node), original)) {
      pristine++;
      replace(node, patched);
    } else throw new Error(`${file}: historical or partial ${label}`);
  };
  if (kind === TRANSPORT) {
    if (fn.parameters.length !== 5) throw new Error(`${file}: completions parameters changed`);
    const output = text(fn.parameters[1].name);
    const options = text(fn.parameters[4].name);
    const partitioner = variable('reasoningTagTextPartitioner');
    const streamDeclaration = collect(fn,
      node => ts.isVariableDeclaration(node) && /^streamStructuredText\d*$/.test(text(node.name)));
    const streamName = streamDeclaration.length ? text(one(streamDeclaration, file).name)
      : 'streamStructuredText';
    const policy = `const ${streamName} = ${options}?.strictReasoningTags !== true;`;
    if (streamDeclaration.length) {
      const statement = one(streamDeclaration, file).parent.parent;
      if (canonicalHelper(`function seam(){${text(statement)}}`) !==
          canonicalHelper(`function seam(){${policy}}`))
        throw new Error(`${file}: partial structured stream policy`);
      current++;
    } else {
      pristine++;
      insert(partitioner.parent.parent.end, policy);
    }
    const begin = variable('beginReasoning').initializer;
    if (!ts.isArrowFunction(begin) || !ts.isBlock(begin.body))
      throw new Error(`${file}: reasoning lane boundary changed`);
    const admission = `if (${streamName}) {
      reasoningTagTextPartitioner.markStructured();
      ${output}.openclawDelivery = {
        ...${output}.openclawDelivery, structuredTextStreaming: true,
        messageScopeId: ${output}.openclawDelivery?.messageScopeId ?? globalThis.crypto.randomUUID()
      };
    }`;
    const admissionGuards = collect(begin, ts.isIfStatement)
      .filter(node => same(text(node.expression), streamName));
    if (admissionGuards.length) {
      const guard = one(admissionGuards, file);
      if (begin.body.statements[0] !== guard ||
          canonicalHelper(`function seam(){${text(guard)}}`) !==
            canonicalHelper(`function seam(){${admission}}`))
        throw new Error(`${file}: partial normalized reasoning lane admission`);
      current++;
    } else {
      pristine++;
      insert(begin.body.getStart(ast) + 1, admission);
    }
    const strictGuard = one(collect(begin, ts.isIfStatement).filter(node =>
      collect(node.thenStatement, n => ts.isCallExpression(n) &&
        text(n.expression) === 'reasoningTagTextPartitioner.markStrict').length === 1), file);
    rewrite(strictGuard.expression,
      'forceStrict || reasoningTagTextPartitioner.hasPending()',
      `(forceStrict || reasoningTagTextPartitioner.hasPending()) && !${streamName}`,
      'reasoning strict guard');
    const sealGuard = one(collect(begin, ts.isIfStatement).filter(node =>
      collect(node.thenStatement, n => ts.isCallExpression(n) &&
        text(n.expression) === 'sealTextBeforeReasoning').length === 1), file);
    const following = text(begin.parameters[0].name);
    if (!same(text(sealGuard.expression),
      `!${following} || !reasoningTagTextPartitioner.hasPendingSyntax()`))
      throw new Error(`${file}: historical or partial native reasoning phase boundary`);
    const flush = variable('flushReasoningTagTextPartitioner').initializer;
    if (!ts.isArrowFunction(flush) || !ts.isBlock(flush.body) || flush.parameters.length > 1)
      throw new Error(`${file}: reasoning flush boundary changed`);
    let terminalName = 'terminal';
    if (flush.parameters.length) {
      const parameter = flush.parameters[0];
      terminalName = text(parameter.name);
      if (!/^terminal\d*$/.test(terminalName) || !parameter.initializer ||
          !same(text(parameter.initializer), 'false'))
        throw new Error(`${file}: historical or partial reasoning flush parameter`);
      current++;
    } else {
      pristine++;
      insert(flush.parameters.pos, `${terminalName} = false`);
    }
    const holdPending = `if (!${terminalName} &&
      ${output}.openclawDelivery?.structuredTextStreaming === true &&
      reasoningTagTextPartitioner.hasPendingSyntax()) return;`;
    const flushFirst = flush.body.statements[0];
    if (flushFirst && ts.isIfStatement(flushFirst)) {
      if (canonicalHelper(`function seam(){${text(flushFirst)}}`) !==
          canonicalHelper(`function seam(){${holdPending}}`))
        throw new Error(`${file}: historical or partial pending syntax hold`);
      current++;
    } else {
      pristine++;
      insert(flush.body.getStart(ast) + 1, holdPending);
    }
    const terminalCall = one(fn.body.statements.filter(node =>
      ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      text(node.expression.expression) === 'flushReasoningTagTextPartitioner'), file).expression;
    rewrite(terminalCall, 'flushReasoningTagTextPartitioner()',
      'flushReasoningTagTextPartitioner(true)', 'terminal syntax flush');
    const routed = variable('routedDeltas').initializer;
    const push = ts.isConditionalExpression(routed) ? routed.whenTrue : routed;
    if (!ts.isCallExpression(push) || push.arguments.length !== 1)
      throw new Error(`${file}: content route changed`);
    const argument = text(push.arguments[0]);
    rewrite(routed,
      `hasReasoningThinking ? reasoningTagTextPartitioner.push(${argument}) : reasoningTagTextPartitioner.pushVisible(${argument})`,
      `reasoningTagTextPartitioner.pushVisible(${argument})`, 'normalized public text route');
  } else {
    const message = text(variable('partialAssistant').name);
    const guard = one(collect(fn, ts.isIfStatement).filter(node =>
      same(text(node.expression), 'isReasoningCompletionsText') ||
      same(text(node.expression), `isReasoningCompletionsText && ${message}.openclawDelivery?.structuredTextStreaming !== true`)), file);
    const returns = collect(guard.thenStatement, ts.isReturnStatement);
    if (returns.length !== 1 || collect(guard.thenStatement, ts.isCallExpression).length)
      throw new Error(`${file}: reasoning hold control flow changed`);
    rewrite(guard.expression, 'isReasoningCompletionsText',
      `isReasoningCompletionsText && ${message}.openclawDelivery?.structuredTextStreaming !== true`,
      'reasoning live hold');
    const partial = one(collect(fn, node => ts.isPropertyAssignment(node) &&
      text(node.name) === 'emitPartialReply'), file);
    rewrite(partial.initializer, '!currentSourcePartial.hold',
      '!currentSourcePartial.hold && !isReasoningCompletionsText', 'durable partial gate');
  }
  if (current && pristine) throw new Error(`${file}: partially applied structured reasoning stream`);
  let next = body;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
  return { next, current: pristine === 0 };
}

function transform(source, file = '<runtime>') {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const kinds = [TRANSPORT, SUBSCRIBER].filter(name => source.includes(`function ${name}(`));
  const hasParser = (kinds.includes(TRANSPORT) || !kinds.length) &&
    source.includes('function createReasoningTagTextPartitioner');
  const hasSnapshot = source.includes('function updateChatRunProgressSnapshot(');
  if (!kinds.length && !hasParser && !hasSnapshot) throw new Error(`${file}: structured reasoning boundaries missing`);
  let next = source;
  const states = [];
  for (const kind of kinds) {
    const range = functionRange(next, kind);
    const result = transformFunction(range.text, kind, file);
    states.push(result.current);
    next = next.slice(0, range.start) + result.next + next.slice(range.end);
  }
  if (kinds.includes(SUBSCRIBER)) {
    for (const retract of [transformReasoningPreviewTerminal, transformReasoningTextScope]) {
      const updated = retract(next, file);
      states.push(updated === next);
      next = updated;
    }
  }
  if (hasSnapshot) {
    const updated = transformReasoningScopeSnapshot(next, file);
    states.push(updated === next);
    next = updated;
  }
  if (hasParser) {
    const updated = transformReasoningTagPartitioner(next, file);
    states.push(updated === next);
    next = updated;
  }
  if (states.some(Boolean) && !states.every(Boolean))
    throw new Error(`${file}: mixed structured reasoning boundaries`);
  if (states.every(Boolean)) {
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT)) throw new Error(`${file}: partial structured reasoning marker`);
  return prepend(next, `// ${CONTRACT}\n`);
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const names = [TRANSPORT, SUBSCRIBER, TERMINAL, 'createReplyDelivery', 'updateChatRunProgressSnapshot'];
  const groups = names.map(name => findFilesContaining(root, `function ${name}(`));
  const paths = [PROVIDER_TRANSPORT_PATH, SUBSCRIBER_PATH, SUBSCRIBER_PATH, SUBSCRIBER_PATH,
    'dist/server-chat-state-BP63MB41.mjs'];
  for (const [index, files] of groups.entries())
    assertTargetPaths(root, files, [paths[index], ...bundle], names[index]);
  const plans = [...new Set([...groups.flat(), path.join(root, PROVIDER_PARTITIONER_PATH)])].map(file => {
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, file) };
  });
  const native = plans.filter(plan => !isGatewayBundlePath(plan.file));
  if (native.some(plan => plan.source === plan.next) && native.some(plan => plan.source !== plan.next))
    throw new Error('Mixed pristine and patched structured reasoning sources');
  const built = plans.find(plan => isGatewayBundlePath(plan.file));
  if (built && native.every(plan => plan.source === plan.next) !== (built.source === built.next))
    throw new Error('Source and bundle structured reasoning are partially applied');
  if (verify && plans.some(plan => plan.source !== plan.next))
    throw new Error('Structured reasoning stream patch missing');
  return plans.flatMap(plan => !verify && writeIfChanged(plan.file, plan.source, plan.next)
    ? [path.relative(root, plan.file)] : []);
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, transformFunction, CONTRACT },
};
