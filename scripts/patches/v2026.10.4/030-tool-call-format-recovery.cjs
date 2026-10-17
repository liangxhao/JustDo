'use strict';

// Capability: bounded continuation after an atomic, completed pre-dispatch rejection.
// Target: locked openclaw@2026.10.4 Completions producer, attempt receipts and run owners.
// Scope: initial native model candidate, current transcript, two added requests.
// Safety: whole-batch zero dispatch, exact settlement, existing writer and abort fences.
// Remove when: upstream provides the same producer proof and exclusive continuation.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  readRuntimeTextFile,
  writeIfChanged,
  nativeSupportModule,
  nativeSupportImport,
  isGatewayBundlePath,
  findMatchingDelimiter,
} = require('./_patch-utils.js');
const {
  canonicalHelper,
  nodes,
  parseNativeSource: parse,
  oneNativeNode: one,
  extractNativeFunction,
  editNativeSource: edit,
  verifyNativeSupportBindings,
} = require('../../openclaw/native-support-contract.cjs');
const { resolveNativeProviderTransportArtifact } = require('../../openclaw/verify-openclaw-pristine-contracts.cjs');

// The capability has one patch entry. These private transforms only connect
// audited native owners; facts and retry policy remain in Runtime Services.
const DIAGNOSTIC_TYPE = 'tool_call_pre_dispatch_rejection';
const ERROR_CODE = 'malformed_tool_call_arguments';
const extractFunction = (source, name) => extractNativeFunction(source, name, findMatchingDelimiter, true);
const properties = (object, key) => object.properties.filter(node => node.name?.getText() === key);
const assignments = (root, owner, key) =>
  nodes(
    root,
    node =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.getText() === owner &&
      node.left.name.text === key,
  );
