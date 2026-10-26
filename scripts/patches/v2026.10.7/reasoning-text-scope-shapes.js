'use strict';

const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { functionRange, parse, collect, one, same } = require('./prepared-read-patch-shapes.js');

// Project native message facts only. Display ownership and rollback decisions
// belong to the authenticated consumer; no publisher receipts or queue exist.
function editor(source, name, file, states) {
  const range = functionRange(source, name);
  const ast = parse(range.text);
  const fn = ast.statements[0];
  const text = node => node.getText(ast);
  const edits = [];
  const canonical = value => canonicalHelper(`function seam(){${value}}`);
  return {
    fn, ast, text,
    variable: name => one(collect(fn, node => ts.isVariableDeclaration(node) &&
      new RegExp(`^${name}\\d*$`).test(text(node.name))), `${file}/${name}`),
    replace(node, before, after) {
      const equivalent = ts.isIfStatement(node) ? (a, b) => canonical(a) === canonical(b) : same;
      if (equivalent(text(node), after)) states.push(true);
      else if (equivalent(text(node), before)) {
        states.push(false);
        edits.push({ start: node.getStart(ast), end: node.end, value: after });
      } else throw new Error(`${file}: historical or partial ${name} scope projection`);
    },
    before(statement, value, existing) {
      if (existing) {
        const statements = statement.parent.statements;
        if (statements[statements.indexOf(statement) - 1] !== existing || canonical(text(existing)) !== canonical(value))
          throw new Error(`${file}: partial ${name} scope capture`);
        states.push(true);
      } else {
        states.push(false);
        edits.push({ start: statement.getStart(ast), end: statement.getStart(ast), value: value + '\n' });
      }
    },
    insert(at, value) { edits.push({ start: at, end: at, value }); },
    finish() {
      let next = range.text;
      for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
        next = next.slice(0, edit.start) + edit.value + next.slice(edit.end);
      return source.slice(0, range.start) + next + source.slice(range.end);
    },
  };
}

