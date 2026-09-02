import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { verifyPristineOpenClawContracts } =
  require('../../../scripts/verify-openclaw-pristine-contracts.cjs') as {
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
  '002-windows-mcp-package-runner.cjs',
  '003-chrome-mcp-launch-diagnostics.cjs',
  '004-chrome-mcp-empty-page-recovery.cjs',
  '005-final-system-prompt-replacements.cjs',
  '006-agent-request-metadata.cjs',
  '007-request-purpose-metadata.cjs',
  '008-app-startup-task-recovery-boundary.cjs',
  '009-memory-force-reembed-opt-in.cjs',
  '010-configurable-exec-approval-timeout.cjs',
  '011-plugin-approval-detail-forwarding.cjs',
  '012-configurable-plugin-approval-timeout.cjs',
] as const;

const UPSTREAM_CONTRACTS = [
  'live-thinking-stream',
  'history-display-projection',
  'native-tool-directory',
  'native-session-goals',
  'native-task-rpc-and-events',
  'subagent-queue-and-wait',
  'persistent-approval-lifecycle',
  'compaction-and-context-budget',
  'openai-visible-stop-tool-safety',
] as const;

function writeDistFile(root: string, name: string, content: string): void {
  fs.writeFileSync(path.join(root, 'dist', name), content);
}

function createPristineFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-pristine-contracts-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'openclaw', version: '2026.8.1' }),
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
    'delete entry.thinkingSignature; delete entry.openclawReasoningReplay;',
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
    'tasks-rpc.js',
    '"tasks.list": validateTasksListParams; nextCursor; ' +
      '"tasks.get": validateTasksGetParams; getTaskById;',
  );
  writeDistFile(root, 'task-events.js', 'kind: "upserted"; cloneTaskRecord(task);');
  writeDistFile(
    root,
    'subagent-lane.js',
    'setCommandLaneConcurrency("subagent", concurrency.subagent);',
  );
  writeDistFile(
    root,
    'subagent-spawn.js',
    'lane: AGENT_LANE_SUBAGENT; status: "accepted";',
  );
  writeDistFile(
    root,
    'agents-wait.js',
    'name: "agents_wait"; state.completed.length > 0; state.pending.length === 0;',
  );
  writeDistFile(
    root,
    'task-delivery.js',
    'queueTaskSystemEvent(latest, sessionEventText); "session_queued";',
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
    'allowSilentToolCallPromotion; Provider returned an incomplete or malformed tool call; ' +
      'stopReason=`toolUse`; stopReason=`error`;',
  );
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
  test('keeps exactly twelve independently auditable v2026.8.1 patches', () => {
    const patchDir = path.resolve('scripts', 'patches', 'v2026.8.1');
    const patchFiles = fs
      .readdirSync(patchDir)
      .filter(name => /^\d.*\.cjs$/.test(name))
      .sort();

    expect(patchFiles).toEqual(EXPECTED_PATCH_FILES);
    for (const name of patchFiles) {
      const content = fs.readFileSync(path.join(patchDir, name), 'utf8');
      const head = content.split(/\r?\n/u).slice(0, 16).join('\n');
      for (const label of ['Capability', 'Target', 'Scope', 'Safety', 'Remove when']) {
        expect(head, `${name} is missing ${label}`).toContain(`// ${label}:`);
      }
      expect(content.split(/\r?\n/u).length).toBeLessThan(600);
    }
  });

  test('records upstream replacements and requires retained patches to fail pristine verification', () => {
    const root = createPristineFixture();
    const result = verifyPristineOpenClawContracts(root, {
      patchFiles: [writePatch(root, false)],
    });

    expect(result.version).toBe('2026.8.1');
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
