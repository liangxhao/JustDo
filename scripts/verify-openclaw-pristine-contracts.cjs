'use strict';

const fs = require('fs');
const path = require('path');
const {
  beginRuntimePatchPhase,
  endRuntimePatchPhase,
  readRuntimeTextFile,
} = require('./patches/v2026.9.6/_patch-utils.js');

const TARGET_VERSION = '2026.9.6';

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

function uniqueEvidence(...groups) {
  return [...new Set(groups.flat())];
}

// Stop no longer queries task or approval inventories in the application.
// Keep its native dependencies explicit at the pristine artifact boundary.
// These shape checks complement behavior tests; they are not execution proofs.
function verifyNativeSessionStopContracts(runtimeDir) {
  const files = walkJavaScriptFiles(path.join(runtimeDir, 'dist'));
  const contracts = [
    {
      label: 'session Stop clears queues and enables descendant cancellation',
      fragments: [
        '"sessions.abort":',
        'if (clearQueued && canonicalKey !== "global")',
        'clearSessionQueues(queueKeys)',
        '!requestedRunId ? { cascadeDescendants: true }',
      ],
    },
    {
      label:
        'session Stop signals the parent before awaiting descendants and reports partial failure',
      fragments: [
        'if (params.cascadeDescendants && plan.canCascade)',
        'descendants = await abortControlledSubagents({',
        'result = plan.abort()',
        'descendant cancellation was incomplete',
      ],
    },
    {
      label: 'session Stop traverses descendants through completed ancestors',
      fragments: [
        'async function killSubagentRunTree',
        '!tree.entry.execution.endedAt',
        'result.descendants = true',
        'result.descendants && tree.canTraverse()',
        'tree.children.map(visit)',
      ],
    },
    {
      label:
        'run Stop revokes authority and emits terminal events without waiting for provider output',
      fragments: [
        'function abortChatRunById',
        'releaseAgentRunDelegatedAuthority(active.agentRunDelegatedAuthority)',
        'ops.onRunAborted?.(runId)',
        'active.controller.abort(createChatAbortSignalReason(stopReason))',
        'broadcastChatAborted(ops',
        'status: "cancelled"',
      ],
    },
    {
      label: 'run Stop connects native approval cancellation',
      fragments: ['function createChatAbortOps', 'context.cancelRunBoundApprovals?.(runId).catch'],
    },
    {
      label: 'native Stop cancels both delegated and legacy run-bound approvals',
      fragments: [
        'function cancelAgentRuntimeBoundApprovals',
        'function cancelUnboundRunApprovals',
        'params.manager.forceDenyDetailed(pending.id, "run-aborted"',
        'pending.request.runId === params.runId',
        'registerAgentRunDelegatedAuthorityClosedHandler',
      ],
    },
  ];
  return uniqueEvidence(
    ...contracts.map(({ fragments, label }) => findFileWithAll(files, fragments, label)),
  );
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
      'live-thinking-stream': findFileWithAll(
        files,
        [
          'evtType === "thinking_start"',
          'evtType === "thinking_delta"',
          'ctx.emitReasoningStream(',
        ],
        'incremental thinking deltas are published through the reasoning stream',
      ),
      'history-display-projection': uniqueEvidence(
        findFileWithAll(
          files,
          ['delete entry.thinkingSignature', 'delete entry.openclawReasoningReplay'],
          'chat history removes private provider thinking material',
        ),
        findFileWithAll(
          files,
          ['type === "thinking" || type === "reasoning" || type === "redacted_thinking"'],
          'chat history recognizes native reasoning blocks',
        ),
      ),
      'native-tool-directory': uniqueEvidence(
        findFileWithAll(
          files,
          ['toolSearchConfig.mode === "directory"', 'applyToolSchemaDirectoryCatalog'],
          'native Tool Search directory mode',
        ),
        findFileWithAll(
          files,
          ['createToolSearchTools', 'catalogRef: options?.toolSearchCatalogRef'],
          'native deferred catalog controls',
        ),
      ),
      'native-session-goals': uniqueEvidence(
        findFileWithAll(
          files,
          ['ACTIVE_GOAL_CONTEXT_PREFIX = "Active goal: "', 'goal?.status !== "active"'],
          'active session Goal prompt context',
        ),
        findFileWithAll(
          files,
          ['create_goal', 'update_goal', 'get_goal'],
          'native Goal tool surface',
        ),
        findFileWithAll(
          files,
          ['"sessions.goal.update":', 'validateSessionsGoalUpdateParams', '"sessions.goal.clear":'],
          'fenced native Goal mutation RPCs',
        ),
        findFileWithAll(
          files,
          ['action: "start"', 'operationId: p.idempotencyKey', 'issuedAtMs: p.intent.issuedAtMs'],
          'idempotent session-goal-start chat intent',
        ),
      ),
      'native-task-rpc-and-events': uniqueEvidence(
        findFileWithAll(
          files,
          ['"tasks.list":', 'validateTasksListParams', 'nextCursor'],
          'paginated tasks.list RPC',
        ),
        findFileWithAll(
          files,
          ['"tasks.get":', 'validateTasksGetParams', 'getTaskById'],
          'tasks.get RPC',
        ),
        findFileWithAll(
          files,
          ['kind: "upserted"', 'cloneTaskRecord(task)'],
          'native task upsert events',
        ),
      ),
      'subagent-queue-and-wait': uniqueEvidence(
        findFileWithAll(
          files,
          ['setCommandLaneConcurrency("subagent", concurrency.subagent)'],
          'subagent command lane uses configured queue concurrency',
        ),
        findFileWithAll(
          files,
          ['lane: AGENT_LANE_SUBAGENT', 'status: "accepted"'],
          'accepted subagent work is dispatched through the queued subagent lane',
        ),
        findFileWithAll(
          files,
          ['name: "agents_wait"', 'state.completed.length > 0', 'state.pending.length === 0'],
          'parent agents can wait for collector children to settle',
        ),
        findFileWithAll(
          files,
          ['queueTaskSystemEvent(latest, sessionEventText, owner)', '"session_queued"'],
          'terminal child results resume the requester session through durable delivery',
        ),
      ),
      'native-session-stop': verifyNativeSessionStopContracts(runtimeDir),
      'persistent-approval-lifecycle': uniqueEvidence(
        findFileWithAll(
          files,
          ['function observeAgentRunApprovalWait', 'pausedMs', 'state.onChange'],
          'pending approvals suspend the agent run budget',
        ),
        findFileWithAll(
          files,
          ['resolveExecApprovalWaitOutcome', 'approvalId', 'resolveTimedOut'],
          'approval resolution and expiry share the native wait lifecycle',
        ),
      ),
      'native-approval-timeouts': uniqueEvidence(
        findFileWithAll(
          files,
          ['DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 18e5'],
          'native exec approvals default to 30 minutes',
        ),
        findFileWithAll(
          files,
          [
            'DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4',
            'MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5',
            'Math.min(MAX_PLUGIN_APPROVAL_TIMEOUT_MS, Math.max(1, Math.floor(',
          ],
          'native plugin approvals default to 2 minutes and clamp at 10 minutes',
        ),
      ),
      'compaction-and-context-budget': uniqueEvidence(
        findFileWithAll(
          files,
          ['shouldPreemptivelyCompactBeforePrompt', 'buildPrePromptContextBudgetStatus'],
          'native pre-prompt context budget and overflow precheck',
        ),
        findFileWithAll(
          files,
          ['compactionSafeguardDeps.summarizeInStages', 'previousSummary'],
          'native safeguard compaction with staged summaries',
        ),
      ),
      'openai-visible-stop-tool-safety': findFileWithAll(
        files,
        [
          'allowSilentToolCallPromotion',
          'Provider returned an incomplete or malformed tool call',
          'stopReason=`toolUse`',
          'stopReason=`error`',
        ],
        'OpenAI-compatible stop/tool-call promotion is silent-only and rejects malformed calls',
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
  if (!runtimeDir) {
    throw new Error('Usage: node scripts/verify-openclaw-pristine-contracts.cjs <runtime-dir>');
  }
  const result = verifyPristineOpenClawContracts(path.resolve(runtimeDir));
  console.log(
    `[verify-openclaw-pristine-contracts] ${result.version}: ` +
      `${Object.keys(result.upstream).length} upstream contracts, ` +
      `${result.retainedGaps.length} retained gaps verified`,
  );
}

module.exports = { verifyPristineOpenClawContracts, verifyNativeSessionStopContracts };
