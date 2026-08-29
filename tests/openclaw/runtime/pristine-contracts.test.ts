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
  '002-live-thinking-stream.cjs',
  '003-openai-think-tag-reasoning.cjs',
  '004-history-display-projection.cjs',
  '005-default-cron-delivery-none.cjs',
  '006-windows-mcp-package-runner.cjs',
  '007-chrome-mcp-launch-diagnostics.cjs',
  '008-chrome-mcp-empty-page-recovery.cjs',
  '009-selective-tool-schema-catalog.cjs',
  '010-final-system-prompt-replacements.cjs',
  '011-silent-session-goal-clear.cjs',
  '012-subagent-task-title-projection.cjs',
  '013-atomic-sessions-spawn-admission.cjs',
  '014-subagent-pending-lifecycle.cjs',
  '015-completion-branch-promotion.cjs',
  '016-completion-delivery-queue.cjs',
  '017-managed-session-classification.cjs',
  '018-managed-same-run-join.cjs',
  '019-managed-join-commits.cjs',
  '020-managed-join-recovery.cjs',
  '021-managed-join-identity-delivery.cjs',
  '022-persistent-interactive-approval-lifetime.cjs',
  '023-approval-run-suspension.cjs',
  '024-approval-resolution-resume.cjs',
  '025-approval-stop-and-failure.cjs',
  '026-parent-session-identity.cjs',
  '027-agent-request-metadata.cjs',
  '028-request-purpose-metadata.cjs',
  '029-retained-user-compaction-context.cjs',
  '030-codex-continuation-compaction.cjs',
  '031-compaction-emergency-handoff.cjs',
  '032-sanitized-run-progress-events.cjs',
  '033-tool-error-reasoning-recovery.cjs',
  '034-live-context-budget-publication.cjs',
  '035-codex-local-compaction-semantics.cjs',
  '036-managed-session-identity-pin.cjs',
  '037-context-overflow-convergence.cjs',
  '038-case-insensitive-subagent-task-names.cjs',
  '039-recovery-compaction-progress.cjs',
  '040-compaction-error-attribution.cjs',
  '041-managed-implicit-subagent-join.cjs',
  '042-required-subagent-terminal-guard.cjs',
  '043-completion-delivery-followup-join.cjs',
  '044-managed-terminal-handoff.cjs',
  '045-openai-stop-tool-call-compat.cjs',
  '046-app-startup-task-recovery-boundary.cjs',
  '047-openai-compatible-embedding-env-proxy.cjs',
  '048-memory-force-reembed-opt-in.cjs',
] as const;

function createPristineFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-pristine-contracts-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'openclaw', version: '2026.7.1-2' }),
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'reasoning.js'),
    'resolvedReasoningLevel: params.resolvedReasoningLevel; buildStatusReply({});',
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'reply.js'),
    'REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE; TELEGRAM_PLUGIN_CALLBACK_SUBMIT_RETRY_DELAYS_MS; sleepWithAbort(retryDelayMs);',
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'budget.js'),
    [
      'buildPrePromptContextBudgetStatus({}); contextBudgetStatus,;',
      'lastContextBudgetStatus; contextBudgetStatus: lastContextBudgetStatus;',
      'contextBudgetStatus: entry?.contextBudgetStatus;',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'active.js'),
    [
      'function hasTrackedActiveSessionRun(params) {}',
      'return resolveVisibleActiveSessionRunState();',
      'hasActiveRun: activeRunState.active',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'goal.js'),
    `const MAX_ACTIVE_GOAL_OBJECTIVE_CHARS = 200;
const ACTIVE_GOAL_CONTEXT_PREFIX = "Active goal: ";
const ACTIVE_GOAL_CONTEXT_SUFFIX = " — advance it or update its status (get_goal/update_goal).";
function formatActiveGoalContext(sessionEntry) {
  const goal = sessionEntry?.goal;
  if (goal?.status !== "active") return;
  const objective = goal.objective.replace(/\\s+/g, " ").trim();
  const boundedObjective = objective.length <= MAX_ACTIVE_GOAL_OBJECTIVE_CHARS ? objective : objective.slice(0, MAX_ACTIVE_GOAL_OBJECTIVE_CHARS);
  return \`${'${'}ACTIVE_GOAL_CONTEXT_PREFIX}${'${'}boundedObjective}${'${'}ACTIVE_GOAL_CONTEXT_SUFFIX}\`;
}
async function updateSessionGoalObjective(options) {
  const now = Date.now();
  return patchSessionEntry({}, (entry) => {
    const accounted = accountGoalUsage(entry, now);
    if (TERMINAL_GOAL_STATUSES.has(accounted.status)) throw new Error("terminal");
    return { goal: { ...accounted, objective, updatedAt: now } };
  });
}
async function command(parsed) {
  switch (parsed.action) {
    case "edit": {
      const goal = await updateSessionGoalObjective({ objective: parsed.text });
      return \`Goal updated: ${'${'}goal.objective}\`;
    }
  }
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'goal-admission.js'),
    `