function equivalent(actual, expected, parameters, label) {
  const wrap = body => `function evidence(${parameters.join(',')}) {return (${body});}`;
  if (canonicalHelper(wrap(actual)) !== canonicalHelper(wrap(expected)))
    throw new Error(`${label}: historical or partial recovery producer`);
}
function finalizerPlan({ fn, ast, body }) {
  if (fn.parameters.length !== 2) throw new Error('Tool finalizer parameters changed');
  const [output, options] = fn.parameters.map(node => node.name.getText(ast));
  const reject = one(
    nodes(
      fn,
      node =>
        ts.isArrowFunction(node) &&
        ts.isBlock(node.body) &&
        assignments(node.body, output, 'stopReason').some(set => ts.isStringLiteralLike(set.right) && set.right.text === 'error'),
    ),
    'tool rejection',
  );
  const parse = one(
    nodes(
      fn,
      node => ts.isCallExpression(node) && /^finalizeTerminalToolCallArguments(?:\$\d+|\d+)?$/.test(node.expression.getText(ast)),
    ),
    'atomic argument validation',
  );
  const confirmed = one(
    nodes(
      fn,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'onConfirmedToolCall',
    ),
    'confirmed callback',
  );
  const catches = nodes(fn, ts.isCatchClause);
  if (
    parse.getStart(ast) >= confirmed.getStart(ast) ||
    catches.length !== 1 ||
    parse.getStart(ast) >= catches[0].getStart(ast) ||
    confirmed.getStart(ast) <= catches[0].end
  )
    throw new Error('Atomic validation no longer precedes every confirmed callback');
  const code = assignments(reject.body, output, 'errorCode');
  const diagnostics = assignments(reject.body, output, 'diagnostics');
  const expectedCode = `${output}.errorCode = ${JSON.stringify(ERROR_CODE)}`;
  const expectedDiagnostics = `${output}.diagnostics = [...(${output}.diagnostics ?? []), {type:${JSON.stringify(DIAGNOSTIC_TYPE)}, timestamp:Date.now(), details:{batchRejected:true, streamComplete:${options}.terminalStreamComplete === true, dispatchCount:0}}]`;
  if (code.length || diagnostics.length || body.includes(DIAGNOSTIC_TYPE)) {
    equivalent(one(code, 'rejection error code').getText(ast), expectedCode, [output, options], 'rejection error code');
    equivalent(one(diagnostics, 'rejection diagnostic').getText(ast), expectedDiagnostics, [output, options], 'rejection diagnostic');
    return { current: true };
  }
  return { current: false, at: reject.body.statements.pos, text: `${expectedCode};${expectedDiagnostics};` };
}
function streamPlan({ fn, ast, body }) {
  const invoke = one(
    nodes(
      fn,
      node => ts.isCallExpression(node) && /^finalizeOpenAICompletionsToolCalls(?:\$\d+|\d+)?$/.test(node.expression.getText(ast)),
    ),
    'stream finalizer',
  );
  const object = invoke.arguments[1];
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('Stream finalizer options changed');
  const promotion = one(properties(object, 'allowSilentToolCallPromotion'), 'silent promotion');
  const finish = one(
    nodes(
      promotion,
      node =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isStringLiteralLike(node.right) &&
        node.right.text === 'stop' &&
        ts.isIdentifier(node.left),
    ),
    'native finish reason',
  ).left.getText(ast);
  const options = fn.parameters[4]?.name.getText(ast);
  if (!options || !body.includes('Stream ended without finish_reason')) throw new Error('Complete-stream boundary changed');
  const expected = `(typeof ${finish} === "string" && ${finish}.length > 0) || ${options}?.sawStreamDONE?.() === true`;
  const existing = properties(object, 'terminalStreamComplete');
  if (existing.length) {
    const current = one(existing, 'complete-stream evidence');
    if (!ts.isPropertyAssignment(current)) throw new Error('Complete-stream evidence must be explicit');
    equivalent(current.initializer.getText(ast), expected, [finish, options], 'complete-stream evidence');
    return { current: true };
  }
  if (body.includes('terminalStreamComplete')) throw new Error('Partial complete-stream evidence');
  return { current: false, at: object.properties.pos, text: `terminalStreamComplete:${expected},` };
}
function validateCandidateFlow({ fn }) {
  const callback = one(nodes(fn, node => ts.isPropertyAssignment(node) && node.name.getText() === 'runCandidate'), 'native candidate callback').initializer;
  if (!ts.isArrowFunction(callback) || callback.parameters.length !== 3 || !ts.isIdentifier(callback.parameters[2].name))
    throw new Error('Native candidate callback arguments changed');
  const options = callback.parameters[2].name.getText();
  const common = one(nodes(callback.body, node => ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer) &&
    node.initializer.properties.length > 0 && ts.isSpreadAssignment(node.initializer.properties[0]) &&
    node.initializer.properties[0].expression.getText() === options), 'native candidate common');
  const embedded = call(callback.body, 'runEmbeddedFallbackCandidate').arguments[0];
  for (const [object, owner] of [[common.initializer, options], [embedded, common.name.getText()]]) {
    if (!object || !ts.isObjectLiteralExpression(object) || !ts.isSpreadAssignment(object.properties[0]) ||
      object.properties[0].expression.getText() !== owner || object.properties.slice(1).some(node =>
        ts.isSpreadAssignment(node) || !node.name || ts.isComputedPropertyName(node.name) ||
        (ts.isStringLiteralLike(node.name) ? node.name.text : node.name.getText()) === 'modelRoutingProvenance'))
      throw new Error('Historical or partial native candidate provenance flow');
  }
  if (nodes(callback.body, node => ts.isIdentifier(node) && node.text === common.name.getText() && node !== common.name &&
    !(ts.isSpreadAssignment(node.parent) && node.parent.expression === node)).length)
    throw new Error('Native candidate common escapes spread custody');
}
function candidatePlan({ fn, ast }) {
  const key = 'isFinalFallbackAttempt';
  const object = one(
    nodes(fn, node => ts.isObjectLiteralExpression(node) && properties(node, key).length === 1),
    'candidate provenance owner',
  );
  const origin = one(properties(object, key), 'candidate boundary').initializer;
  if (!origin || !ts.isPropertyAccessExpression(origin) || origin.expression.getText() !== one(fn.parameters, 'embedded candidate input').name.getText())
    throw new Error('Candidate routing source changed');
  const owner = origin.expression.getText(ast);
  const existing = properties(object, 'modelRoutingProvenance');
  if (existing.length) {
    const current = one(existing, 'candidate routing provenance');
    if (!ts.isPropertyAssignment(current) || current !== object.properties.at(-1))
      throw new Error('Historical or partial candidate routing provenance order');
    equivalent(current.initializer.getText(ast), `${owner}.modelRoutingProvenance`, [owner], 'candidate routing provenance');
    return { current: true };
  }
  const comma = object.properties.length && !object.properties.hasTrailingComma ? ',' : '';
  return { current: false, at: object.properties.end, text: `${comma}modelRoutingProvenance:${owner}.modelRoutingProvenance,` };
}
function transformParts(source, file, names, plan, options) {
  const parts = names.map(name => extractFunction(source, name));
  if (parts.every(part => !part)) return source;
  if (parts.some(part => !part)) throw new Error(`${file}: partial recovery producer topology`);
  const plans = parts.map(plan);
  if (plans.every(item => item.current)) return source;
  if (plans.some(item => item.current)) throw new Error(`${file}: historical or partial recovery producer`);
  if (options.verifyOnly) throw new Error(`${file}: recovery producer is not applied`);
  return edit(
    source,
    parts.map((part, index) => ({ start: part.start + plans[index].at, end: part.start + plans[index].at, text: plans[index].text })),
  );
}
const transformProducer = (source, file, options = {}) => transformParts(source, file,
  ['finalizeOpenAICompletionsToolCalls', 'processCompletionsStream'],
  (part, index) => (index === 0 ? finalizerPlan(part) : streamPlan(part)), options);
