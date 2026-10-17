'use strict';

const fs = require('fs');
const path = require('path');
const {
  beginRuntimePatchPhase,
  endRuntimePatchPhase,
  readRuntimeTextFile,
} = require('../patches/v2026.10.4/_patch-utils.js');

const TARGET_VERSION = '2026.10.4';
const PROVIDER_TRANSPORT_BASENAME = 'openai-completions-transport-QYABn8Uz.mjs';
const COMPLETIONS_PROVIDER_BASENAME = 'openai-completions-XvUwdvJc.mjs';

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

// The locked provider and managed transport share this producer. Resolve only
// its audited import graph; the shared index admits only explicit writable targets.
function resolveNativeProviderTransportArtifact(runtimeDir, options = {}) {
  const root = path.resolve(runtimeDir, 'node_modules', '@openclaw', 'ai');
  const packagePath = path.join(root, 'package.json');
  const runtimePackagePath = path.join(runtimeDir, 'package.json');
  const declared = fs.existsSync(runtimePackagePath)
    ? JSON.parse(fs.readFileSync(runtimePackagePath, 'utf8')).dependencies?.['@openclaw/ai']
    : undefined;
  if (declared !== undefined && declared !== TARGET_VERSION)
    throw new Error(`OpenClaw must pin @openclaw/ai@${TARGET_VERSION}`);
  if (!fs.existsSync(packagePath)) {
    if (options.required || declared !== undefined)
      throw new Error('Locked @openclaw/ai dependency is missing; rebuild pristine runtime.');
    return null;
  }
  const file = path.join(root, 'dist', PROVIDER_TRANSPORT_BASENAME);
  const transportsPath = path.join(root, 'dist', 'transports.mjs');
  const providersPath = path.join(root, 'dist', 'providers.mjs');
  const providerPath = path.join(root, 'dist', COMPLETIONS_PROVIDER_BASENAME);
  const proofFiles = [packagePath, transportsPath, providersPath, providerPath, file].sort();
  const runtimeRoot = fs.realpathSync(runtimeDir);
  for (const proofFile of proofFiles) {
    const relative = path.relative(runtimeRoot, fs.realpathSync(proofFile));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !fs.statSync(proofFile).isFile())
      throw new Error('Locked @openclaw/ai provider transport escaped the runtime.');
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (pkg.name !== '@openclaw/ai' || pkg.version !== TARGET_VERSION)
    throw new Error(`Expected @openclaw/ai@${TARGET_VERSION}`);
  if (pkg.exports?.['./transports']?.import !== './dist/transports.mjs' ||
      pkg.exports?.['./providers']?.import !== './dist/providers.mjs')
    throw new Error('Locked @openclaw/ai provider or transport export changed.');
  const importsProducer = (sourcePath, binding) => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu)]
      .filter(match => match[2] === `./${PROVIDER_TRANSPORT_BASENAME}`);
    return imports.length === 1 && imports[0][1].split(',').some(specifier => specifier.trim() === binding);
  };
  const providers = fs.readFileSync(providersPath, 'utf8');
  if (!importsProducer(transportsPath, 't as createOpenAICompletionsTransportStreamFn') ||
      !importsProducer(providerPath, 'n as streamOpenAICompletionsRequest') ||
      !providers.includes(`createLazyRegistration("openai-completions", () => import("./${COMPLETIONS_PROVIDER_BASENAME}")`) ||
      !fs.readFileSync(providerPath, 'utf8').includes('streamOpenAICompletionsRequest(model, context, options, "direct")'))
    throw new Error('Locked @openclaw/ai no longer imports the audited tool-call producer.');
  return { file, proofFiles };
}

