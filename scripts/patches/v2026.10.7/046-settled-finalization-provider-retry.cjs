'use strict';

// Capability: recover a temporary model failure while summarizing settled tool results.
// Target: locked openclaw@2026.10.7 built-in isolated finalizer and its bounded loop.
// Scope: empty answers, classified pre-output transport failures, and transient HTTP 5xx.
// Safety: preserve the same run, tools disabled, delivery checks, Stop and the original failure.
// Remove when: the native tool-free finalizer recovers transient provider failures itself.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { readRuntimeTextFile, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same } = require('./prepared-read-patch-shapes.js');

const TARGETS = {
  projection: 'dist/settled-turn-finalization-result-36KdhcIS.mjs',
  harness: 'dist/builtin-openclaw-Ci5YBsOb.mjs',
  loop: 'dist/embedded-agent-DAqZgJpR.mjs',
};
const OWNER = {
  projection: 'projectSettledTurnFinalizationAttemptResult',
  harness: 'createOpenClawAgentHarness',
  loop: 'prepareTerminalWithSettledTurnFinalization',
};
const IMPORTS = {
  projection: [
    'import { i as isBillingAssistantError, o as isRateLimitAssistantError, r as isAuthAssistantError } from "./assistant-message-failures-CF-JUhOf.mjs";',
    'import { t as isRetryableAssistantError } from "./retry-pTOWJTiy.mjs";',
    'import { a as resolveRetryAfterMs, n as extractFailoverHttpStatus } from "./retry-evidence-BU61_01P.mjs";',
  ],
  harness: [],
  loop: ['import { n as isBuiltInOpenClawAgentHarness } from "./builtin-openclaw-Ci5YBsOb.mjs";'],
};
const KIND = 'settled-finalization-provider-retry';
const BUILTIN_ATTEMPT_LIMIT = 4;
const retryEligible = input => `terminalFallbackAllowed && !terminalFailed && isBuiltInOpenClawAgentHarness(${input}.finalization.harness)`;
const attemptLimit = `finalizationProviderRetryAllowed ? ${BUILTIN_ATTEMPT_LIMIT} : MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS`;
const emptyLoopCondition = 'finalization.outcome !== "empty" || finalizationAttempt >= finalizationAttemptLimit';
const DIRECTIVE = 'Return a concise final answer using the available tool results. Say what remains incomplete when the results leave work outstanding. Do not call tools.';
const PROJECTION = `if (providerRetryAllowed && assistant.stopReason === "error" && assistant.content.length === 0 &&
    isRetryableAssistantError(assistant) && !isAuthAssistantError(assistant) &&
    !isBillingAssistantError(assistant) && !isRateLimitAssistantError(assistant)) {
  const finalizationHttpStatus = extractFailoverHttpStatus(assistant.errorMessage);
  if ([500, 502, 503, 504, 524].includes(finalizationHttpStatus) || (finalizationHttpStatus === void 0 &&
    assistant.diagnostics?.some(entry => entry.type === "provider_transport_failure" &&
      entry.details?.eventsEmitted === false && entry.details?.phase === "before_message_stream_start"))) {
    const finalizationRetryAfter = resolveRetryAfterMs(assistant.errorMessage, Date.now(), assistant.errorBody);
    if (finalizationRetryAfter === void 0 || finalizationRetryAfter <= 5000)
      throw new Error("Temporary provider failure during isolated finalization", {
        cause: { kind: "${KIND}", delayMs: Math.max(750, finalizationRetryAfter ?? 0) }
      });
  }
}`;
const catchBody = (input, logger) => `
const finalizationRetry = finalizationRetryError instanceof Error ? finalizationRetryError.cause : void 0;
if (finalizationRetry?.kind !== "${KIND}" || finalizationAttempt >= finalizationAttemptLimit ||
    !finalizationProviderRetryAllowed || ${input}.finalization.abortSignal.aborted ||
    !Number.isFinite(finalizationRetry.delayMs) || finalizationRetry.delayMs < 750 || finalizationRetry.delayMs > 5000)
  throw finalizationRetryError;
assertFinalizationActive();
${logger}(\`settled-turn finalization retrying a temporary provider failure with tools disabled: \${describeRun()}\`);
await sleepWithAbort(finalizationRetry.delayMs, ${input}.finalization.abortSignal);
continue;`.trim();
const retryAdmission = prepared => `if (finalizationAttempt > 1 && finalizationProviderRetryAllowed) {
  const nextSummaryDelivery = await observeSourceDelivery();
  assertFinalizationActive();
  if (resolveSourceReplyDelivery(initial.attempt, nextSummaryDelivery) !== "missing") {
    ${prepared} = { ...${prepared}, replyDeliveryState: nextSummaryDelivery };
    return preserveInitial("failed");
  }
}`;
const promptExpression = `finalizationAttempt > 1 ? prompt + "\\n\\n${DIRECTIVE}" : prompt`;
const canonicalBody = value => canonicalHelper(`async function boundary(){while(true){${value}}}`);