function transformCandidate(source, file, options = {}) {
  const parts = ['runAgentFallbackCandidates', 'runEmbeddedFallbackCandidate'].map(name => extractFunction(source, name));
  if (parts.every(part => !part)) return source;
  if (parts.some(part => !part)) throw new Error(`${file}: partial native candidate topology`);
  validateCandidateFlow(parts[0]);
  return transformParts(source, file, ['runEmbeddedFallbackCandidate'], candidatePlan, options);
}

const CONTRACT = 'TOOL_CALL_FORMAT_RECOVERY_V2026_10_4';
const NATIVE_REFERENCES = ['emitAgentEvent', 'emitDiagnosticsTimelineEvent', 'isEmbeddedRunTerminalInterrupted',
  'recordModelFallbackStop', 'isRunRetryBudgetExhausted', 'recordRunRetry'];
const callNamed = (node, name) =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && new RegExp(`^${name}(?:\\$\\d+|\\d+)?$`).test(node.expression.text);
const select = (root, predicate, label) => one(nodes(root, predicate), label);
const call = (root, name) => select(root, node => callNamed(node, name), name);
const statement = node => {
  while (node && !ts.isStatement(node)) node = node.parent;
  if (!node) throw new Error('Recovery statement owner changed');
  return node;
};

// 10.4 ships one unminified owner. Audit its local bindings instead of adapting
// renamed historical workers; global esbuild aliases are resolved separately.
function transformLoop(source, native) {
  const ast = parse(source);
  const fn = one(ast.statements.filter(ts.isFunctionDeclaration), 'runner');
  const input = one(fn.parameters.slice(1), 'runner input').name.getText();
  const bindings = new Set(
    nodes(
      fn,
      node =>
        ts.isIdentifier(node) &&
        (ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent) || ts.isParameter(node.parent)) &&
        node.parent.name === node,
    ).map(node => node.text),
  );
  for (const name of `params runRetryBudget sessionPromptState normalizedAttempt normalization assertAdmittedActive
    effectiveModel pluginHarnessOwnsTransport refusal thinkLevel emptyErrorRetries overloadProfileRotations
    lastRetryFailoverReason bootstrapPromptWarningSignaturesSeen lastRunPromptUsage accumulatedReplayState`.split(/\s+/))
    if (!bindings.has(name)) throw new Error(name + ': native binding changed');
  const initial = `(params.modelRoutingProvenance?.stage === "initial" &&
      params.modelRoutingProvenance?.selectionChanged !== true &&
      !pluginHarnessOwnsTransport && effectiveModel.api === "openai-completions")`;
  const observation = `const toolCallRecoveryFacts = observeToolCallRecoveryAttempt(normalization.dispatchedAttempt.rawAttempt, toolCallRecoveryState.excluded, params.runId);
toolCallRecoveryState.excluded = toolCallRecoveryFacts.excluded;
const toolCallRecoveryControlBlock = normalization.dispatchedAttempt.rawAttempt.terminal?.source === "hook:before_agent_run";
if (toolCallRecoveryFacts.rejected && ${initial} && !toolCallRecoveryControlBlock) toolCallRecoveryState.claimed = true;
const toolCallRecoveryHandled = !toolCallRecoveryControlBlock && (toolCallRecoveryState.claimed || (toolCallRecoveryFacts.rejected && ${initial}));
if (toolCallRecoveryFacts.rejected && ${initial} && !toolCallRecoveryControlBlock && normalizedAttempt.action === "proceed") {
  const toolCallRecoveryDecision = resolveToolCallRecovery({
    rejected: toolCallRecoveryFacts.rejected, streamComplete: toolCallRecoveryFacts.streamComplete,
    initialCandidate: ${initial}, allToolsSettled: toolCallRecoveryFacts.allToolsSettled,
    excluded: toolCallRecoveryState.excluded || Boolean(refusal), hasVisibleText: toolCallRecoveryFacts.hasVisibleText,
    commentaryOnly: toolCallRecoveryFacts.commentaryOnly, dispatchCount: toolCallRecoveryFacts.dispatchCount,
    attempts: toolCallRecoveryState.attempts, aborted: ${input}.laneController.abortSignal.aborted ||
      normalizedAttempt.terminalState.signalOwnedInterruption ||
      ${native.isEmbeddedRunTerminalInterrupted}(normalizedAttempt.terminalState.outcome)
  });
  const toolCallRecoveryBudgetAvailable = !${native.isRunRetryBudgetExhausted}(runRetryBudget);
  ${native.emitDiagnosticsTimelineEvent}({ type: "mark", name: "model.recovery.decision", runId: params.runId,
    attributes: { decision: toolCallRecoveryDecision.action === "retry" && toolCallRecoveryBudgetAvailable ? "accepted" : "rejected",
      reason: TOOL_CALL_RECOVERY_REASON, detail: toolCallRecoveryDecision.action === "retry" && !toolCallRecoveryBudgetAvailable ? "run_budget_exhausted" : toolCallRecoveryDecision.reason,
      retryAttempt: toolCallRecoveryState.attempts, maxRetries: TOOL_CALL_RECOVERY_LIMIT,
      allToolsProvenSettled: toolCallRecoveryFacts.allToolsSettled,
      dispatchCount: toolCallRecoveryFacts.dispatchCount } }, { config: params.config });
  if (toolCallRecoveryDecision.action === "retry" && toolCallRecoveryBudgetAvailable) {
    ${input}.laneController.throwIfAborted();
    assertAdmittedActive();
    bootstrapPromptWarningSignaturesSeen = normalizedAttempt.bootstrapPromptWarningSignaturesSeen;
    lastRunPromptUsage = normalizedAttempt.lastRunPromptUsage;
    accumulatedReplayState = normalizedAttempt.replayState;
    toolCallRecoveryState.attempts += 1;
    toolCallRecoveryState.claimed = true;
    sessionPromptState.markOwnedTranscriptRetry();
    sessionPromptState.activateInternalPrompt(toolCallRecoveryDecision.instruction);
    ${native.recordRunRetry}(runRetryBudget, "recovery");
    const toolCallRecoveryEvent = { stream: "lifecycle", data: {
      phase: "progress", stage: "retrying", reason: TOOL_CALL_RECOVERY_REASON,
      retryAttempt: toolCallRecoveryState.attempts, maxRetries: TOOL_CALL_RECOVERY_LIMIT, at: Date.now()
    }};
    ${native.emitAgentEvent}({ runId: params.runId, sessionKey: params.sessionKey, ...toolCallRecoveryEvent });
    await params.onAgentEvent?.(toolCallRecoveryEvent);
    ${input}.laneController.throwIfAborted();
    assertAdmittedActive();
    continue;
  }
}`;
  const changes = [];
  const replace = (node, text) => changes.push({ start: node.getStart(), end: node.end, text });
  const insert = (at, text) => changes.push({ start: at, end: at, text: '\n' + text });
  insert(
    statement(call(fn, 'createRunRetryBudget')).end,
    'const toolCallRecoveryState = { attempts: 0, excluded: false, claimed: false };',
  );
  insert(statement(call(fn, 'normalizeEmbeddedRunAttempt')).end, observation);
  const refresh = select(
    fn,
    node =>
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'continueAfterAttempt',
    'runtime refresh',
  );
  replace(refresh, `!toolCallRecoveryState.claimed && (${refresh.getText()})`);
  for (const name of ['recoverEmbeddedRunAttempt', 'handleEmbeddedAssistantFailure']) {
    const invocation = call(fn, name);
    if (!ts.isAwaitExpression(invocation.parent)) throw new Error(`${name}: expected await`);
    const result =
      name === 'recoverEmbeddedRunAttempt'
        ? '({ action: "proceed" })'
        : '({action: "proceed", thinkLevel, authRetryPending: false, emptyErrorRetries, overloadProfileRotations, lastRetryFailoverReason, assistantProfileFailureReason: null})';
    replace(invocation.parent, `toolCallRecoveryHandled ? ${result} : (${invocation.parent.getText()})`);
  }
  for (const name of ['prepareTerminalWithSettledTurnFinalization', 'resolveEmbeddedRunTerminal']) {
    const arg = call(fn, name).arguments[0];
    if (!ts.isObjectLiteralExpression(arg)) throw new Error(`${name}: expected input`);
    insert(arg.getStart() + 1, 'toolCallRecoveryHandled,');
  }
  const dispatchCatch = select(
    fn,
    node => ts.isCatchClause(node) && node.block.getText().includes('recoverThrownHarnessAuthFailure'),
    'dispatch catch',
  );
  insert(
    dispatchCatch.block.getStart() + 1,
    `if (toolCallRecoveryState.claimed) throw ${dispatchCatch.variableDeclaration.name.getText()};`,
  );
  const outer = select(
    fn,
    node =>
      ts.isTryStatement(node) && node.finallyBlock && nodes(node.finallyBlock, item => callNamed(item, 'settleEmbeddedRun')).length === 1,
    'runner settlement',
  );
  if (outer.catchClause) throw new Error('Runner settlement already has catch');
  insert(outer.getStart(), 'try {');
  insert(
    outer.end,
    `} catch (toolCallRecoveryError) {
 if (toolCallRecoveryState.claimed) {
 const toolCallRecoveryFailure = toolCallRecoveryError instanceof Error ? toolCallRecoveryError : new Error(String(toolCallRecoveryError), { cause: toolCallRecoveryError });
 ${native.recordModelFallbackStop}(toolCallRecoveryFailure);
 throw toolCallRecoveryFailure;
 }
 throw toolCallRecoveryError;
}`,
  );
  const retryLimit = call(fn, 'handleRetryLimitExhaustion');
  const message = one(
    retryLimit.arguments[0].properties.filter(node => node.name?.getText() === 'message'),
    'retry limit message',
  );
  const messageText = ts.isShorthandPropertyAssignment(message) ? message.name.getText() : message.initializer.getText();
  insert(statement(retryLimit).getStart(), `if (toolCallRecoveryState.claimed) throw new Error(${messageText});`);
  return edit(source, changes);
}

