'use strict';

// Capability: recover a tool-free summary after completed tools and an output-limit cut-off.
// Target: locked openclaw@2026.10.7 visible text and built-in settled finalization.
// Scope: a standalone tool-call opener outside Markdown code and the existing admitted finalizer.
// Safety: preserve settled tool receipts, cancellation, delivery ownership and the original length interruption.
// Remove when: upstream #174376 and #182231 or equivalent behavior are installed.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { readRuntimeTextFile, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');
const { collect, functionRange, one, parse, same } = require('./prepared-read-patch-shapes.js');

const TARGETS = {
  text: 'dist/assistant-visible-text-BmBadD-q.mjs',
  display: 'dist/chat-display-projection.core-B4GjbqxA.mjs',
  runner: 'dist/embedded-agent-DAqZgJpR.mjs',
};
const OWNERS = {
  text: 'stripToolCallXmlTagsInternal',
  display: 'shouldDropAssistantHistoryMessage',
  finalizer: 'prepareTerminalWithSettledTurnFinalization',
  completion: 'completeEmbeddedRun',
};
const DISPLAY_IMPORT = 'import { f as stripToolCallXmlTags } from "./assistant-visible-text-BmBadD-q.mjs";';
const ORIGINAL_OUTCOME_IMPORT = 'import { r as buildAgentRunTerminalOutcomeFromAttempt, u as projectAgentRunAttemptTerminal } from "./agent-run-terminal-outcome-fGq-0fSB.mjs";';
const OUTCOME_IMPORT = ORIGINAL_OUTCOME_IMPORT.replace('import { ', 'import { n as buildAgentRunTerminalOutcome, ');
const INSTRUCTION = ' The previous turn was cut off at the output token limit. Report only what the tool results show was done, and say plainly what remains unfinished.';
const NOTICE = '⚠️ The model was cut off at its output token limit. Some work may be unfinished.';
const noticePayload = `setReplyPayloadMetadata({ text: ${JSON.stringify(NOTICE)}, isError: true, isStatusNotice: true }, { hostNotice: true })`;
const textGuard = (text, regions, insideCode = 'isInsideCode') => `if (/^\\s*<tool_call>\\s*$/i.test(${text}) && !${insideCode}(${text}.indexOf("<"), ${regions})) return "";`;
const displayGuard = (entry, message, text, sanitize = 'stripToolCallXmlTags') => `if (typeof ${text} === "string" && ${entry}.stopReason === "length" && /^\\s*<tool_call>\\s*$/i.test(${text}) && ${sanitize}(${text}) === "" && !hasAssistantDisplayableNonTextContent(${message}) && !hasTranscriptMediaFacts(${entry})) return true;`;
const summarize = attempt => `outputLimitCutoff && finalizationOutcome === "answered" ? resolveFinalAssistantVisibleText(${attempt}.currentAttemptCompletedAssistant ?? ${attempt}.currentAttemptAssistant) : void 0`;
const requireAuthoredSummary = 'if (outputLimitCutoff && (!cutoffSummary || isSilentReplyText(cutoffSummary))) finalizationOutcome = "failed";';
const outcome = initial => `outputLimitCutoff ? {
  ...${initial}.terminalState,
  outcome: buildAgentRunTerminalOutcome({ ...${initial}.terminalState.outcome, status: "error", error: ${JSON.stringify(NOTICE)} })
} : void 0`;
const canonicalStatement = statement => canonicalHelper(`function boundary(){${statement}}`);
const replace = (source, pattern, replacement) => replaceUniquePattern(source, pattern, replacement, 'settled output cutoff');

function changeOwner(source, owner, change) {
  const { start, end, text } = functionRange(source, owner);
  return source.slice(0, start) + change(text) + source.slice(end);
}

function editText(source) {
  return changeOwner(source, OWNERS.text, text => replace(text,
    /const codeRegions = resolveCodeRegions\(text\);\r?\n\tlet result = "";/u,
    `const codeRegions = resolveCodeRegions(text);\n\t${textGuard('text', 'codeRegions')}\n\tlet result = "";`));
}

function editDisplay(source) {
  return `${DISPLAY_IMPORT}\n` + changeOwner(source, OWNERS.display, text => replace(text,
    /const text = extractAssistantTextForSilentCheck\(message\);/u,
    `$&\n\t${displayGuard('entry', 'message', 'text')}`));
}