function scoped(source, kind) {
  const range = functionRange(source, OWNER[kind]);
  const tree = parse(range.text);
  return { ...range, tree, fn: tree.statements[0] };
}

function harnessCall(tree) {
  return one(collect(tree, node => ts.isReturnStatement(node) && node.expression &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === OWNER.projection),
  'built-in isolated finalization projection').expression;
}

function loopNodes(tree) {
  const dispatch = one(collect(tree, node => ts.isCallExpression(node) &&
    node.expression.getText(tree) === 'runPreparedSettledTurnFinalization'), 'isolated finalization dispatch');
  const statement = dispatch.parent.parent.parent;
  if (!ts.isAwaitExpression(dispatch.parent) || !ts.isExpressionStatement(statement))
    throw new Error('isolated finalization assignment changed');
  const prompt = one(dispatch.arguments[0].properties.filter(property =>
    property.name?.getText(tree) === 'prompt'), 'isolated finalization prompt');
  const log = one(collect(tree, node => ts.isCallExpression(node) &&
    node.arguments[0]?.getText(tree).startsWith('`settled post-tool turn lacked a final answer:')),
  'isolated finalization logger');
  const prepared = one(collect(tree, node => ts.isVariableDeclaration(node) &&
    (node.parent.flags & ts.NodeFlags.Let) !== 0 && node.initializer &&
    ts.isCallExpression(node.initializer) &&
    node.initializer.expression.getText(tree) === 'prepareEmbeddedRunTerminal'), 'isolated finalization reply projection');
  return { statement, prompt, logger: log.expression.getText(tree), prepared: prepared.name.getText(tree) };
}

function verifyCurrent(source, kind, raw = false) {
  if (raw && IMPORTS[kind].some(entry => source.split(entry).length !== 2))
    throw new Error(`isolated finalization ${kind} imports changed`);
  const { tree, fn } = scoped(source, kind);
  if (kind === 'projection') {
    const branch = one(fn.body.statements.filter(statement => ts.isIfStatement(statement) &&
      statement.expression.getText(tree).includes('providerRetryAllowed')), 'typed finalization provider evidence');
    const finalProjection = fn.body.statements.at(-1);
    if (fn.parameters[1]?.getText(tree) !== 'providerRetryAllowed = false' ||
      canonicalBody(branch.getText(tree)) !== canonicalBody(PROJECTION) ||
      fn.body.statements.at(-2) !== branch || !ts.isReturnStatement(finalProjection) ||
      !finalProjection.expression.getText(tree).startsWith('assertSettledTurnFinalizationResult('))
      throw new Error('isolated finalization provider evidence changed');
  } else if (kind === 'harness') {
    const call = harnessCall(tree);
    if (call.arguments.length !== 2 || call.arguments[1].kind !== ts.SyntaxKind.TrueKeyword)
      throw new Error('built-in finalization provider evidence is not enabled');
  } else {
    const { statement, prompt, logger, prepared } = loopNodes(tree);
    const wrapper = statement.parent.parent;
    const input = fn.parameters[0].name.getText(tree);
    const eligible = one(collect(tree, node => ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === 'finalizationProviderRetryAllowed'), 'isolated finalization retry eligibility');
    const limit = one(collect(tree, node => ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === 'finalizationAttemptLimit'), 'isolated finalization attempt limit');
    const emptyExit = one(collect(tree, node => ts.isIfStatement(node) && ts.isBreakStatement(node.thenStatement) &&
      node.expression.getText(tree).includes('finalization.outcome !== "empty"')), 'isolated finalization empty exit');
    if (!ts.isTryStatement(wrapper) || wrapper.tryBlock.statements.length !== 1 || !wrapper.catchClause ||
      !ts.isBlock(wrapper.parent) || !ts.isForStatement(wrapper.parent.parent) ||
      canonicalBody(wrapper.parent.statements[wrapper.parent.statements.indexOf(wrapper) - 1]?.getText(tree) ?? '') !==
        canonicalBody(retryAdmission(prepared)) ||
      wrapper.catchClause.variableDeclaration.name.getText(tree) !== 'finalizationRetryError' ||
      canonicalBody(wrapper.catchClause.block.statements.map(statement => statement.getText(tree)).join('\n')) !==
        canonicalBody(catchBody(input, logger)) ||
      !same(eligible.initializer?.getText(tree), retryEligible(input)) || !same(limit.initializer?.getText(tree), attemptLimit) ||
      !same(emptyExit.expression.getText(tree), emptyLoopCondition) ||
      !ts.isPropertyAssignment(prompt) || !same(prompt.initializer.getText(tree), promptExpression))
      throw new Error('isolated finalization retry owner changed');
  }
}