function transformFinalization(source) {
  const ast = parse(source);
  const fn = one(ast.statements.filter(ts.isFunctionDeclaration), 'finalization');
  const request = call(fn, 'resolveSettledTurnFinalizationRequest');
  const input = fn.parameters[0].name.getText();
  return edit(source, [{
    start: request.getStart(),
    end: request.end,
    text: `${input}.toolCallRecoveryHandled ? null : (${request.getText()})`,
  }]);
}

function transformNestedReceipt(source, receiptOwner) {
  const ast = parse(source);
  const fn = one(ast.statements.filter(ts.isFunctionDeclaration), 'nested receipt owner');
  const input = one(fn.parameters, 'nested receipt input').name.getText();
  const completed = call(fn, 'completeEmbeddedAttemptResult');
  const result = one(nodes(fn, node => ts.isVariableDeclaration(node) && node.initializer === completed), 'completed attempt result').name.getText();
  for (const name of ['attempt', 'sessionRuntime', 'toolBase', 'sessionManager', 'nestedToolActivityState', 'abortable'])
    if (!nodes(fn, node => ts.isBindingElement(node) && (node.propertyName ?? node.name).getText() === name).length)
      throw new Error(`${name}: nested receipt binding changed`);
  const read = call(one([receiptOwner?.fn].filter(Boolean), 'native accepted receipt reader'), 'readAttemptNestedToolActivity').expression.getText();
  const cleanup = select(fn, node => ts.isTryStatement(node) && node.finallyBlock && nodes(node.finallyBlock, item => callNamed(item, 'cleanupEmbeddedAttemptStreamExecution')).length === 1, 'native attempt cleanup');
  const text = `
const toolCallRecoveryNestedState = ${input}.prepared.toolBase.nestedToolActivityState;
if (toolCallRecoveryNestedState.accepted && ${input}.attempt.model.api === "openai-completions") {
  toolCallRecoveryNestedEvidence = null;
  try {
    const toolCallRecoveryNestedScope = {runId: ${input}.attempt.runId, sessionId: ${input}.prepared.sessionRuntime.sessionManager.getSessionId(), scopeId: toolCallRecoveryNestedState.scopeId};
    const toolCallRecoveryNestedActivities = await ${input}.preparedStreamRuntime.abortable(${read}(${input}.prepared.sessionRuntime.sessionManager, toolCallRecoveryNestedState));
    toolCallRecoveryNestedEvidence = projectToolCallRecoveryNestedEvidence(toolCallRecoveryNestedScope,
      ${input}.preparedStreamRuntime.stream.subscription.toolMetas, toolCallRecoveryNestedActivities);
  } catch {}
}`;
  return edit(source, [
    { start: fn.body.statements.pos, end: fn.body.statements.pos, text: 'let toolCallRecoveryNestedEvidence;\n' },
    { start: cleanup.tryBlock.statements.end, end: cleanup.tryBlock.statements.end, text },
    { start: statement(completed).end, end: statement(completed).end, text: `\n${result}.toolCallRecoveryNestedEvidence = toolCallRecoveryNestedEvidence;` },
  ]);
}