function editRunner(source) {
  const imports = replace(source, /import \{ r as buildAgentRunTerminalOutcomeFromAttempt, u as projectAgentRunAttemptTerminal \} from "\.\/agent-run-terminal-outcome-fGq-0fSB\.mjs";/u, OUTCOME_IMPORT);
  const finalizer = changeOwner(imports, OWNERS.finalizer, owner => {
    let text = replace(owner, /const prompt = /u, 'let prompt = ');
    text = replace(text, /if \(!prompt\) return preserveInitial\("not-attempted"\);/u,
      `$&\n\tconst outputLimitCutoff = initial.terminalState.outcome.stopReason === "length";\n\tif (outputLimitCutoff) prompt += ${JSON.stringify(INSTRUCTION)};`);
    text = replace(text, /if \(finalizationOutcome !== "answered" && terminalFallbackAllowed\) \{/u,
      'if (finalizationOutcome !== "answered" && terminalFallbackAllowed && !outputLimitCutoff) {');
    text = replace(text, /const completion = finalizationOutcome !== "answered" && preserveOriginalTerminal \? initial : \{/u,
      `const outputLimitTerminal = ${outcome('initial')};
\tconst cutoffSummary = ${summarize('attempt')};
\t${requireAuthoredSummary}
\tconst completion = outputLimitTerminal && finalizationOutcome !== "answered" ? { ...initial, terminalState: outputLimitTerminal } : finalizationOutcome !== "answered" && preserveOriginalTerminal ? initial : {`);
    text = replace(text, /terminalState: terminalFailed && finalizationOutcome !== "answered" \? initial\.terminalState : \{([\s\S]*?)signalOwnedInterruption: false\r?\n\t\t\},/u,
      'terminalState: outputLimitTerminal ?? (terminalFailed && finalizationOutcome !== "answered" ? initial.terminalState : {$1signalOwnedInterruption: false\n\t\t}),');
    return replace(text, /finalizedPrepared\.payloadsWithToolMedia\?\.forEach\(\(payload\) => \{/u,
      `if (outputLimitCutoff) {\n\t\tif (input.finalization.abortSignal.aborted) return preserveInitial("failed");\n\t\tassertFinalizationActive();\n\t\tfinalizedPrepared.payloadsWithToolMedia = [...(finalizedPrepared.payloadsWithToolMedia ?? []), ${noticePayload}];\n\t}\n\t$&`);
  });
  return changeOwner(finalizer, OWNERS.completion, owner => replace(owner,
    /const stopReason = terminalAborted \|\| terminalTimedOut \?/u,
    'const stopReason = terminalAborted || terminalTimedOut || (input.terminalState.outcome.status === "error" && input.terminalState.outcome.stopReason === "length") ?'));
}

function verifyText(source) {
  const tree = parse(functionRange(source, OWNERS.text).text);
  const owner = tree.statements[0];
  const regions = owner.body.statements[1].declarationList.declarations[0];
  const guard = owner.body.statements[2];
  const regionsName = regions.name.getText(tree);
  const insideCode = one(collect(owner, node => ts.isCallExpression(node) &&
    /^isInsideCode\d*$/u.test(node.expression.getText(tree)) && node.arguments[0]?.getText(tree) === 'idx' &&
    node.arguments[1]?.getText(tree) === regionsName), 'native Markdown code check').expression.getText(tree);
  if (canonicalStatement(guard.getText(tree)) !== canonicalStatement(textGuard(owner.parameters[0].name.getText(tree), regionsName, insideCode)))
    throw new Error('standalone opener must stay visible in Markdown code');
}

function verifyDisplay(source, raw) {
  if (raw && source.split(DISPLAY_IMPORT).length !== 2) throw new Error('missing native tool marker display import');
  const tree = parse(functionRange(source, OWNERS.display).text);
  const owner = tree.statements[0];
  const statements = owner.body.statements;
  const entry = statements[0].declarationList.declarations[0].name.getText(tree);
  const message = owner.parameters[0].name.getText(tree);
  const text = statements[4].declarationList.declarations[0].name.getText(tree);
  const sanitize = one(collect(statements[5], node => ts.isCallExpression(node) &&
    /^stripToolCallXmlTags\d*$/u.test(node.expression.getText(tree))), 'authored output marker sanitizer').expression.getText(tree);
  if (canonicalStatement(statements[5].getText(tree)) !== canonicalStatement(displayGuard(entry, message, text, sanitize)))
    throw new Error('delivery projection must exclude only a cutoff marker without visible media');
}

function verifyRunner(source, raw) {
  if (raw && source.split(OUTCOME_IMPORT).length !== 2) throw new Error('missing native output cutoff outcome import');
  const tree = parse(functionRange(source, OWNERS.finalizer).text);
  const statements = tree.statements[0].body.statements;
  const declarations = collect(tree, ts.isVariableDeclaration);
  const initial = declarations[0].name.getText(tree);
  const input = tree.statements[0].parameters[0].name.getText(tree);
  const attempt = one(declarations.filter(node => node.initializer && ts.isPropertyAccessExpression(node.initializer) &&
    node.initializer.getText(tree) === `${initial}.attempt`),
    'original cutoff attempt').name.getText(tree);
  const cutoff = one(declarations.filter(node => node.name.getText(tree) === 'outputLimitCutoff'), 'original output limit');
  const held = one(declarations.filter(node => node.name.getText(tree) === 'outputLimitTerminal'), 'output limit outcome');
  const projection = one(declarations.filter(node => node.name.getText(tree) === 'completion'), 'cutoff completion');
  const recoveredTerminal = one(collect(projection.initializer.whenFalse, node => ts.isPropertyAssignment(node) &&
    node.name.getText(tree) === 'terminalState'), 'answered cutoff terminal');
  const prompt = one(statements.filter(node => ts.isIfStatement(node) && ts.isExpressionStatement(node.thenStatement) &&
    same(node.expression.getText(tree), 'outputLimitCutoff')), 'cutoff finalization prompt');
  const summary = one(declarations.filter(node => node.name.getText(tree) === 'cutoffSummary'), 'authored cutoff summary');
  const summaryGuard = one(statements.filter(node => ts.isIfStatement(node) &&
    node.expression.getText(tree).includes('!cutoffSummary')), 'authored cutoff summary guard');
  const fallback = one(statements.filter(node => ts.isIfStatement(node) && node.expression.getText(tree).includes('terminalFallbackAllowed')), 'settled fallback');
  const delivery = one(statements.filter(node => ts.isIfStatement(node) && ts.isBlock(node.thenStatement) &&
    same(node.expression.getText(tree), 'outputLimitCutoff')), 'cutoff delivery');
  if (!same(cutoff.initializer.getText(tree), `${initial}.terminalState.outcome.stopReason === "length"`) ||
      !same(held.initializer.getText(tree), outcome(initial)) ||
      !same(summary.initializer.getText(tree), summarize(attempt)) ||
      canonicalStatement(summaryGuard.getText(tree)) !== canonicalStatement(requireAuthoredSummary) ||
      !same(projection.initializer.condition.getText(tree), 'outputLimitTerminal && finalizationOutcome !== "answered"') ||
      !same(projection.initializer.whenTrue.getText(tree), `{ ...${initial}, terminalState: outputLimitTerminal }`) ||
      !ts.isBinaryExpression(recoveredTerminal.initializer) ||
      recoveredTerminal.initializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
      recoveredTerminal.initializer.left.getText(tree) !== 'outputLimitTerminal' ||
      canonicalStatement(prompt.getText(tree)) !== canonicalStatement(`if (outputLimitCutoff) prompt += ${JSON.stringify(INSTRUCTION)};`) ||
      !same(fallback.expression.getText(tree), 'finalizationOutcome !== "answered" && terminalFallbackAllowed && !outputLimitCutoff') ||
      canonicalStatement(delivery.getText(tree)) !== canonicalStatement(`if (outputLimitCutoff) {
        if (${input}.finalization.abortSignal.aborted) return preserveInitial("failed");
        assertFinalizationActive();
        finalizedPrepared.payloadsWithToolMedia = [...(finalizedPrepared.payloadsWithToolMedia ?? []), ${noticePayload}];
      }`)) throw new Error('output cutoff finalization does not preserve its failed outcome and reply custody');
  const completion = parse(functionRange(source, OWNERS.completion).text);
  const reason = one(collect(completion, node => ts.isVariableDeclaration(node) && node.name.getText(completion) === 'stopReason'), 'output limit stop reason');
  const ownerInput = completion.statements[0].parameters[0].name.getText(completion);
  if (!same(reason.initializer.condition.getText(completion),
    `terminalAborted || terminalTimedOut || (${ownerInput}.terminalState.outcome.status === "error" && ${ownerInput}.terminalState.outcome.stopReason === "length")`) ||
      !same(reason.initializer.whenTrue.getText(completion), `${ownerInput}.terminalState.outcome.stopReason`))
    throw new Error('failed output cutoff no longer retains the native length stop reason');
}

function verifyCurrent(source, kind, raw = true) {
  if (kind === 'text') verifyText(source);
  else if (kind === 'display') verifyDisplay(source, raw);
  else verifyRunner(source, raw);
}

function transform(source, kind) {
  const marker = kind === 'runner' ? 'outputLimitCutoff' : '^\\s*<tool_call>\\s*$';
  if (source.includes(marker)) {
    verifyCurrent(source, kind);
    return source;
  }
  const result = kind === 'text' ? editText(source) : kind === 'display' ? editDisplay(source) : editRunner(source);
  verifyCurrent(result, kind);
  return result;
}

function applyPatch(root) {
  if (fs.existsSync(path.join(root, 'gateway-bundle.mjs'))) {
    verifyPatch(root);
    return [];
  }
  const changes = Object.entries(TARGETS).map(([kind, target]) => {
    const file = path.join(root, target);
    const source = readRuntimeTextFile(file);
    return { target, file, source, result: transform(source, kind) };
  });
  if (changes.some(item => item.source === item.result) && changes.some(item => item.source !== item.result))
    throw new Error('partial settled output cutoff patch; rebuild from pristine');
  return changes.filter(item => writeIfChanged(item.file, item.source, item.result)).map(item => item.target);
}

function verifyPatch(root) {
  const file = path.join(root, 'gateway-bundle.mjs');
  const bundle = fs.existsSync(file) ? readRuntimeTextFile(file) : undefined;
  for (const [kind, target] of Object.entries(TARGETS)) {
    const targetFile = path.join(root, target);
    if (fs.existsSync(targetFile)) verifyCurrent(readRuntimeTextFile(targetFile), kind);
    else if (!bundle) throw new Error(`missing settled output cutoff owner: ${target}`);
    if (bundle) verifyCurrent(bundle, kind, false);
  }
}

module.exports = { applyPatch, verifyPatch, __testing: { TARGETS, OWNERS, NOTICE, transform, verifyCurrent } };