const refreshInboundContextAfterAdmissionWait = async () => {
  activeGoalContext = formatActiveGoalContext(inboundContextSessionEntry);
};
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'chat-schema.js'),
    `const ChatSendParamsSchema = Type.Object({
  message: Type.String(),
  idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const ChatAbortParamsSchema = Type.Object({});
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'codex-goal-results.js'),
    `function isCodexToolResultError(details) {
  const status = details.status.trim().toLowerCase();
  return status !== "created" &&
    status !== "updated" &&
    status !== "found" &&
    status !== "missing";
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'empty-response.js'),
    `function isEmptyResponseAssistantTurn(params) {
  if (params.payloadCount !== 0) return false;
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) return false;
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  return !assistant;
}
function resolveEmptyResponseRetryInstruction(params) {
  if (!isEmptyResponseAssistantTurn({
    payloadCount: params.payloadCount,
    attempt: params.attempt
  })) return null;
  return EMPTY_RESPONSE_RETRY_INSTRUCTION;
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'empty-response-runner.js'),
    `function runEmptyResponseRetry() {
  for (;;) {
    const nextEmptyResponseRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveEmptyResponseRetryInstruction({});
    if (!nextReasoningOnlyRetryInstruction && nextEmptyResponseRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {
      emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;
      continue;
    }
    break;
  }
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'yield.js'),
    `function createSessionsYieldTool(opts) {
  return { execute: async (_toolCallId, args) => {
    const message = args.message || "Turn yielded.";
    if (!opts?.sessionId) return jsonResult({ status: "error" });
    if (!opts?.onYield) return jsonResult({ status: "error" });
    await opts.onYield(message);
    return jsonResult({ status: "yielded", message });
  } };
}
function buildYieldContext() {
  return { onYield: (message) => {
    yieldDetected = true;
    queueYieldInterruptForSession?.();
    runAbortController.abort("sessions_yield");
    abortSessionForYield?.();
  } };
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'compaction.js'),
    `async function summarizeViaLLM(params) {
  const messages = prependPreviousSummaryForRedistill({
    messages: params.messages,
    previousSummary: params.previousSummary
  });
  return compactionSafeguardDeps.summarizeInStages({
    messages,
    previousSummary: void 0
  });
}
function splitPreservedRecentTurns(params) {
  for (const message of params.messages) {
    const role = message.role;
    if (role === "user" || role === "assistant") selected.add(message);
    if (message.role !== "assistant") continue;
  }
  return {
    summarizableMessages: repairToolUseResultPairing(params.messages).messages,
    preservedMessages: params.messages.filter((msg) => {
      const role = msg.role;
      return role === "user" || role === "assistant" || role === "toolResult";
    })
  };
}
function formatContextMessages(messages) {
  return messages.map((message) => {
    let roleLabel;
    if (message.role === "assistant") roleLabel = "Assistant";
    else if (message.role === "toolResult") roleLabel = "Tool result";
    const rendered = message.text;
    return rendered.length > MAX_RECENT_TURN_TEXT_CHARS ? truncateUtf16Safe(rendered, MAX_RECENT_TURN_TEXT_CHARS) : rendered;
  });
}
function compactionSafeguardExtension(api) {
  api.on("session_before_compact", async ({ preparation }) => {
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);
    const baseTurnPrefixMessages = preparation.turnPrefixMessages;
    const turnPrefixMessages = baseTurnPrefixMessages;
    splitPreservedRecentTurns({ messages: baseMessagesToSummarize });
    const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;
    summarizeViaLLM({ previousSummary: effectivePreviousSummary });
    if (preparation.isSplitTurn && turnPrefixMessages.length > 0) summarizeViaLLM({
      messages: turnPrefixMessages,
      previousSummary: effectivePreviousSummary
    });
  });
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'compaction-planning.js'),
    `function sanitizeCompactionMessages(messages) {
  return stripToolResultDetails(stripRuntimeContextCustomMessages(messages));
}
function buildSummaryChunks(params) {
  return chunkMessagesByMaxTokens(sanitizeCompactionMessages(params.messages), params.maxChunkTokens);
}
function buildOversizedFallbackPlan(params) {
  const smallMessages = [];
  const oversizedNotes = [];
  const oversizedThreshold = params.contextWindow * .5;
  for (const msg of params.messages) {
    const tokens = estimateTokens(msg);
    if (tokens * 1.2 > oversizedThreshold) {
      oversizedNotes.push(\`[Large message omitted from summary]\`);
    } else smallMessages.push(msg);
  }
  return { smallMessages, oversizedNotes };
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'subagent-registry.js'),
    `function createSubagentRunManager(params) {
  const registerSubagentRun = (registerParams) => {
    const entry = normalizeSubagentRunState({ taskName: registerParams.taskName, });
    params.runs.set(runId, entry);
    params.persistOrThrow();
  };
  return { registerSubagentRun };
}
`,
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'subagent-registry-state.js'),
    `function rowToSubagentRunRecord(row) {
  const payload = parseJson(row.payload_json) ?? {};
  const record = normalizeSubagentRunState({
    ...payload,
    ...row.task_name ? { taskName: row.task_name } : {},
  });
  return record;
}
function subagentRunRecordToSqliteInsert(entry) {
  const normalized = normalizeSubagentRunState(structuredClone(entry));
  return {
    task_name: normalized.taskName ?? null,
    payload_json: JSON.stringify(normalized)
  };
}
function saveSubagentRegistryToSqlite(runs) {
  for (const entry of runs.values()) {
    const values = subagentRunRecordToSqliteInsert(entry);
    stateDb.insertInto("subagent_runs").values(values).onConflict((conflict) => conflict.column("run_id").doUpdateSet(subagentRunRecordToSqliteUpdate(values)));
  }
}
`,
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
  test('every current capability patch declares its contract at the file head', () => {
    const patchDir = path.resolve('scripts', 'patches', 'v2026.7.1-2');
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
      expect(
        content.split(/\r?\n/u).length,
        `${name} should remain independently auditable`,
      ).toBeLessThan(600);
    }
  });

  test('records upstream replacements and requires every retained patch to fail pristine verification', () => {
    const root = createPristineFixture();
    const result = verifyPristineOpenClawContracts(root, {
      patchFiles: [writePatch(root, false)],
    });

    expect(result.version).toBe('2026.7.1-2');
    expect(Object.keys(result.upstream)).toEqual([
      '009-reply-conflict-retry',
      '014-context-budget-native-state',
      '020-active-run-native-state',
      '021-native-active-goal-context',
      '022-native-goal-objective-edit',
      '023-chat-send-agent-continuation-gap',
      '024-codex-goal-result-success',
      '005-visible-stop-usage-independent',
      '006-sessions-yield-active-or-pending',
      '011-compaction-summary-input',
      '025-subagent-task-name-persistence',
    ]);
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
    const emptyResponsePath = path.join(root, 'dist', 'empty-response.js');
    const emptyResponse = fs.readFileSync(emptyResponsePath, 'utf8');
    fs.writeFileSync(
      emptyResponsePath,
      emptyResponse.replace('if (params.payloadCount !== 0) return false;', ''),
    );
    fs.writeFileSync(
      path.join(root, 'dist', 'unrelated-keywords.js'),
      'if (params.payloadCount !== 0) return false;',
    );

    expect(() =>
      verifyPristineOpenClawContracts(root, { patchFiles: [writePatch(root, false)] }),
    ).toThrow(/visible assistant payload\/text excludes empty-response retry/);
  });
});
