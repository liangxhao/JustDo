'use strict';

const fs = require('fs');
const path = require('path');
const {
  beginRuntimePatchPhase,
  endRuntimePatchPhase,
  readRuntimeTextFile,
} = require('./patches/v2026.7.1-2/_patch-utils.js');

const TARGET_VERSION = '2026.7.1-2';

function walkJavaScriptFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'control-ui') walkJavaScriptFiles(fullPath, output);
    } else if (entry.isFile() && /\.(?:cjs|mjs|js)$/.test(entry.name)) {
      output.push(fullPath);
    }
  }
  return output;
}

function findFileWithAll(files, fragments, label) {
  const matches = files.filter(filePath => {
    const content = readRuntimeTextFile(filePath);
    return fragments.every(fragment => content.includes(fragment));
  });
  if (matches.length === 0) {
    throw new Error(`Pristine OpenClaw contract is missing: ${label}`);
  }
  return matches.map(filePath => path.basename(filePath));
}

function findFunctionWithControlFlow(files, signature, required, forbidden, label) {
  const matches = files.filter(filePath => {
    const content = readRuntimeTextFile(filePath).replace(/\r\n/g, '\n');
    const start = content.indexOf(signature);
    if (start < 0) return false;
    const end = content.indexOf('\n}\n', start);
    if (end < 0) return false;
    const functionSource = content.slice(start, end + 2);
    return (
      required.every(fragment => functionSource.includes(fragment)) &&
      forbidden.every(fragment => !functionSource.includes(fragment))
    );
  });
  if (matches.length === 0) {
    throw new Error(`Pristine OpenClaw control-flow contract is missing: ${label}`);
  }
  return matches.map(filePath => path.basename(filePath));
}

function findBlockBetween(files, startSignature, endSignature, required, forbidden, label) {
  const matches = files.filter(filePath => {
    const content = readRuntimeTextFile(filePath).replace(/\r\n/g, '\n');
    const start = content.indexOf(startSignature);
    if (start < 0) return false;
    const end = content.indexOf(endSignature, start + startSignature.length);
    if (end < 0) return false;
    const blockSource = content.slice(start, end);
    return (
      required.every(fragment => blockSource.includes(fragment)) &&
      forbidden.every(fragment => !blockSource.includes(fragment))
    );
  });
  if (matches.length === 0) {
    throw new Error(`Pristine OpenClaw bounded-block contract is missing: ${label}`);
  }
  return matches.map(filePath => path.basename(filePath));
}

function uniqueEvidence(...groups) {
  return [...new Set(groups.flat())];
}

function listPatchFiles(repoRoot) {
  const patchDir = path.join(repoRoot, 'scripts', 'patches', `v${TARGET_VERSION}`);
  return fs
    .readdirSync(patchDir)
    .filter(name => /^\d.*\.cjs$/.test(name))
    .sort()
    .map(name => path.join(patchDir, name));
}

function verifyRetainedGaps(runtimeDir, patchFiles) {
  const gaps = [];
  for (const patchFile of patchFiles) {
    const patchModule = require(patchFile);
    if (typeof patchModule.verifyPatch !== 'function') {
      throw new Error(`${patchFile}: retained capability has no verifyPatch contract`);
    }
    let failedAsExpected = false;
    try {
      patchModule.verifyPatch(runtimeDir);
    } catch {
      failedAsExpected = true;
    }
    if (!failedAsExpected) {
      throw new Error(
        `${path.basename(patchFile)} already verifies on the pristine npm artifact; ` +
          'remove the redundant patch or repair its capability contract.',
      );
    }
    gaps.push(path.basename(patchFile));
  }
  return gaps;
}