function transformReasoningTextScope(source, file = '<runtime>') {
  if (source.includes('withAssistantPublicationBatch') || source.includes('pendingAgentPublications') ||
      source.includes('retainedCommentaryItemIds'))
    throw new Error(`${file}: historical reasoning receipts/publication batch; rebuild pristine runtime`);
  const states = [];
  let next = source;
  for (const [name, count] of [['handleMessageUpdate', 2], ['handleMessageEnd', 2], ['emitAssistantCommentaryStreamData', 1]]) {
    const edit = editor(next, name, file, states);
    const { fn, text } = edit;
    const ctx = text(fn.parameters[0].name);
    const message = name === 'emitAssistantCommentaryStreamData' ? text(fn.parameters[1].name)
      : name === 'handleMessageEnd' ? text(edit.variable('assistantMessage').name) : text(edit.variable('msg').name);
    const complete = name === 'handleMessageEnd' ? 'true' : name === 'emitAssistantCommentaryStreamData'
      ? text(fn.parameters[2].name) : null;
    const calls = collect(fn, node => ts.isCallExpression(node) && text(node.expression) === `${ctx}.emitAssistantStreamData`);
    if (calls.length !== count) throw new Error(`${file}: ${name} scope call topology changed`);
    for (const call of calls) {
      if (call.arguments.length !== 2 || !ts.isObjectLiteralExpression(call.arguments[1]))
        throw new Error(`${file}: native stream options changed`);
      const options = call.arguments[1];
      const metadata = options.properties.filter(node => node.name &&
        ['sourceMessage', 'messageComplete'].includes(text(node.name)));
      const expected = `sourceMessage: ${message}${complete ? `, messageComplete: ${complete}` : ''}`;
      if (metadata.length) {
        if (!same(`({${metadata.map(text).join(',')}})`, `({${expected}})`))
          throw new Error(`${file}: partial source message scope options`);
        // The dedicated terminal-buffer guard already owns its exact shape.
        const data = call.arguments[0];
        if (name !== 'handleMessageEnd' || !ts.isObjectLiteralExpression(data) ||
            !data.properties.some(node => ts.isPropertyAssignment(node) && text(node.name) === 'text' &&
              ts.isStringLiteral(node.initializer) && node.initializer.text === '')) states.push(true);
      } else {
        states.push(false);
        edit.insert(options.properties[options.properties.length - 1].end, `, ${expected}`);
      }
    }
    next = edit.finish();
  }
  const edit = editor(next, 'createReplyDelivery', file, states);
  const { fn, text } = edit;
  const stream = edit.variable('emitAssistantStreamData').initializer;
  const data = text(stream.parameters[0].name);
  const options = text(stream.parameters[1].name);
  const within = name => one(collect(stream, node => ts.isVariableDeclaration(node) &&
    text(node.name) === name && node.parent.parent.parent === stream.body), `${file}/${name}`);
  const eventData = text(within('eventData').name);
  const delivery = within('delivery');
  const parserRange = functionRange(next, 'resolveAssistantStreamItemId');
  const parserAst = parse(parserRange.text);
  const parser = one(collect(parserAst, node => ts.isCallExpression(node) &&
    /^parseAssistantTextSignature\d*$/.test(node.expression.getText(parserAst))), file).expression.getText(parserAst);
  const capture = `const streamSourceMessage = ${options}?.sourceMessage;
    if (typeof streamSourceMessage?.openclawDelivery?.messageScopeId === 'string' &&
        streamSourceMessage.openclawDelivery.messageScopeId.length > 0 &&
        (${eventData} || ${options}?.messageComplete === true)) {
      ${eventData} = { ...(${eventData} ?? { ...${data}, text: raw.text,
        delta: '', itemId: ${text(edit.variable('assistantItemId').name)} }),
        ...(${options}?.messageComplete === true ? { replace: true } : {}), assistantTextScope: {
        id: streamSourceMessage.openclawDelivery.messageScopeId,
        ...(${data}.phase === 'commentary' && ${data}.commentarySnapshot === 'message'
          ? { commentarySnapshot: 'message' } : {}),
        ...(${options}?.messageComplete === true && Array.isArray(streamSourceMessage.content)
          ? { commentaryItemIds: streamSourceMessage.content.flatMap(block => {
              const signature = ${parser}(block);
              return signature?.phase === 'commentary' && typeof signature.id === 'string' ? [signature.id] : [];
            }) } : {})
      } };
    }`;
  const captures = collect(stream, node => ts.isVariableDeclaration(node) && text(node.name) === 'streamSourceMessage');
  if (captures.length) {
    const declaration = one(captures, file).parent.parent;
    const statement = delivery.parent.parent;
    const statements = statement.parent.statements;
    const at = statements.indexOf(statement);
    if (statements[at - 2] !== declaration || canonicalHelper(`function seam(){${text(declaration)}${text(statements[at - 1])}}`) !==
        canonicalHelper(`function seam(){${capture}}`)) throw new Error(`${file}: partial delivery scope capture`);
    states.push(true);
  } else {
    states.push(false);
    edit.insert(delivery.parent.parent.getStart(edit.ast), capture + '\n');
  }
  const preamble = one(collect(fn, node => ts.isObjectLiteralExpression(node) && node.properties.some(property =>
    ts.isPropertyAssignment(property) && text(property.name) === 'kind' &&
    ts.isStringLiteral(property.initializer) && property.initializer.text === 'preamble')), file);
  const metadata = preamble.properties.filter(node => node.name && text(node.name) === 'assistantTextScope');
  if (metadata.length) {
    if (!same(`({${text(one(metadata, file))}})`, `({assistantTextScope: ${eventData}.assistantTextScope})`))
      throw new Error(`${file}: partial preamble scope projection`);
    states.push(true);
  } else {
    states.push(false);
    edit.insert(preamble.properties[preamble.properties.length - 1].end,
      `, assistantTextScope: ${eventData}.assistantTextScope`);
  }
  if (states.some(Boolean) && !states.every(Boolean)) throw new Error(`${file}: partially applied message scope facts`);
  return edit.finish();
}