// Check the installed producer before any integration source writes. Separate
// files cannot contribute disconnected keyword evidence for this contract.
function verifyNativeProviderTransportContracts(runtimeDir) {
  const artifact = resolveNativeProviderTransportArtifact(runtimeDir, { required: true });
  return findFileWithAll([artifact.file], [
    'function finalizeOpenAICompletionsToolCalls(',
    'options.allowSilentToolCallPromotion !== false',
    'candidate.text.trim().length > 0',
    'output.stopReason = "toolUse"',
    'output.stopReason = "error"',
    'Provider returned an incomplete or malformed tool call',
    'finalizeTerminalToolCallArguments(',
  ], 'OpenAI silent-only promotion and malformed tool-call rejection in @openclaw/ai');
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
        'prepareSessionFollowupCleanup(',
        '!requestedRunId ? { cascadeDescendants: true }',
      ],
    },
    {
      label:
        'session Stop signals the parent before awaiting descendants and reports partial failure',
      fragments: [
        'if (params.cascadeDescendants && plan.canCascade)',
        'descendants = await abortControlledSubagents({',
        'beforeKill: () => {', 'plan.abort();',
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
        'tree.children.map((child) => visit(child, suppressDescendantWakes))',
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
  if (pkg.dependencies?.['@openclaw/ai'] !== TARGET_VERSION)
    throw new Error(`Pristine OpenClaw must pin @openclaw/ai@${TARGET_VERSION}`);
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
          ['for (const field of ["thinkingSignature", "openclawReasoningReplay"])', 'delete entry[field]'],
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
      // The generic durable task registry was retired in 9.7. Subagent state is native.
      'native-decision-tool': findFileWithAll(
        files,
        ['name: "decision_evaluate"', 'createDecisionTool'],
        'provider-neutral native decision evaluation tool',
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
          ['scheduleSessionDelivery(durableQueue.id, durableQueue.context)', 'disposition: "session_queued"'],
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
      'native-peer-writer-scope': uniqueEvidence(
        findFileWithAll(files, [
          'const runInCallerContext = AsyncLocalStorage.snapshot()',
          'runInCallerContext(() => callAgentToolGatewayRequestBound(',
        ], 'caller context restored before native in-process dispatch'),
        findFileWithAll(files, [
          'method === "agent" ? await runWithoutOwnedSessionTranscriptWrites(',
          'runOutsideOperatorToolGatewayAuthority(() => run(resolved))',
          'captured.authority.assertCurrent()',
          'releaseOperatorAuthority?.()',
        ], 'agent dispatch detaches the writer after capturing and checking authority'),
        findFileWithAll(files, [
          'function runWithoutOwnedSessionTranscriptWrites(run)',
          'ownedTranscriptWriteContext.exit(() => runWithCliHistoryWriter(void 0, run))',
        ], 'native detach clears transcript and CLI-history scope together'),
      ),
      'openai-visible-stop-tool-safety': findFileWithAll(
        files,
        [
          'wrapStreamFnSanitizeMalformedToolCalls(',
          'wrapStreamFnPromoteStandaloneTextToolCalls(',
          'wrapStreamFnHandleSensitiveStopReason(',
        ],
        'native stream sanitation; pinned @openclaw/ai transport is verified after dependency installation',
      ),
    };

    const repoRoot = options.repoRoot ?? path.resolve(__dirname, '../..');
    const patchFiles = options.patchFiles ?? listPatchFiles(repoRoot);
    const retainedGaps = verifyRetainedGaps(runtimeDir, patchFiles);
    return { version: TARGET_VERSION, upstream, retainedGaps };
  } finally {
    endRuntimePatchPhase(runtimeDir);
  }
}

module.exports = {
  verifyPristineOpenClawContracts,
  verifyNativeSessionStopContracts,
  verifyNativeProviderTransportContracts,
  resolveNativeProviderTransportArtifact,
};

if (require.main === module) {
  const runtimeDir = process.argv[2];
  if (!runtimeDir) {
    throw new Error('Usage: node scripts/openclaw/verify-openclaw-pristine-contracts.cjs <runtime-dir>');
  }
  const result = verifyPristineOpenClawContracts(path.resolve(runtimeDir));
  console.log(
    `[verify-openclaw-pristine-contracts] ${result.version}: ` +
      `${Object.keys(result.upstream).length} upstream contracts, ` +
      `${result.retainedGaps.length} retained gaps verified`,
  );
}