function transformTerminal(source) {
  const ast = parse(source);
  const fn = one(ast.statements.filter(ts.isFunctionDeclaration), 'terminal');
  const input = one(fn.parameters, 'terminal input').name.getText();
  const silent = call(fn, 'shouldTreatEmptyAssistantReplyAsSilent');
  const incomplete = call(fn, 'resolveIncompleteTurnPayloadText');
  const delivery = call(fn, 'resolveSourceReplyDelivery');
  const complete = nodes(fn, node => callNamed(node, 'completeEmbeddedRun')).at(-1);
  if (!complete) throw new Error('Terminal completion owner changed');
  const branch = `if (${input}.toolCallRecoveryHandled) {
    ${input}.sessionPromptState.clearCompactionContinuation();
    const toolCallRecoveryRejectedDraft = Boolean(${input}.attempt.beforeAgentFinalizeRevisionReason);
    const toolCallRecoveryRevisionBlocked = toolCallRecoveryRejectedDraft && !terminalInterrupted && !signalOwnedInterruption &&
      !${input}.attempt.clientToolCalls && !${input}.attempt.yieldDetected && !${input}.attempt.didSendDeterministicApprovalPrompt;
    const toolCallRecoveryIncompleteText = toolCallRecoveryRevisionBlocked ? "Agent response was rejected by the finalization hook after tool-call format recovery." : emptyAssistantReplyIsSilent || ${delivery.getText()} !== "missing" ? null : ${incomplete.getText()};
    const toolCallRecoveryCompletion = await ${complete.expression.getText()}({ ...${input}, payloadCount, payloadsForTerminalPath,
      emptyAssistantReplyIsSilent, intentionalTerminalCompletion,
      ...(toolCallRecoveryRejectedDraft ? { payloadCount: 0, payloadsForTerminalPath: undefined,
        finalAssistantVisibleText: undefined, finalAssistantRawText: undefined,
        emptyAssistantReplyIsSilent: false, intentionalTerminalCompletion: false } : {}),
      ...(toolCallRecoveryIncompleteText ? { incompleteTurnText: toolCallRecoveryIncompleteText } : {}), incompleteTurnFallbackSafe: false });
    toolCallRecoveryCompletion.result.meta.modelFallbackStopReason ??= "tool_call_format_recovery";
    return toolCallRecoveryCompletion;
  }`;
  return edit(source, [{ start: statement(silent).end, end: statement(silent).end, text: '\n' + branch }]);
}