function transformReasoningScopeSnapshot(source, file = '<runtime>') {
  const states = [];
  const edit = editor(source, 'updateChatRunProgressSnapshot', file, states);
  const { text, fn } = edit;
  const event = text(fn.parameters[1].name);
  const snapshot = text(fn.parameters[0].name);
  const data = text(edit.variable('data').name);
  const assistant = edit.variable('isAssistant');
  const originalAssistant = `${event}.stream === 'assistant' && Boolean(${snapshot}?.events.some((candidate) => candidate.stream === 'run_status'))`;
  const scope = `const ownedTextSnapshot = {
    active: ${event}.stream === 'assistant' && typeof ${data}.itemId === 'string' && ${data}.itemId.length > 0 &&
      typeof ${data}.text === 'string',
    previousScope: ${event}.stream === 'assistant' ? ${snapshot}?.events.find(candidate =>
      candidate.stream === 'assistant' && candidate.data.itemId === ${data}.itemId)?.data.assistantTextScope : undefined
  };`;
  const captures = collect(fn, node => ts.isVariableDeclaration(node) && text(node.name) === 'ownedTextSnapshot');
  edit.before(assistant.parent.parent, scope, captures.length ? one(captures, file).parent.parent : null);
  edit.replace(assistant.initializer, originalAssistant, `(${originalAssistant}) || ownedTextSnapshot.active`);
  const removals = one(collect(fn, node => ts.isIfStatement(node) &&
    collect(node.expression, child => ts.isPropertyAccessExpression(child) && text(child.name) === 'stream').length >= 2 && collect(node.expression, child =>
      ts.isStringLiteral(child) && child.text === 'run_status').length === 1 &&
    text(node.thenStatement) === 'return true;'), `${file}/snapshot replacement`);
  const candidate = text(collect(removals.expression, node =>
    ts.isPropertyAccessExpression(node) && text(node.name) === 'stream')[0].expression);
  edit.replace(removals.expression,
    `${candidate}.stream === 'run_status' || ${candidate}.stream === 'assistant'`,
    `${candidate}.stream === 'run_status' || ${candidate}.stream === 'assistant' &&
      (${candidate}.data.assistantTextSnapshot === true ? ownedTextSnapshot.active && ${candidate}.data.itemId === ${data}.itemId : true)`);
  const stored = edit.variable('storedData');
  const conditional = one(collect(stored.initializer, node => ts.isConditionalExpression(node) &&
    text(node.condition) === text(assistant.name)), file);
  const storedAssistant = `ownedTextSnapshot.active ? {
    assistantTextSnapshot: true, itemId: ${data}.itemId, text: ${data}.text, replace: true,
    assistantTextScope: ${data}.assistantTextScope ?? ownedTextSnapshot.previousScope
  } : {}`;
  edit.replace(conditional.whenTrue, '{}', storedAssistant);
  const preamble = one(collect(conditional.whenFalse, node => ts.isObjectLiteralExpression(node) &&
    node.properties.some(property => ts.isPropertyAssignment(property) && text(property.name) === 'kind' &&
      ts.isStringLiteral(property.initializer) && property.initializer.text === 'preamble')), file);
  const field = preamble.properties.filter(node => node.name && text(node.name) === 'assistantTextScope');
  if (field.length) {
    if (!same(`({${text(one(field, file))}})`, `({assistantTextScope: ${data}.assistantTextScope})`))
      throw new Error(`${file}: partial snapshot preamble scope`);
    states.push(true);
  } else {
    states.push(false);
    edit.insert(preamble.properties[preamble.properties.length - 1].end, `, assistantTextScope: ${data}.assistantTextScope`);
  }
  const capture = edit.variable('captured');
  const failed = one(collect(fn, node => ts.isIfStatement(node) && text(node.expression) === '!captured'), file);
  const fallback = `if (!captured && ownedTextSnapshot.active) {
    delete storedData.text;
    captured = captureProgressEvent(storedEvent);
  }`;
  const fallbacks = collect(fn, node => ts.isIfStatement(node) && text(node.expression) === '!captured && ownedTextSnapshot.active');
  edit.before(failed, fallback, fallbacks.length ? one(fallbacks, file) : null);
  edit.replace(failed, 'if (!captured) return next;', `if (!captured) {
    if (typeof ${data}.assistantTextScope?.id === 'string') removeWhere(candidate =>
      candidate.data?.assistantTextScope?.id === ${data}.assistantTextScope.id);
    return next;
  }`);
  const oldest = edit.variable('oldestToolCallId');
  const eviction = one(collect(oldest.parent.parent.parent, node => ts.isCallExpression(node) &&
    text(node.expression) === 'removeWhere'), `${file}/snapshot eviction`);
  edit.replace(eviction.arguments[0],
    `(candidate) => oldestToolCallId ? (candidate.stream === 'tool' || candidate.stream === 'item') && candidate.data?.toolCallId === oldestToolCallId : candidate === oldest`,
    `(candidate) => typeof oldest.data?.assistantTextScope?.id === 'string'
      ? candidate.data?.assistantTextScope?.id === oldest.data.assistantTextScope.id
      : oldestToolCallId ? (candidate.stream === 'tool' || candidate.stream === 'item') && candidate.data?.toolCallId === oldestToolCallId : candidate === oldest`);
  if (states.some(Boolean) && !states.every(Boolean)) throw new Error(`${file}: partially applied scope snapshot projection`);
  // Ensure the captured record is still the native bounded/frozen event path.
  if (!text(capture.initializer).startsWith('captureProgressEvent(')) throw new Error(`${file}: snapshot capture changed`);
  return edit.finish();
}

module.exports = { transformReasoningTextScope, transformReasoningScopeSnapshot };
