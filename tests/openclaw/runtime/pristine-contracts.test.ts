import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { verifyPristineOpenClawContracts, verifyNativeSessionStopContracts, verifyNativeProviderTransportContracts } =
  require('../../../scripts/openclaw/verify-openclaw-pristine-contracts.cjs') as {
    verifyNativeSessionStopContracts: (runtimeDir: string) => string[];
    verifyNativeProviderTransportContracts: (runtimeDir: string) => string[];
    verifyPristineOpenClawContracts: (
      runtimeDir: string,
      options: { patchFiles: string[] },
    ) => {
      version: string;
      upstream: Record<string, string[]>;
      retainedGaps: string[];
    };
  };

const temporaryRoots: string[] = [];

const EXPECTED_PATCH_FILES = [
  '001-managed-pip-config-environment.cjs',
  '002-final-system-prompt-replacements.cjs',
  '003-agent-request-metadata.cjs',
  '004-request-purpose-metadata.cjs',
  '005-app-startup-task-recovery-boundary.cjs',
  '006-goal-resume-after-pause.cjs',
  '007-assistant-display-block-replay.cjs',
  '008-trusted-local-file-media.cjs',
  '009-offline-official-plugin-catalog.cjs',
  '010-disable-configured-plugin-auto-install.cjs',
  '011-reset-display-history.cjs',
  '012-managed-session-fork-target-key.cjs',
  '013-mxc-external-skill-paths.cjs',
  '014-private-untrusted-context.cjs',
  '015-admin-session-cwd.cjs',
  '016-cron-session-permission.cjs',
  '017-windows-servicing-credential-launcher.cjs',
  '018-windows-session-creation-path.cjs',
  '019-plugin-owned-execution.cjs',
  '020-shared-terminal-launch.cjs',
  '021-terminal-product-banner.cjs',
  '022-native-compaction-lifecycle.cjs',
  '023-computer-overlay-activity.cjs',
  '024-windows-plugin-recovery-junctions.cjs',
  '025-nonblocking-sqlite-retirement.cjs',
  '026-scoped-finalize-hook-admission.cjs',
  '027-canonical-readiness-owner-path.cjs',
  '028-prepared-history-response-publication.cjs',
] as const;

const UPSTREAM_CONTRACTS = [
  'live-thinking-stream',
  'history-display-projection',
  'native-tool-directory',
  'native-session-goals',
  'native-decision-tool',
  'subagent-queue-and-wait',
  'native-session-stop',
  'persistent-approval-lifecycle',
  'native-approval-timeouts',
  'compaction-and-context-budget',
  'native-peer-writer-scope',
  'openai-visible-stop-tool-safety',
] as const;

const NATIVE_STOP_FIXTURES = {
  'session-stop.js':
    '"sessions.abort": if (clearQueued && canonicalKey !== "global") prepareSessionFollowupCleanup(); ' +
    '!requestedRunId ? { cascadeDescendants: true } : {};',
  'session-stop-cascade.js':
    'if (params.cascadeDescendants && plan.canCascade) ' +
    'descendants = await abortControlledSubagents({ beforeKill: () => { plan.abort(); } }); ' +
    'descendant cancellation was incomplete',
  'session-stop-tree.js':
    'async function killSubagentRunTree() { ' +
    'if (!tree.entry.execution.endedAt) stop(); result.descendants = true; ' +
    'if (result.descendants && tree.canTraverse()) tree.children.map((child) => visit(child, suppressDescendantWakes)); }',
  'session-stop-run.js':
    'function abortChatRunById() { ' +
    'releaseAgentRunDelegatedAuthority(active.agentRunDelegatedAuthority); ' +
    'ops.onRunAborted?.(runId); active.controller.abort(createChatAbortSignalReason(stopReason)); ' +
    'broadcastChatAborted(ops); status: "cancelled"; }',
  'session-stop-ops.js':
    'function createChatAbortOps() { ' + 'context.cancelRunBoundApprovals?.(runId).catch; }',
  'session-stop-approvals.js':
    'function cancelAgentRuntimeBoundApprovals() {} ' +
    'function cancelUnboundRunApprovals() {} ' +
    'params.manager.forceDenyDetailed(pending.id, "run-aborted"); ' +
    'pending.request.runId === params.runId; registerAgentRunDelegatedAuthorityClosedHandler;',
};

function writeDistFile(root: string, name: string, content: string): void {
  fs.writeFileSync(path.join(root, 'dist', name), content);
}

function createPristineFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-pristine-contracts-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'openclaw', version: '2026.10.4', dependencies: { '@openclaw/ai': '2026.10.4' } }),
  );
  writeDistFile(
    root,
    'thinking.js',
    'evtType === "thinking_start"; evtType === "thinking_delta"; ' +
      'ctx.emitReasoningStream(partialThinking || thinkingContent || thinkingDelta);',
  );
  writeDistFile(
    root,
    'history-private.js',
    'for (const field of ["thinkingSignature", "openclawReasoningReplay"]) delete entry[field];',
  );
  writeDistFile(
    root,
    'history-types.js',
    'type === "thinking" || type === "reasoning" || type === "redacted_thinking";',
  );
  writeDistFile(
    root,
    'tool-directory.js',
    'toolSearchConfig.mode === "directory"; applyToolSchemaDirectoryCatalog;',
  );
  writeDistFile(
    root,
    'tool-controls.js',
    'createToolSearchTools({ catalogRef: options?.toolSearchCatalogRef });',
  );
  writeDistFile(
    root,
    'goal-context.js',
    'ACTIVE_GOAL_CONTEXT_PREFIX = "Active goal: "; goal?.status !== "active";',
  );
  writeDistFile(root, 'goal-tools.js', 'create_goal; update_goal; get_goal;');
  writeDistFile(
    root,
    'goal-rpc.js',
    '"sessions.goal.update": validateSessionsGoalUpdateParams; "sessions.goal.clear":;',
  );
  writeDistFile(
    root,
    'goal-start.js',
    'action: "start"; operationId: p.idempotencyKey; issuedAtMs: p.intent.issuedAtMs;',
  );
  writeDistFile(root, 'decision-tool.js', 'name: "decision_evaluate"; createDecisionTool;');
  writeDistFile(
    root,
    'subagent-lane.js',
    'setCommandLaneConcurrency("subagent", concurrency.subagent);',
  );
  writeDistFile(root, 'subagent-spawn.js', 'lane: AGENT_LANE_SUBAGENT; status: "accepted";');
  writeDistFile(
    root,
    'agents-wait.js',
    'name: "agents_wait"; state.completed.length > 0; state.pending.length === 0;',
  );
  writeDistFile(
    root,
    'task-delivery.js',
    'scheduleSessionDelivery(durableQueue.id, durableQueue.context); disposition: "session_queued";',
  );
  writeDistFile(
    root,
    'approval-wait.js',
    'function observeAgentRunApprovalWait() { pausedMs; state.onChange; }',
  );
  writeDistFile(
    root,
    'approval-outcome.js',
    'resolveExecApprovalWaitOutcome({ approvalId, resolveTimedOut });',
  );
  writeDistFile(
    root,
    'approval-timeouts.js',
    'const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 18e5; ' +
      'const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4; ' +
      'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5; ' +
      'Math.min(MAX_PLUGIN_APPROVAL_TIMEOUT_MS, Math.max(1, Math.floor(value)));',
  );
  writeDistFile(
    root,
    'compaction-budget.js',
    'shouldPreemptivelyCompactBeforePrompt; buildPrePromptContextBudgetStatus;',
  );
  writeDistFile(
    root,
    'compaction-safeguard.js',
    'compactionSafeguardDeps.summarizeInStages; previousSummary;',
  );
  writeDistFile(
    root,
    'openai-tool-safety.js',
    'wrapStreamFnSanitizeMalformedToolCalls(); wrapStreamFnPromoteStandaloneTextToolCalls(); wrapStreamFnHandleSensitiveStopReason();',
  );
  writeDistFile(root, 'peer-caller.js', 'const runInCallerContext = AsyncLocalStorage.snapshot(); runInCallerContext(() => callAgentToolGatewayRequestBound());');
  writeDistFile(root, 'peer-dispatch.js', 'method === "agent" ? await runWithoutOwnedSessionTranscriptWrites(runOutsideOperatorToolGatewayAuthority(() => run(resolved))); captured.authority.assertCurrent(); releaseOperatorAuthority?.();');
  writeDistFile(root, 'peer-writer.js', 'function runWithoutOwnedSessionTranscriptWrites(run) { return ownedTranscriptWriteContext.exit(() => runWithCliHistoryWriter(void 0, run)); }');
  for (const [name, content] of Object.entries(NATIVE_STOP_FIXTURES)) {
    writeDistFile(root, name, content);
  }
  return root;
}

