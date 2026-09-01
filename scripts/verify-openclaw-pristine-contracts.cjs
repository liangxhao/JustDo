'use strict';

const fs = require('fs');
const path = require('path');
const {
  beginRuntimePatchPhase,
  endRuntimePatchPhase,
  readRuntimeTextFile,
} = require('./patches/v2026.8.1/_patch-utils.js');

const TARGET_VERSION = '2026.8.1';

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
          'ctx.emitReasoningStream(partialThinking || thinkingContent || thinkingDelta)',
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
          ['queueTaskSystemEvent(latest, sessionEventText)', '"session_queued"'],
          'terminal child results resume the requester session through durable delivery',
        ),
      ),
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

module.exports = { verifyPristineOpenClawContracts };