function transform(source, kind) {
  if (kind === 'projection' ? source.includes(KIND) :
      kind === 'loop' ? source.includes(KIND) : source.includes('projectSettledTurnFinalizationAttemptResult(result, true)')) {
    verifyCurrent(source, kind, true);
    return source;
  }
  const { start, end, text, tree, fn } = scoped(source, kind);
  let next;
  if (kind === 'projection') {
    next = replaceUniquePattern(text, /function projectSettledTurnFinalizationAttemptResult\(result\) \{/u,
      'function projectSettledTurnFinalizationAttemptResult(result, providerRetryAllowed = false) {', 'finalization evidence signature');
    next = replaceUniquePattern(next, /return assertSettledTurnFinalizationResult\(\{/u,
      `${PROJECTION}\n\treturn assertSettledTurnFinalizationResult({`, 'finalization evidence before projection');
  } else if (kind === 'harness') {
    const call = harnessCall(tree);
    if (call.arguments.length !== 1 || call.arguments[0].getText(tree) !== 'result')
      throw new Error('built-in finalization result changed');
    next = text.slice(0, call.arguments.end) + ', true' + text.slice(call.arguments.end);
  } else {
    const { statement, prompt, logger, prepared } = loopNodes(tree);
    if (!ts.isShorthandPropertyAssignment(prompt) || !ts.isBlock(statement.parent) ||
      !ts.isForStatement(statement.parent.parent))
      throw new Error('isolated finalization loop changed');
    const assignment = statement.getText(tree);
    const promptOffset = prompt.getStart(tree) - statement.getStart(tree);
    const withPrompt = assignment.slice(0, promptOffset) + `prompt: ${promptExpression}` +
      assignment.slice(promptOffset + prompt.getWidth(tree));
    const input = fn.parameters[0].name.getText(tree);
    const wrapped = `${retryAdmission(prepared)}\ntry {\n${withPrompt}\n} catch (finalizationRetryError) {\n${catchBody(input, logger)}\n}`;
    next = text.slice(0, statement.getStart(tree)) + wrapped + text.slice(statement.end);
    next = replaceUniquePattern(next, /const terminalFailed = classifyAgentRunTerminalOutcome\(initial\.terminalState\.outcome\) === "failure";/u,
      `$&\n\tconst finalizationProviderRetryAllowed = ${retryEligible(input)};\n\tconst finalizationAttemptLimit = ${attemptLimit};`,
      'built-in finalization attempt limit');
    next = replaceUniquePattern(next, /finalization\.outcome !== "empty" \|\| finalizationAttempt >= MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS/u,
      emptyLoopCondition, 'isolated empty finalization attempt limit');
    next = replaceUniquePattern(next, /\$\{finalizationAttempt\}\/1 with tools disabled/u,
      '${finalizationAttempt}/${finalizationAttemptLimit - 1} with tools disabled', 'isolated finalization retry diagnostic');
    next = replaceUniquePattern(next, /attempts=\$\{finalizationAttempt\}\/\$\{MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS\}/u,
      'attempts=${finalizationAttempt}/${finalizationAttemptLimit}', 'isolated finalization exhaustion diagnostic');
  }
  const result = [...IMPORTS[kind], source.slice(0, start) + next + source.slice(end)].join('\n');
  verifyCurrent(result, kind, true);
  return result;
}

function verifyPatch(root) {
  const bundle = path.join(root, 'gateway-bundle.mjs');
  const bundled = fs.existsSync(bundle) ? readRuntimeTextFile(bundle) : null;
  for (const [kind, name] of Object.entries(TARGETS)) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) verifyCurrent(readRuntimeTextFile(file), kind, true);
    else if (!bundled) throw new Error(`missing isolated finalization owner: ${name}`);
    if (bundled) verifyCurrent(bundled, kind);
  }
}

function applyPatch(root) {
  if (fs.existsSync(path.join(root, 'gateway-bundle.mjs'))) {
    verifyPatch(root);
    return [];
  }
  const changes = Object.entries(TARGETS).map(([kind, name]) => {
    const file = path.join(root, name);
    const source = readRuntimeTextFile(file);
    return { name, file, source, next: transform(source, kind) };
  });
  if (changes.some(({ source, next }) => source === next) && changes.some(({ source, next }) => source !== next))
    throw new Error('partial settled finalization provider retry; rebuild from pristine');
  return changes.filter(({ file, source, next }) => writeIfChanged(file, source, next)).map(({ name }) => name);
}

module.exports = { applyPatch, verifyPatch, __testing: { TARGETS, OWNER, transform, verifyCurrent } };