function writePatch(root: string, verifies: boolean): string {
  const patchPath = path.join(root, verifies ? 'redundant.cjs' : 'required.cjs');
  fs.writeFileSync(
    patchPath,
    verifies
      ? 'module.exports.verifyPatch = () => true;'
      : "module.exports.verifyPatch = () => { throw new Error('pristine gap'); };",
  );
  return patchPath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw pristine artifact contracts', () => {
  test('binds the separately installed provider transport to its exact identity and connected source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-contract-'));
    temporaryRoots.push(root);
    const ai = path.join(root, 'node_modules/@openclaw/ai');
    fs.mkdirSync(path.join(ai, 'dist'), { recursive: true });
    const packagePath = path.join(ai, 'package.json');
    const sourcePath = path.join(ai, 'dist/transport.mjs');
    const source = `function finalizeOpenAICompletionsToolCalls(output, candidate, options) {
      if (options.allowSilentToolCallPromotion !== false && candidate.text.trim().length > 0) output.stopReason = "toolUse";
      else { output.stopReason = "error"; throw Error("Provider returned an incomplete or malformed tool call"); }
      finalizeTerminalToolCallArguments(output);
    }`;
    fs.writeFileSync(packagePath, JSON.stringify({ name: '@openclaw/ai', version: '2026.10.4' }));
    fs.writeFileSync(sourcePath, source);
    expect(verifyNativeProviderTransportContracts(root)).toEqual(['transport.mjs']);
    fs.writeFileSync(packagePath, JSON.stringify({ name: '@openclaw/ai', version: '2026.9.8' }));
    expect(() => verifyNativeProviderTransportContracts(root)).toThrow('Expected @openclaw/ai@2026.10.4');
    fs.writeFileSync(packagePath, JSON.stringify({ name: '@openclaw/ai', version: '2026.10.4' }));
    fs.writeFileSync(sourcePath, source.replace('finalizeTerminalToolCallArguments(output);', ''));
    fs.writeFileSync(path.join(ai, 'dist/unrelated.mjs'), 'finalizeTerminalToolCallArguments(output);');
    expect(() => verifyNativeProviderTransportContracts(root)).toThrow('malformed tool-call rejection');
  });
  test.each(Object.keys(NATIVE_STOP_FIXTURES))(
    'rejects an artifact missing native Stop capability in %s',
    name => {
      const root = createPristineFixture();
      fs.unlinkSync(path.join(root, 'dist', name));

      expect(() => verifyPristineOpenClawContracts(root, { patchFiles: [] })).toThrow(
        /Pristine OpenClaw contract is missing: .*Stop/,
      );
    },
  );

  test('does not combine disconnected native Stop wiring into evidence', () => {
    const root = createPristineFixture();
    writeDistFile(root, 'session-stop-ops.js', 'function createChatAbortOps() {}');
    writeDistFile(root, 'unrelated-stop.js', 'context.cancelRunBoundApprovals?.(runId).catch');

    expect(() => verifyNativeSessionStopContracts(root)).toThrow(
      /run Stop connects native approval cancellation/,
    );
  });

  test('keeps the independently auditable v2026.10.4 patch inventory exact', () => {
    const patchDir = path.resolve('scripts', 'patches', 'v2026.10.4');
    const patchFiles = fs
      .readdirSync(patchDir)
      .filter(name => /^\d.*\.cjs$/.test(name))
      .sort();

    expect(patchFiles).toEqual(EXPECTED_PATCH_FILES);
    const lineBudgets: Record<string, number> = {
      // Fork admission audits schema, handler forwarding and native/worker
      // projections together, including rejection of partially applied fields.
      '012-managed-session-fork-target-key.cjs': 625,
      '019-plugin-owned-execution.cjs': 1200,
    };
    for (const name of patchFiles) {
      const content = fs.readFileSync(path.join(patchDir, name), 'utf8');
      const head = content.split(/\r?\n/u).slice(0, 16).join('\n');
      for (const label of ['Capability', 'Target', 'Scope', 'Safety', 'Remove when']) {
        expect(head, `${name} is missing ${label}`).toContain(`// ${label}:`);
      }
      // Owned execution audits multiple registry, dispatch and tool lifetime
      // seams together; keep its explicit budget bounded without relaxing others.
      const lineBudget = lineBudgets[name] ?? 600;
      expect(content.split(/\r?\n/u).length).toBeLessThan(lineBudget);
    }
  });

  test('records upstream replacements and requires retained patches to fail pristine verification', () => {
    const root = createPristineFixture();
    const result = verifyPristineOpenClawContracts(root, {
      patchFiles: [writePatch(root, false)],
    });

    expect(result.version).toBe('2026.10.4');
    expect(Object.keys(result.upstream)).toEqual(UPSTREAM_CONTRACTS);
    expect(result.retainedGaps).toEqual(['required.cjs']);
  });

  test('rejects a redundant patch or a previously patched runtime', () => {
    const root = createPristineFixture();
    expect(() =>
      verifyPristineOpenClawContracts(root, { patchFiles: [writePatch(root, true)] }),
    ).toThrow(/already verifies on the pristine npm artifact/);

    fs.writeFileSync(path.join(root, 'runtime-patch-manifest.json'), '{}');
    expect(() =>
      verifyPristineOpenClawContracts(root, { patchFiles: [writePatch(root, false)] }),
    ).toThrow(/rejected prebuilt artifact/);
  });

  test('rejects keyword-only evidence split across unrelated files', () => {
    const root = createPristineFixture();
    const thinkingPath = path.join(root, 'dist', 'thinking.js');
    const thinking = fs.readFileSync(thinkingPath, 'utf8');
    fs.writeFileSync(thinkingPath, thinking.replace('evtType === "thinking_delta";', ''));
    writeDistFile(root, 'unrelated.js', 'evtType === "thinking_delta";');

    expect(() =>
      verifyPristineOpenClawContracts(root, { patchFiles: [writePatch(root, false)] }),
    ).toThrow(/incremental thinking deltas/);
  });
});