// Remove only this capability's additions, regenerate from native owners and
// compare the entire function. Markers never establish a complete patch.
function restoreNative(source) {
  const own = node => nodes(node, item => ts.isIdentifier(item) && /^toolCallRecovery/.test(item.text)).length > 0;
  const result = ts.transform(parse(source), [
    context => {
      const visit = node => {
        if (ts.isVariableStatement(node)) {
          const declarations = node.declarationList.declarations.filter(item => !/^toolCallRecovery/.test(item.name.getText()));
          if (!declarations.length) return undefined;
          node = ts.factory.updateVariableStatement(
            node,
            node.modifiers,
            ts.factory.updateVariableDeclarationList(node.declarationList, declarations),
          );
        }
        if ((ts.isIfStatement(node) || ts.isExpressionStatement(node)) && own(node.expression)) return undefined;
        if (ts.isConditionalExpression(node) && own(node.condition)) {
          const branch = node.whenFalse;
          return ts.visitNode(ts.isParenthesizedExpression(branch) ? branch.expression : branch, visit);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && own(node.left)) {
          const branch = node.right;
          return ts.visitNode(ts.isParenthesizedExpression(branch) ? branch.expression : branch, visit);
        }
        if (ts.isObjectLiteralExpression(node))
          node = ts.factory.updateObjectLiteralExpression(
            node,
            node.properties.filter(item => item.name?.getText() !== 'toolCallRecoveryHandled'),
          );
        if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration?.name.getText() === 'toolCallRecoveryError') {
          const inner = node.tryBlock.statements;
          if (node.finallyBlock || inner.length !== 1 || !ts.isTryStatement(inner[0]) || !inner[0].finallyBlock)
            throw new Error('Historical or partial recovery settlement boundary; rebuild pristine runtime');
          return ts.visitNode(inner[0], visit);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return root => ts.visitNode(root, visit);
    },
  ]);
  try {
    return ts.createPrinter({ removeComments: false }).printFile(result.transformed[0]);
  } finally {
    result.dispose();
  }
}

function nativeReferences(source, loopSource) {
  const loop = parse(loopSource);
  const names = (root, name) => [...new Set(nodes(root, node => callNamed(node, name)).map(node => node.expression.getText()))];
  const owner = name => extractFunction(source, one(names(loop, name), `${name} owner`))?.ast ?? loop;
  const recovery = owner('recoverEmbeddedRunAttempt');
  const review = owner('createProviderReviewRun');
  return Object.fromEntries(
    NATIVE_REFERENCES.map(name => {
      const origin =
        name === 'recordModelFallbackStop' ? review : ['recordRunRetry', 'isRunRetryBudgetExhausted'].includes(name) ? loop : recovery;
      const candidates = names(origin, name);
      if (candidates.length > 1) throw new Error(`${name}: ambiguous native recovery binding`);
      return [name, candidates[0] ?? name];
    }),
  );
}

function transformRunner(source, file = '<runtime>', { verifyOnly = false } = {}) {
  const changes = [];
  const transforms = {
    runPreparedEmbeddedLoop: transformLoop,
    prepareTerminalWithSettledTurnFinalization: transformFinalization,
    resolveEmbeddedRunTerminal: transformTerminal,
    runEmbeddedAttemptSettledPhase: body => transformNestedReceipt(body, extractFunction(source, 'completeEmbeddedAttemptAfterTurn')),
  };
  for (const [name, transform] of Object.entries(transforms)) {
    const part = extractFunction(source, name);
    if (!part) continue;
    if (!/\basync\s+$/.test(source.slice(0, part.start))) throw new Error(`${name}: async owner changed`);
    const current = 'async ' + part.body;
    const applied = current.includes('toolCallRecovery');
    const native = applied ? restoreNative(current) : current;
    const references = name === 'runPreparedEmbeddedLoop' ? nativeReferences(source, current) : undefined;
    const expected = transform(native, references);
    if (applied && canonicalHelper(current) !== canonicalHelper(expected))
      throw new Error(`${file}: historical or partial ${name} format recovery`);
    if (verifyOnly && !applied) throw new Error(`${file}: missing ${name} format recovery`);
    if (!applied) changes.push({ start: part.start, end: part.end, text: expected.replace(/^async\s+/, '') });
  }
  return edit(source, changes);
}


const SUPPORT = [
  {
    source: 'policy.mjs',
    target: 'tool-call-recovery-policy.mjs',
    names: ['resolveToolCallRecovery', 'TOOL_CALL_RECOVERY_LIMIT', 'TOOL_CALL_RECOVERY_REASON'],
  },
  { source: 'facts.mjs', target: 'tool-call-recovery-facts.mjs', names: ['observeToolCallRecoveryAttempt', 'projectToolCallRecoveryNestedEvidence'] },
];
const supportSource = (root, entry) => path.join(root, 'openclaw-extensions/runtime-services/tool-call-recovery', entry.source);
function transformResultTypes(source, verifyOnly = false) {
  const before =
    'modelFallbackStopReason?: "agent_run_terminal_timeout" | "idle_timeout_circuit_breaker" | "provider_review_continuation";';
  const after = before.replace(';', ' | "tool_call_format_recovery";');
  if (source.split('modelFallbackStopReason?:').length !== 2) throw new Error('Recovery result type owner changed');
  if (source.split(after).length === 2 && source.split('"tool_call_format_recovery"').length === 2) return source;
  if (verifyOnly || source.split(before).length !== 2 || source.includes('tool_call_format_recovery'))
    throw new Error('Historical or partial recovery result type; rebuild pristine runtime');
  return source.replace(before, after);
}
function verifyBundledSupport(source, repoRoot) {
  for (const entry of SUPPORT) {
    verifyNativeSupportBindings(source, fs.readFileSync(supportSource(repoRoot, entry), 'utf8'), findMatchingDelimiter,
      { module: entry.target, owner: 'embedded-agent-DOz9dy-9.mjs' });
    if (entry.source === 'facts.mjs' && extractFunction(source, 'runEmbeddedAttemptSettledPhase'))
      verifyNativeSupportBindings(source, fs.readFileSync(supportSource(repoRoot, entry), 'utf8'), findMatchingDelimiter,
        { module: entry.target, owner: 'builtin-openclaw-qVsnLx0N.mjs' });
  }
}
function bindSupport(source, file, verifyOnly, entries = SUPPORT) {
  if (isGatewayBundlePath(file)) return source;
  for (const entry of entries) {
    const module = JSON.stringify(nativeSupportImport(file, entry.target));
    const declaration = `import { ${entry.names.join(', ')} } from ${module};`;
    if (source.includes(declaration)) continue;
    if (verifyOnly || source.includes(`native-support/${entry.target}`))
      throw new Error(`${file}: missing or partial recovery support import`);
    source = declaration + '\n' + source;
  }
  return source;
}
function verifySupport(root, repoRoot, current) {
  for (const entry of SUPPORT) {
    const target = path.join(root, 'dist/native-support', entry.target);
    const exists = fs.existsSync(target);
    if (current ? !exists || fs.readFileSync(target, 'utf8') !== fs.readFileSync(supportSource(repoRoot, entry), 'utf8') : exists)
      throw new Error('Historical or partial tool-call recovery support; rebuild pristine runtime');
  }
}
function processTargets(root, options, verifyOnly) {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, '../../..');
  const dependency = resolveNativeProviderTransportArtifact(root, { required: true });
  const bundle = path.join(root, 'gateway-bundle.mjs');
  const bundled = fs.existsSync(bundle);
  // 10.4 has one shared runner/candidate module and one installed AI producer;
  // workers import these owners instead of maintaining additional inline copies.
  const ownerFiles = name => {
    const files = findFilesContaining(root, `function ${name}(`);
    if (files.length !== 1 + Number(bundled)) throw new Error(`Recovery owner topology changed: ${name}`);
    return files;
  };
  const runnerFiles = ownerFiles('runPreparedEmbeddedLoop');
  const candidateFiles = ownerFiles('runAgentFallbackCandidates');
  const nestedFiles = ownerFiles('runEmbeddedAttemptSettledPhase');
  for (const name of ['completeEmbeddedAttemptAfterTurn', 'readAttemptNestedToolActivity'])
    if (JSON.stringify(ownerFiles(name)) !== JSON.stringify(nestedFiles)) throw new Error(`Recovery nested receipt owner changed: ${name}`);
  const types = [
    'agent-harness-runtime-DZjstJNb',
    'agent-harness-runtime-Du4B564s',
    'channel-core-Dw23qZdV',
    'cli-backend.types-BeWYryLP',
    'net-CNd-dg0-',
  ].map(name => {
    const file = path.join(root, 'dist', `${name}.d.ts`);
    return { file, original: readRuntimeTextFile(file) };
  });
  for (const name of ['prepareTerminalWithSettledTurnFinalization', 'resolveEmbeddedRunTerminal'])
    if (JSON.stringify(ownerFiles(name)) !== JSON.stringify(runnerFiles)) throw new Error(`Recovery terminal owner changed: ${name}`);
  for (const file of [dependency.file, ...(bundled ? [bundle] : [])]) {
    const source = readRuntimeTextFile(file);
    for (const name of ['finalizeOpenAICompletionsToolCalls', 'processCompletionsStream'])
      if (!extractFunction(source, name)) throw new Error(`Recovery producer owner changed: ${name}`);
  }
  const files = [...new Set([dependency.file, ...runnerFiles, ...candidateFiles, ...nestedFiles])];
  const states = [
    ...files.filter(file => !isGatewayBundlePath(file)).map(file => readRuntimeTextFile(file).includes(CONTRACT)),
    ...types.map(entry => entry.original.includes('"tool_call_format_recovery"')),
  ];
  const current = states.every(Boolean);
  if (states.some(Boolean) && !current) throw new Error('Historical or partial recovery target set; rebuild pristine runtime');
  if ((bundled || verifyOnly) && !current) throw new Error('Recovery is not completely applied to source targets');
  verifySupport(root, repoRoot, current);
  const changes = files.map(file => {
    const original = readRuntimeTextFile(file);
    assertCurrentPatchContract(original, CONTRACT, file, false);
    const verify = verifyOnly || current || isGatewayBundlePath(file);
    let next = transformProducer(original, file, { verifyOnly: verify });
    next = transformCandidate(next, file, { verifyOnly: verify });
    next = transformRunner(next, file, { verifyOnly: verify });
    if (runnerFiles.includes(file)) {
      next = bindSupport(next, file, verify);
      if (isGatewayBundlePath(file)) verifyBundledSupport(next, repoRoot);
    } else if (nestedFiles.includes(file)) {
      next = bindSupport(next, file, verify, SUPPORT.filter(entry => entry.source === 'facts.mjs'));
    }
    if (!verify) next = `// ${CONTRACT}\n` + next;
    return { file, original, next };
  });
  changes.push(...types.map(entry => ({ ...entry, next: transformResultTypes(entry.original, verifyOnly || current) })));
  // Pure-read validation of every native/support target precedes all writes;
  // the existing patch transaction snapshots the independently loaded SDK too.
  for (const entry of SUPPORT) nativeSupportModule(root, entry.target, supportSource(repoRoot, entry), verifyOnly || current);
  return changes.flatMap(({ file, original, next }) =>
    !verifyOnly && writeIfChanged(file, original, next) ? [path.relative(root, file)] : [],
  );
}
module.exports = {
  applyPatch: (root, options = {}) => processTargets(root, options, false),
  verifyPatch: (root, options = {}) => processTargets(root, options, true),
  __testing: {
    transformProducer,
    transformCandidate,
    extractFunction,
    transformRunner,
    verifyBundledSupport,
    bindSupport,
    verifySupport,
    transformResultTypes,
    CONTRACT,
  },
};