function verifyPristineOpenClawContracts(runtimeDir, options = {}) {
  const packagePath = path.join(runtimeDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== TARGET_VERSION) {
    throw new Error(
      `Pristine contract audit expected openclaw@${TARGET_VERSION}, received ` +
        `${String(pkg.name)}@${String(pkg.version)}`,
    );
  }
  for (const forbidden of ['runtime-patch-manifest.json', 'runtime-build-info.json']) {
    if (fs.existsSync(path.join(runtimeDir, forbidden))) {
      throw new Error(`Pristine contract audit rejected prebuilt artifact containing ${forbidden}`);
    }
  }

  const files = walkJavaScriptFiles(path.join(runtimeDir, 'dist'));
  if (files.length === 0) throw new Error('Pristine OpenClaw dist JavaScript is missing');

  const snapshot = new Map(files.map(filePath => [filePath, fs.readFileSync(filePath)]));
  beginRuntimePatchPhase(runtimeDir, snapshot);
  try {
    const upstream = {
      '002-reasoning-default': findFileWithAll(
        files,
        ['resolvedReasoningLevel: params.resolvedReasoningLevel', 'buildStatusReply({'],
        'announce/status execution inherits resolved reasoning',
      ),
      '009-reply-conflict-retry': findFileWithAll(
        files,
        [
          'REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE',
          'TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS',
          'sleepWithAbort(retryDelayMs',
        ],
        'reply session initialization conflict normalization and bounded retry',
      ),
      '014-context-budget-native-state': [
        ...findFileWithAll(
          files,
          ['buildPrePromptContextBudgetStatus({', 'contextBudgetStatus,'],
          'native pre-prompt context budget calculation',
        ),
        ...findFileWithAll(
          files,
          ['lastContextBudgetStatus', 'contextBudgetStatus: lastContextBudgetStatus'],
          'native final context budget persistence',
        ),
        ...findFileWithAll(
          files,
          ['contextBudgetStatus: entry?.contextBudgetStatus'],
          'native context budget session projection',
        ),
      ],
      '020-active-run-native-state': [
        ...findFileWithAll(
          files,
          [
            'function hasTrackedActiveSessionRun(params)',
            'return resolveVisibleActiveSessionRunState',
          ],
          'native active-run tracker',
        ),
        ...findFileWithAll(
          files,
          ['hasActiveRun: activeRunState.active'],
          'native active-run response projection',
        ),
      ],
      '021-native-active-goal-context': uniqueEvidence(
        findFunctionWithControlFlow(
          files,
          'function formatActiveGoalContext(sessionEntry)',
          [
            'goal?.status !== "active"',
            'objective.replace(/\\s+/g, " ").trim()',
            'MAX_ACTIVE_GOAL_OBJECTIVE_CHARS',
            'ACTIVE_GOAL_CONTEXT_PREFIX',
            'ACTIVE_GOAL_CONTEXT_SUFFIX',
          ],
          [],
          'active Goal context is normalized, bounded and restricted to active goals',
        ),
        findFileWithAll(
          files,
          ['MAX_ACTIVE_GOAL_OBJECTIVE_CHARS = 200', 'ACTIVE_GOAL_CONTEXT_PREFIX = "Active goal: "'],
          'active Goal context uses the upstream bounded prompt contract',
        ),
        findFileWithAll(
          files,
          [
            'refreshInboundContextAfterAdmissionWait',
            'activeGoalContext = formatActiveGoalContext(inboundContextSessionEntry)',
          ],
          'active Goal context is refreshed after queue admission',
        ),
      ),
      '022-native-goal-objective-edit': uniqueEvidence(
        findFunctionWithControlFlow(
          files,
          'async function updateSessionGoalObjective(options)',
          [
            'const accounted = accountGoalUsage(entry, now);',
            'TERMINAL_GOAL_STATUSES.has(accounted.status)',
            '...accounted,',
            'objective,',
            'updatedAt: now',
          ],
          [],
          'Goal edit preserves the accounted Goal identity, lifecycle and budget fields',
        ),
        findFileWithAll(
          files,
          ['case "edit":', 'updateSessionGoalObjective({', 'Goal updated: ${goal.objective}'],
          '/goal edit dispatches to the native objective update operation',
        ),
      ),
      '023-chat-send-agent-continuation-gap': findBlockBetween(
        files,
        'ChatSendParamsSchema =',
        'ChatAbortParamsSchema =',
        ['message:', 'idempotencyKey:', 'additionalProperties: false'],
        ['extraSystemPrompt:', 'suppressPromptPersistence:'],
        'chat.send cannot carry the non-persistent system policy used by direct agent continuations',
      ),
      '024-codex-goal-result-success': findFunctionWithControlFlow(
        files,
        'function isCodexToolResultError',
        [
          'status !== "created"',
          'status !== "updated"',
          'status !== "found"',
          'status !== "missing"',
        ],
        [],
        'Codex classifies successful Goal reads and writes as successful dynamic tool calls',
      ),
      '005-visible-stop-usage-independent': uniqueEvidence(
        findFunctionWithControlFlow(
          files,
          'function isEmptyResponseAssistantTurn(params)',
          [
            'if (params.payloadCount !== 0) return false;',
            'if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) return false;',
            'const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;',
          ],
          ['message.usage', 'hasPositiveOutputTokenUsage'],
          'visible assistant payload/text excludes empty-response retry independent of usage',
        ),
        findFunctionWithControlFlow(
          files,
          'function resolveEmptyResponseRetryInstruction(params)',
          [
            'if (!isEmptyResponseAssistantTurn({',
            'payloadCount: params.payloadCount,',
            'attempt: params.attempt',
            'return EMPTY_RESPONSE_RETRY_INSTRUCTION;',
          ],
          [],
          'empty-response retry is gated by the non-visible-turn classifier',
        ),
        findFileWithAll(
          files,
          [
            'const nextEmptyResponseRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveEmptyResponseRetryInstruction({',
            'if (!nextReasoningOnlyRetryInstruction && nextEmptyResponseRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts)',
            'emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;',
          ],
          'run loop retries only when the empty-response classifier returns an instruction',
        ),
      ),
      '006-sessions-yield-active-or-pending': uniqueEvidence(
        findFunctionWithControlFlow(
          files,
          'function createSessionsYieldTool(opts)',
          [
            'if (!opts?.sessionId) return jsonResult({',
            'if (!opts?.onYield) return jsonResult({',
            'await opts.onYield(message);',
            'status: "yielded"',
          ],
          ['listControlledSubagentRuns', 'delivery?.status', 'No active subagents'],
          'sessions_yield invokes the yield callback without rejecting active or pending-delivery children',
        ),
        findFileWithAll(
          files,
          [
            'onYield: (message) => {',
            'yieldDetected = true;',
            'queueYieldInterruptForSession?.();',
            'runAbortController.abort("sessions_yield");',
            'abortSessionForYield?.();',
          ],
          'embedded run accepts sessions_yield and transitions the turn to paused/yielded',
        ),
      ),
      '011-compaction-summary-input': uniqueEvidence(
        findFunctionWithControlFlow(
          files,
          'async function summarizeViaLLM(params)',
          [
            'const messages = prependPreviousSummaryForRedistill({',
            'previousSummary: params.previousSummary',
            'return compactionSafeguardDeps.summarizeInStages({',
            'previousSummary: void 0',
          ],
          [],
          'previous summary is prepended and redistilled exactly once in LLM summary input',
        ),
        findFunctionWithControlFlow(
          files,
          'function splitPreservedRecentTurns(params)',
          [
            'if (role === "user" || role === "assistant")',
            'if (message.role !== "assistant") continue;',
            'return role === "user" || role === "assistant" || role === "toolResult";',
            'repairToolUseResultPairing(',
          ],
          [],
          'recent assistant turns and paired tool results are preserved outside the history summary',
        ),
        findFunctionWithControlFlow(
          files,
          'function formatContextMessages(messages)',
          [
            'if (message.role === "assistant") roleLabel = "Assistant";',
            'else if (message.role === "toolResult")',
            'rendered.length > MAX_RECENT_TURN_TEXT_CHARS',
            'truncateUtf16Safe(rendered, MAX_RECENT_TURN_TEXT_CHARS)',
          ],
          [],
          'recent assistant and tool-result suffix text is bounded before inclusion',
        ),
        findFunctionWithControlFlow(
          files,
          'function sanitizeCompactionMessages(messages)',
          ['return stripToolResultDetails(stripRuntimeContextCustomMessages(messages));'],
          [],
          'summarization removes non-model tool-result details before token planning and dispatch',
        ),
        findFunctionWithControlFlow(
          files,
          'function buildSummaryChunks(params)',
          [
            'chunkMessagesByMaxTokens(',
            'sanitizeCompactionMessages(params.messages)',
            'params.maxChunkTokens',
          ],
          [],
          'sanitized history is split by the configured maximum summary chunk budget',
        ),
        findFunctionWithControlFlow(
          files,
          'function buildOversizedFallbackPlan(params)',
          [
            'const oversizedThreshold = params.contextWindow * .5;',
            'if (tokens * 1.2 > oversizedThreshold)',
            'omitted from summary]',
            'else smallMessages.push(msg);',
          ],
          [],
          'oversized tool or conversation messages are omitted with bounded placeholder notes',
        ),
        findFileWithAll(
          files,
          [
            'let baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);',
            'const turnPrefixMessages = baseTurnPrefixMessages;',
            'splitPreservedRecentTurns({',
            'const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;',
            'if (preparation.isSplitTurn && turnPrefixMessages.length > 0)',
            'messages: turnPrefixMessages,',
            'previousSummary: effectivePreviousSummary',
          ],
          'compaction flow orders history, retained recent turns, previous summary and split-turn prefix',
        ),
      ),
      '025-subagent-task-name-persistence': uniqueEvidence(
        findFileWithAll(
          files,
          [
            'const registerSubagentRun = (registerParams) => {',
            'taskName: registerParams.taskName,',
            'params.runs.set(runId, entry);',
            'params.persistOrThrow();',
          ],
          'subagent registration stores taskName before durable registry persistence',
        ),
        findFunctionWithControlFlow(
          files,
          'function subagentRunRecordToSqliteInsert(entry)',
          [
            'const normalized = normalizeSubagentRunState(structuredClone(entry));',
            'task_name: normalized.taskName ?? null,',
            'payload_json: JSON.stringify(normalized)',
          ],
          [],
          'taskName is serialized to the typed SQLite column and registry payload',
        ),
        findFunctionWithControlFlow(
          files,
          'function rowToSubagentRunRecord(row)',
          [
            'const payload = parseJson(row.payload_json) ?? {};',
            '...row.task_name ? { taskName: row.task_name } : {},',
            'const record = normalizeSubagentRunState({',
          ],
          [],
          'taskName is restored from persisted SQLite state',
        ),
        findFunctionWithControlFlow(
          files,
          'function saveSubagentRegistryToSqlite(runs)',
          [
            'const values = subagentRunRecordToSqliteInsert(entry);',
            'insertInto("subagent_runs").values(values)',
            'doUpdateSet(subagentRunRecordToSqliteUpdate(values))',
          ],
          [],
          'subagent registry persistence writes and updates serialized taskName rows',
        ),
      ),
    };

    const repoRoot = options.repoRoot ?? path.resolve(__dirname, '..');
    const patchFiles = options.patchFiles ?? listPatchFiles(repoRoot);
    const retainedGaps = verifyRetainedGaps(runtimeDir, patchFiles);
    return { version: TARGET_VERSION, upstream, retainedGaps };
  } finally {
    endRuntimePatchPhase(runtimeDir);
  }
}

if (require.main === module) {
  const runtimeDir = process.argv[2];
  if (!runtimeDir)
    throw new Error('Usage: node scripts/verify-openclaw-pristine-contracts.cjs <runtime-dir>');
  const result = verifyPristineOpenClawContracts(path.resolve(runtimeDir));
  console.log(
    `[verify-openclaw-pristine-contracts] ${result.version}: ` +
      `${Object.keys(result.upstream).length} upstream contracts, ` +
      `${result.retainedGaps.length} retained gaps verified`,
  );
}

module.exports = { verifyPristineOpenClawContracts };
