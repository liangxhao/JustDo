'use strict';

// Capability: recover split-turn compaction after the prefix summary returns no text.
// Target: locked openclaw@2026.10.7 safeguard compaction and its summary error type.
// Scope: exhausted prefix generation within an otherwise usable reconciliation.
// Safety: retain native cancellation, budget, quality audit and transcript custody.
// Remove when: native safeguard provides equivalent recovery for an empty prefix summary.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { readRuntimeTextFile, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, collect, one, parse } = require('./prepared-read-patch-shapes.js');

const TARGET = 'dist/builtin-openclaw-Ci5YBsOb.mjs';
const OWNER = 'compactionSafeguardExtension';
const IMPORT = 'i as SummaryOutputBudgetError, n as CompactionError';
const ERROR_TYPES = './types-CPdr3cVV.mjs';
const PATCHED_IMPORT = `import { ${IMPORT}, r as InvalidSummaryOutputError } from "${ERROR_TYPES}";`;
const DIAGNOSTIC = 'empty split-turn summary; retained audited turn context';

// This catch already handles cancellation and a better candidate from an earlier
// quality pass. Use the native excerpt only if the normal finalizer and audit
// can retain that excerpt and the required reconciliation facts in one artifact.
const RECOVERY = `
if (!(attemptError instanceof CompactionError) || !(attemptError.cause instanceof InvalidSummaryOutputError) || !historySummary.trim()) throw attemptError;
const emptyPrefixSection = buildSplitTurnContextSection(turnPrefixMessages);
if (!emptyPrefixSection.segmentStarts.length || emptyPrefixSection.truncatedLoss) throw attemptError;
const emptyPrefixRecovery = await finalizeSummaryText(historySummary, {
  splitTurnSection: emptyPrefixSection,
  preservedTurnsSection: preservedTurnsSectionLocal
}, producerLosses, {
  auditSummary: appendSummarySection(historySummary, emptyPrefixSection.text),
  identifiers,
  latestAsk: latestUserAsk,
  latestUnresolvedUserRequest,
  requiredAskContext,
  identifierPolicy
}, true);
if (signal?.aborted) signal.throwIfAborted();
if (emptyPrefixRecovery.suffixTrimmed || emptyPrefixRecovery.qualityRetentionInfeasible || !auditSummaryQuality({
  summary: emptyPrefixRecovery.summary,
  structuralSummary: emptyPrefixRecovery.structuralSummary,
  sourceSummaries: [historySummary],
  identifiers,
  latestAsk: latestUserAsk,
  latestUnresolvedUserRequest,
  identifierPolicy
}).ok) throw attemptError;
return degrade(emptyPrefixRecovery.summary, "${DIAGNOSTIC}");`.trim();
const canonicalRecovery = source => canonicalHelper(`async function recovery(){${source}}`);
const expectedRecovery = canonicalRecovery(RECOVERY);

function readCatch(text) {
  const tree = parse(text);
  const clause = one(collect(tree, node => ts.isCatchClause(node) &&
    node.variableDeclaration?.name.getText(tree) === 'attemptError'), 'split summary catch');
  const requests = collect(clause.parent.tryBlock, node => ts.isPropertyAssignment(node) &&
    node.name.getText(tree) === 'summaryPrompt');
  if (requests.length !== 2 || requests[0].initializer.getText(tree).includes('turn-prefix') ||
      requests[1].initializer.getText(tree) !== '{ kind: "turn-prefix" }')
    throw new Error('Split summary catch no longer owns the reconciliation and prefix requests');

  const [cancel, best, ...statements] = clause.block.statements;
  if (cancel?.getText(tree) !== 'if (signal?.aborted) signal.throwIfAborted();' ||
      !/^if \(bestSummary\) return degrade\(bestSummary\.summary, `corrective generation failed; attempt=\$\{attempt\d* \+ 1\}`\);$/u.test(best?.getText(tree)))
    throw new Error('Split summary cancellation or prior candidate handling changed');
  return { tree, statements };
}

function verifyCurrent(source, file) {
  const { tree, statements } = readCatch(functionRange(source, OWNER).text);
  if (canonicalRecovery(statements.map(statement => statement.getText(tree)).join('\n')) !== expectedRecovery ||
      (path.basename(file) !== 'gateway-bundle.mjs' && !source.includes(PATCHED_IMPORT)))
    throw new Error(`${file}: missing or incomplete split summary recovery`);
}

function transform(source, file = TARGET) {
  if (source.includes(DIAGNOSTIC) || source.includes('InvalidSummaryOutputError') ||
      source.includes('emptyPrefixRecovery')) {
    verifyCurrent(source, file);
    return source;
  }
  const { start, end, text } = functionRange(source, OWNER);
  const { tree, statements } = readCatch(text);
  const original = one(statements, 'split summary failure');
  if (original.getText(tree) !== 'throw attemptError;') throw new Error('Split summary failure changed');
  const at = original.getStart(tree);
  const indent = text.slice(text.lastIndexOf('\n', at) + 1, at);
  const patched = text.slice(0, at) + RECOVERY.replaceAll('\n', `\n${indent}`) + text.slice(original.end);
  const result = replaceUniquePattern(source.slice(0, start) + patched + source.slice(end),
    /import \{ i as SummaryOutputBudgetError, n as CompactionError \} from "\.\/types-CPdr3cVV\.mjs";/u,
    PATCHED_IMPORT, 'split summary error type');
  verifyCurrent(result, file);
  return result;
}

function applyPatch(root) {
  const file = path.join(root, TARGET);
  const bundle = path.join(root, 'gateway-bundle.mjs');
  const source = readRuntimeTextFile(file);
  if (fs.existsSync(bundle)) {
    verifyCurrent(source, file);
    verifyCurrent(readRuntimeTextFile(bundle), bundle);
    return [];
  }
  return writeIfChanged(file, source, transform(source, file)) ? [TARGET] : [];
}

function verifyPatch(root) {
  const bundle = path.join(root, 'gateway-bundle.mjs');
  const file = path.join(root, TARGET);
  if (fs.existsSync(file)) verifyCurrent(readRuntimeTextFile(file), file);
  else if (!fs.existsSync(bundle)) throw new Error(`${file}: missing split summary owner`);
  if (fs.existsSync(bundle)) verifyCurrent(readRuntimeTextFile(bundle), bundle);
}

module.exports = { applyPatch, verifyPatch, __testing: { transform, readCatch, TARGET, OWNER } };
