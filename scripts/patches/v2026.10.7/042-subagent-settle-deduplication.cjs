'use strict';

// Capability: settle already-delivered subagent results without repeating their wake or findings.
// Target: openclaw@2026.10.7 lacks the requester settlement fixes from #176701 and #178104.
// Scope: native requester-settle batch retirement and its completion prompt.
// Safety: retain native batch ownership, pending delivery, explicit yields and restart findings.
// Remove when: native settlement retires delivered waves before waiting and reads only owed findings.

const fs = require('node:fs');
const path = require('node:path');
const {
  assertCurrentPatchContract,
  countOccurrences,
  findFilesContaining,
  isGatewayBundlePath,
  readRuntimeTextFile,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');
const { assertTargetPaths, functionRange, one } = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_SUBAGENT_SETTLE_DEDUPLICATION_V2026_10_7';
const TARGET = 'dist/subagent-announce.requester-settle-wake-CcIWWdU6.mjs';
const WAKE = 'maybeWakeRequesterAfterAllChildrenSettled';
const MESSAGE = 'buildRequesterSettleWakeMessage';
const NEEDS_FINDINGS = 'needsRequesterSettleFindings';
const HELPER = [
  `function ${NEEDS_FINDINGS}(entry) {`,
  '  return entry.delivery?.status !== "delivered" || entry.execution.interruptionReason === "gateway-restart";',
  '}',
].join('\n');

const UNFROZEN_WAIT = 'if (!frozen && hasUnsettledDescendants) return false;';
const FROZEN_WAIT = 'if (hasUnsettledDescendants && !await deferBatch()) return false;';
const DESCENDANTS = 'const hasUnsettledDescendants = !pauseNotice && initialDescendants.unsettled;';
const RETAINED_IDS = 'const retainedBatchRunIds = pauseNotice ? frozenBatchRunIds : batchRunIds;';
const INTERRUPTED = 'const interruptedContinuations = settledBatch.filter(isQuietSubagentRestartContinuation);';
const REQUIRED = 'const requiredSettled = settledBatch.filter((settleRecord) => settleRecord.expectsCompletionMessage === true || interruptedContinuations.includes(settleRecord));';
const YIELDED = 'const requesterYieldedAfterDelivery = selectedState.afterRequesterYield === true || selectedState.requesterYieldBatch === true && selectedState.rearmGeneration !== void 0;';
const NESTED_GATE = '!requesterYieldedAfterDelivery && interruptedContinuations.length === 0 && !hasRequesterCompletionCohort(currentSettledEntry) && requesterDepth >= 1';
const RETIRE = 'if (!pauseNotice && (requiredSettled.length === 0 || requiredSettled.length < 2 && !requiredSettled.some((entry) => entry.delivery?.status !== "delivered") && !requesterYieldedAfterDelivery';
const COMPLETE = [
  '  await completeBatch(settledBatch, selectedState);',
  '  return false;',
  '}',
];
const BUILD_WAKE_MESSAGE = 'const wakeMessage = buildRequesterSettleWakeMessage({';
const FINDINGS_CONFLICT = 'throw new SubagentAnnouncePreparationConflictError("Child completion preparation changed.");';
const RESTORE_PREPARATION = '  await transitionBatch(deferRequesterSettleWakePreparation(beforeDispatch));';
const wakeEdits = (state = 'state') => [
  [[DESCENDANTS, UNFROZEN_WAIT, RETAINED_IDS], [DESCENDANTS, RETAINED_IDS]],
  [[FROZEN_WAIT, INTERRUPTED, REQUIRED.replaceAll('settleRecord', 'entry'), YIELDED], [YIELDED]],
  [[`${RETIRE} || ${NESTED_GATE})) {`, ...COMPLETE], [
    'const canRetireSettledBatch = () => {',
    `  ${INTERRUPTED}`,
    `  ${REQUIRED}`,
    `  return !pauseNotice && (!requiredSettled.some(${NEEDS_FINDINGS}) && (requiredSettled.length === 0 || !requesterYieldedAfterDelivery) || ${NESTED_GATE});`,
    '};',
    // A frozen deferral can refresh the rows and exhaust its wait. Evaluate
    // retirement again before proceeding with that refreshed batch.
    'if (hasUnsettledDescendants && !canRetireSettledBatch() && (!frozen || !await deferBatch())) return false;',
    'if (canRetireSettledBatch()) {',
    ...COMPLETE,
  ]],
  [['} : await readChildCompletionFindings(completionRows);'], [
    `} : await readChildCompletionFindings(completionRows.filter(${NEEDS_FINDINGS}));`,
    `const preparedEligibility = new Map(completionRows.map((preparedRow) => [preparedRow.runId, ${NEEDS_FINDINGS}(preparedRow)]));`,
    `const isPreparedFindingsCurrent = () => preparedFindings.isCurrent() && (Boolean(pauseNotice) || readCurrentBatch()?.every((preparedRow) => preparedEligibility.get(preparedRow.runId) === ${NEEDS_FINDINGS}(preparedRow)) === true);`,
  ]],
  [[BUILD_WAKE_MESSAGE], [
    'if (canRetireSettledBatch()) {',
    `  await completeBatch(settledBatch, ${state});`,
    '  return false;',
    '}',
    BUILD_WAKE_MESSAGE,
  ]],
  [[`if (!preparedFindings.isCurrent()) ${FINDINGS_CONFLICT}`],
    [`if (!isPreparedFindingsCurrent()) ${FINDINGS_CONFLICT}`]],
  [['if (!preparedFindings.isCurrent()) {', RESTORE_PREPARATION],
    ['if (!isPreparedFindingsCurrent()) {', RESTORE_PREPARATION]],
];

const ROUTE_NOTICES = 'const routeNotices = [...new Set(params.children.flatMap(({ completion }) => {';
const FINDINGS = 'params.findings ?? "(each child result was announced individually in earlier completion events)"';
const MESSAGE_EDITS = [
  [[ROUTE_NOTICES], [
    `const findingsChildren = params.children.filter(${NEEDS_FINDINGS});`,
    `const deliveredRunIds = params.children.flatMap((settleChild) => ${NEEDS_FINDINGS}(settleChild) ? [] : [settleChild.runId]).toSorted();`,
    ROUTE_NOTICES.replace('params.children', 'findingsChildren'),
  ]],
  [[FINDINGS], [
    '...deliveredRunIds.length ? [`Already delivered child results (not repeated): ${deliveredRunIds.join(", ")}.`] : [],',
    FINDINGS,
  ]],
];

function editOwner(source, name, edits, current) {
  const { start, end, text } = functionRange(source, name);
  const escape = line => line.trimStart().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  let next = text;
  for (const [before, after] of edits) {
    const lines = (current ? after : before).map(escape);
    const pattern = new RegExp(`^([\\t ]*)${lines.join('\\r?\\n[\\t ]*')}(?=\\r?$)`, 'mu');
    next = replaceUniquePattern(next, pattern, (match, indent) =>
      current ? match : after.map(line => indent + line).join('\n'), name);
  }
  return source.slice(0, start) + next + source.slice(end);
}

function verifyCurrent(source, file) {
  const bundle = isGatewayBundlePath(file);
  assertCurrentPatchContract(source, CONTRACT, file, !bundle);
  if (countOccurrences(source, CONTRACT) > 1)
    throw new Error(`${file}: duplicate requester settlement patch contract`);
  const helper = functionRange(source, NEEDS_FINDINGS).text;
  const parameter = bundle ? /^function needsRequesterSettleFindings\((entry\d*)\)/u.exec(helper)?.[1] : 'entry';
  if (!parameter || helper.replace(/\s+/gu, ' ') !== HELPER.replace(/\bentry\b/gu, parameter).replace(/\s+/gu, ' '))
    throw new Error(`${file}: requester settlement findings predicate changed`);
  const wake = functionRange(source, WAKE).text;
  if (wake.includes(UNFROZEN_WAIT) || wake.includes(FROZEN_WAIT) ||
      wake.includes('requiredSettled.length < 2') || wake.includes('readChildCompletionFindings(completionRows)'))
    throw new Error(`${file}: requester settlement still contains pristine decisions`);
  const state = bundle
    ? one([...wake.matchAll(/\blet (state\d*) = readSharedBatchState\(settledBatch\);/gu)], WAKE)[1]
    : 'state';
  editOwner(source, WAKE, wakeEdits(state), true);
  editOwner(source, MESSAGE, MESSAGE_EDITS, true);
  return source;
}

function transform(source, file = TARGET) {
  if (isGatewayBundlePath(file) || source.includes(CONTRACT) || source.includes(NEEDS_FINDINGS))
    return verifyCurrent(source, file);
  const wake = editOwner(source, WAKE, wakeEdits(), false);
  const message = editOwner(wake, MESSAGE, MESSAGE_EDITS, false);
  const { start } = functionRange(message, MESSAGE);
  return verifyCurrent(`${message.slice(0, start)}// ${CONTRACT}\n${HELPER}\n${message.slice(start)}`, file);
}

function processTargets(root, verify) {
  const bundle = path.join(root, 'gateway-bundle.mjs');
  const files = findFilesContaining(root, `function ${WAKE}(`);
  const hasBundle = fs.existsSync(bundle);
  assertTargetPaths(root, files, [TARGET, ...(hasBundle ? ['gateway-bundle.mjs'] : [])], WAKE);
  const plans = files.map(file => {
    const source = readRuntimeTextFile(file);
    return { file, source, next: verify ? verifyCurrent(source, file) : transform(source, file) };
  });
  if (hasBundle && plans.some(({ source, next }) => source !== next))
    throw new Error('Mixed source/bundle requester settlement; rebuild from the pristine runtime');
  if (verify) return [];
  return plans.filter(({ file, source, next }) => writeIfChanged(file, source, next))
    .map(({ file }) => path.relative(root, file));
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, TARGET },
};
