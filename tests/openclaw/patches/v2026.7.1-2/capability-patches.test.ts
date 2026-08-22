import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const approvalPatch =
  require('../../../../scripts/patches/v2026.7.1-2/022-persistent-interactive-approval-lifetime.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
  };
const metadataPatch = require('../../../../scripts/patches/v2026.7.1-2/027-agent-request-metadata.cjs') as {
  applyPatch: (runtimeRoot: string) => string[];
  verifyPatch: (runtimeRoot: string) => void;
};
const emergencyCompactionPatch =
  require('../../../../scripts/patches/v2026.7.1-2/031-compaction-emergency-handoff.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
  };
const finalSystemPromptPatch =
  require('../../../../scripts/patches/v2026.7.1-2/010-final-system-prompt-replacements.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
  };
const toolErrorRecoveryPatch =
  require('../../../../scripts/patches/v2026.7.1-2/033-tool-error-reasoning-recovery.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
  };

const temporaryRoots: string[] = [];

function createRuntime(): string {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-2026-7-1-'));
  temporaryRoots.push(runtimeRoot);
  fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
  return runtimeRoot;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw v2026.7.1-2 focused capability patches', () => {
  test('applies final replacements to hook output plus model-aware additions before cache observation', async () => {
    const runtimeRoot = createRuntime();
    const target = path.join(runtimeRoot, 'gateway-bundle.mjs');
    const rulesPath = path.join(runtimeRoot, 'system-prompt-replacements.json');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify([
        {
          pattern: 'hooked\\|model-aware',
          replacement: 'final-system-prompt',
        },
      ]),
    );
    fs.writeFileSync(
      target,
      `function appendModelIdentitySystemPrompt({ systemPrompt }) {
  return \`${'${'}systemPrompt}|model-aware\`;
}
async function runEmbeddedAttempt(params) {
  let systemPromptText = params.systemPrompt;
  let cacheObservedSystemPrompt = null;
  const cacheObservabilityEnabled = true;
  const setActiveSessionSystemPrompt = (nextSystemPrompt) => {
    systemPromptText = nextSystemPrompt;
  };
  if (params.hookSystemPrompt) setActiveSessionSystemPrompt(params.hookSystemPrompt);
  const runtimeInfo = { model: {} };
  const modelAwareSystemPrompt = appendModelIdentitySystemPrompt({
    systemPrompt: systemPromptText,
    model: runtimeInfo.model
  });
  if (modelAwareSystemPrompt !== systemPromptText) setActiveSessionSystemPrompt(modelAwareSystemPrompt);
        if (cacheObservabilityEnabled) {
    cacheObservedSystemPrompt = systemPromptText;
  }
  return { systemPromptText, cacheObservedSystemPrompt };
}
export { runEmbeddedAttempt };
`,
    );
    const previousRulesPath = process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH;
    process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH = rulesPath;
    try {
      expect(finalSystemPromptPatch.applyPatch(runtimeRoot)).toEqual(['gateway-bundle.mjs']);
      finalSystemPromptPatch.verifyPatch(runtimeRoot);
      const once = fs.readFileSync(target);
      expect(once.toString()).toContain(
        'applyJustDoFinalSystemPromptReplacements(modelAwareSystemPrompt)',
      );
      expect(once.toString()).not.toContain(
        'applyJustDoFinalSystemPromptReplacements(systemPromptText)',
      );

      const runtime = (await import(`${pathToFileURL(target).href}?test=${Date.now()}`)) as {
        runEmbeddedAttempt: (params: {
          systemPrompt: string;
          hookSystemPrompt: string;
        }) => Promise<{ systemPromptText: string; cacheObservedSystemPrompt: string }>;
      };
      await expect(
        runtime.runEmbeddedAttempt({
          systemPrompt: 'base',
          hookSystemPrompt: 'hooked',
        }),
      ).resolves.toEqual({
        systemPromptText: 'final-system-prompt',
        cacheObservedSystemPrompt: 'final-system-prompt',
      });

      expect(finalSystemPromptPatch.applyPatch(runtimeRoot)).toEqual([]);
      expect(fs.readFileSync(target)).toEqual(once);
    } finally {
      if (previousRulesPath === undefined)
        delete process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH;
      else process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH = previousRulesPath;
    }
  });

  test('blocks tool-error recovery after committed delivery, accepted spawn or async tool start', async () => {
    const runtimeRoot = createRuntime();
    fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{"type":"module"}');
    const evidenceModule = path.join(runtimeRoot, 'dist', 'delivery-evidence-Du4oIHR6.js');
    const target = path.join(runtimeRoot, 'dist', 'embedded-agent.js');
    fs.writeFileSync(
      evidenceModule,
      `export const a = (attempt) =>
  (attempt.messagingToolSentTexts ?? []).some((value) => typeof value === 'string' && value.length > 0) ||
  (attempt.messagingToolSentMediaUrls ?? []).some((value) => typeof value === 'string' && value.length > 0) ||
  (attempt.messagingToolSentTargets ?? []).length > 0;
export const c = () => false;
export const l = () => false;
export const p = (spawns) => (spawns ?? []).some((spawn) =>
  typeof spawn?.runId === 'string' && spawn.runId.length > 0 &&
  typeof spawn?.childSessionKey === 'string' && spawn.childSessionKey.length > 0
);
`,
    );
    fs.writeFileSync(
      target,
      `import { c as hasMessagingToolDeliveryEvidence, l as hasOutboundDeliveryEvidence } from "./delivery-evidence-Du4oIHR6.js";
function hasOnlyAssistantReasoningContent(assistant) { return assistant.reasoningOnly === true; }
const maxReasoningOnlyRetryAttempts = 2;
\t\t\tconst maxEmptyResponseRetryAttempts = 1;
let reasoningOnlyRetryAttempts = 0;
\t\t\tlet emptyResponseRetryAttempts = 0;
async function runEmbeddedAttemptWithBackend(params) { return params; }
async function decide() {
  while (false) {
    const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveReasoningOnlyRetryInstruction({});
  }
}
export { isJustDoToolErrorReasoningRecoveryCandidate };
`,
    );

    expect(toolErrorRecoveryPatch.applyPatch(runtimeRoot)).toEqual([
      path.join('dist', 'embedded-agent.js'),
    ]);
    toolErrorRecoveryPatch.verifyPatch(runtimeRoot);
    const once = fs.readFileSync(target);
    const runtime = (await import(`${pathToFileURL(target).href}?test=${Date.now()}`)) as {
      isJustDoToolErrorReasoningRecoveryCandidate: (params: unknown) => boolean;
    };
    const candidate = {
      aborted: false,
      timedOut: false,
      finalAssistantVisibleText: '',
      recoveryAttempts: 0,
      attempt: {
        lastToolError: { message: 'failed' },
        currentAttemptAssistant: { reasoningOnly: true },
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        acceptedSessionSpawns: [],
        toolMetas: [],
      },
    };

    expect(runtime.isJustDoToolErrorReasoningRecoveryCandidate(candidate)).toBe(true);
    expect(
      runtime.isJustDoToolErrorReasoningRecoveryCandidate({
        ...candidate,
        attempt: { ...candidate.attempt, messagingToolSentTexts: ['already delivered'] },
      }),
    ).toBe(false);
    expect(
      runtime.isJustDoToolErrorReasoningRecoveryCandidate({
        ...candidate,
        attempt: {
          ...candidate.attempt,
          acceptedSessionSpawns: [{ runId: 'child-run', childSessionKey: 'agent:child' }],
        },
      }),
    ).toBe(false);
    expect(
      runtime.isJustDoToolErrorReasoningRecoveryCandidate({
        ...candidate,
        attempt: { ...candidate.attempt, toolMetas: [{ asyncStarted: true }] },
      }),
    ).toBe(false);

    expect(toolErrorRecoveryPatch.applyPatch(runtimeRoot)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(once);
  });

  test('keeps only JustDo interactive approvals alive and is byte-stable', () => {
    const runtimeRoot = createRuntime();
    const target = path.join(runtimeRoot, 'dist', 'server-aux-handlers.js');
    fs.writeFileSync(
      target,
      `import { C as resolveExpiresAtMsFromDurationMs, j as resolveTimerTimeoutMs } from "./number-coercion-CJQ8TR--.js";
function resolveApprovalTimeoutMs(timeoutMs) { return resolveTimerTimeoutMs(timeoutMs, 1); }
class ExecApprovalManager {
  create(request, timeoutMs, id) {
    const now = Date.now();
    const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(timeoutMs), { nowMs: now });
    if (expiresAtMs === void 0) throw new Error("approval expiry is unavailable");
    return { id, request, createdAtMs: now, expiresAtMs };
  }
  register(record, timeoutMs) {
    const entry = { record, timer: null, promise: Promise.resolve(null) };
    const timerDelayMs = resolveApprovalTimeoutMs(timeoutMs);
    entry.timer = setTimeout(() => { this.expire(record.id); }, timerDelayMs);
    this.pending.set(record.id, entry);
    return entry.promise;
  }
}
`,
    );
    expect(fs.readFileSync(target, 'utf8')).not.toContain('isJustDoInteractiveApproval');

    expect(approvalPatch.applyPatch(runtimeRoot)).toEqual([target]);
    approvalPatch.verifyPatch(runtimeRoot);
    const once = fs.readFileSync(target);
    expect(once.toString()).toContain('/^agent:[^:]+:justdo:/.test(sessionKey)');
    expect(once.toString()).toContain('store?.[sessionKey]?.spawnedBy');
    expect(once.toString()).toContain('if (timeoutMs === null) return false');
    expect(once.toString()).toContain('Number.MAX_SAFE_INTEGER');
    expect(once.toString()).toContain(
      'if (!isJustDoInteractiveApproval(record.request, timeoutMs))',
    );

    expect(approvalPatch.applyPatch(runtimeRoot)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(once);
  });

  test('adds agent, parent, purpose and one-shot user metadata as separate contracts', () => {
    const runtimeRoot = createRuntime();
    const schemaPath = path.join(runtimeRoot, 'dist', 'schema.js');
    const chatPath = path.join(runtimeRoot, 'dist', 'chat.js');
    const streamPath = path.join(runtimeRoot, 'dist', 'selection.js');
    fs.writeFileSync(
      schemaPath,
      `const ChatSendParamsSchema = Type.Object({
  systemInputProvenance: Type.Optional(InputProvenanceSchema),
  systemProvenanceReceipt: Type.Optional(Type.String())
});
`,
    );
    fs.writeFileSync(
      chatPath,
      `const handlers = { "chat.send": async ({ params, context }) => {
  const chatSendReceivedAtMs = performance.now();
  const controlUiReconnectResume = resolveControlUiReconnectResumeParams(params);
  const p = controlUiReconnectResume.params;
  context.addChatRun(clientRunId, {
    sessionKey,
    clientRunId
  });
} };
`,
    );
    fs.writeFileSync(
      streamPath,
      `import { a as resolveSessionFilePath, o as resolveSessionFilePathOptions, s as resolveSessionTranscriptPath } from "./paths-fixture.js";
const streamWithPayloadPatch = () => {};
function loadSessionEntry() {}
async function loadAttemptSessionEntryAfterQuotaMaintenance(params) { return params; }
function install(params) {
  activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    sessionId: params.sessionId,
    authStorage: params.authStorage
  });
  const providerTextTransforms = resolveProviderTextTransforms({});
}
`,
    );
    expect(fs.readFileSync(schemaPath, 'utf8')).not.toContain('justdoUserInitiated');
    expect(fs.readFileSync(streamPath, 'utf8')).not.toContain('request_purpose');

    expect(metadataPatch.applyPatch(runtimeRoot)).toHaveLength(3);
    metadataPatch.verifyPatch(runtimeRoot);
    const firstBytes = [schemaPath, chatPath, streamPath].map(filePath =>
      fs.readFileSync(filePath),
    );
    const stream = firstBytes[2].toString();
    expect(firstBytes[0].toString()).toContain(
      'justdoUserInitiated: Type.Optional(Type.Boolean())',
    );
    expect(firstBytes[1].toString()).toContain('p.justdoUserInitiated === true');
    expect(stream).toContain('session_id: params.sessionId');
    expect(stream).toContain('parent_session_id');
    expect(stream).toContain('request_purpose: "agent"');
    expect(stream).toContain('payload.metadata.user_initiated = true');
    expect(stream).toContain('childEntry?.parentSessionId');
    expect(stream).toContain('return { parentSessionId }');

    expect(metadataPatch.applyPatch(runtimeRoot)).toEqual([]);
    expect([schemaPath, chatPath, streamPath].map(filePath => fs.readFileSync(filePath))).toEqual(
      firstBytes,
    );
  });

  test('fails atomically when a target anchor is ambiguous', () => {
    const runtimeRoot = createRuntime();
    const schemaPath = path.join(runtimeRoot, 'dist', 'schema.js');
    const chatPath = path.join(runtimeRoot, 'dist', 'chat.js');
    const streamPath = path.join(runtimeRoot, 'dist', 'selection.js');
    const schemaEntry = `systemInputProvenance: Type.Optional(InputProvenanceSchema),\n  systemProvenanceReceipt:`;
    fs.writeFileSync(
      schemaPath,
      `const ChatSendParamsSchema = {};\n${schemaEntry}\n${schemaEntry}\n`,
    );
    fs.writeFileSync(
      chatPath,
      `const chatSendReceivedAtMs=0; const controlUiReconnectResume={params:{}}; const p=controlUiReconnectResume.params; context.addChatRun(clientRunId, { sessionKey, });`,
    );
    fs.writeFileSync(
      streamPath,
      `const streamWithPayloadPatch=()=>{}; async function loadAttemptSessionEntryAfterQuotaMaintenance(params){}; activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({ authStorage: params.authStorage }); const providerTextTransforms=0;`,
    );
    const before = [schemaPath, chatPath, streamPath].map(filePath => fs.readFileSync(filePath));

    expect(() => metadataPatch.applyPatch(runtimeRoot)).toThrow(/anchor count is 2/);
    expect([schemaPath, chatPath, streamPath].map(filePath => fs.readFileSync(filePath))).toEqual(
      before,
    );
  });

  test('fails open to a bounded local compaction handoff but preserves user abort', () => {
    const runtimeRoot = createRuntime();
    const target = path.join(runtimeRoot, 'dist', 'compaction-safeguard.js');
    const nativeTarget = path.join(runtimeRoot, 'dist', 'native-compaction.js');
    fs.writeFileSync(
      target,
      `function compactionSafeguardExtension(api) {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    const baseMessagesToSummarize = [];
    const baseTurnPrefixMessages = [];
    try { await tryProviderSummarize(); } catch (err) {
      if (signal?.aborted) throw err;
      if (!isAbortError(err) && isTimeoutError(err)) throw err;
      log.warn(\`Compaction provider path failed unexpectedly: \${err instanceof Error ? err.message : String(err)}\`);
    }
    const model = ctx.model;
    if (!model) {
      setCompactionSafeguardCancelReason(ctx.sessionManager, "Compaction safeguard could not resolve a summarization model.");
      return { cancel: true };
    }
    const authResult = await resolveModelAuth(ctx, model);
    if (!authResult.ok) {
      setCompactionSafeguardCancelReason(ctx.sessionManager, authResult.reason);
      return { cancel: true };
    }
    try { return model; } catch (error) {
      const message = formatErrorMessage(error);
      log.warn(\`Compaction summarization failed; cancelling compaction to preserve history: \${message}\`);
      setCompactionSafeguardCancelReason(ctx.sessionManager, \`Compaction safeguard could not summarize the session: \${message}\`);
      return { cancel: true };
    }
  });
}
`,
    );
    fs.writeFileSync(
      nativeTarget,
      `const TURN_PREFIX_SUMMARIZATION_PROMPT = \`This is the PREFIX\`;
/** Generate compaction summary data from prepared session history. */
async function compact(preparation, model, apiKey, headers, customInstructions, signal) {
  const historyResult = await generateSummary(); if (!historyResult.ok) return err(historyResult.error);
  const turnPrefixResult = await generateTurnPrefixSummary(); if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
  const summaryResult = await generateSummary(); if (!summaryResult.ok) return err(summaryResult.error);
}`,
    );
    expect(fs.readFileSync(target, 'utf8')).not.toContain('emergencyHandoff');

    expect(emergencyCompactionPatch.applyPatch(runtimeRoot)).toEqual([
      path.join('dist', 'compaction-safeguard.js'),
      path.join('dist', 'native-compaction.js'),
    ]);
    emergencyCompactionPatch.verifyPatch(runtimeRoot);
    const once = fs.readFileSync(target);
    expect(once.toString()).toContain('emergencyHandoff: true');
    expect(once.toString()).toContain('## Retained user messages');
    expect(once.toString()).toContain('## Recent conversation tail');
    expect(once.toString()).toContain('if (signal?.aborted) return { cancel: true }');
    expect(once.toString()).toContain('authResult.reason');
    expect(once.toString()).toContain('setCompactionSafeguardCancelReason(sessionManager, void 0)');
    expect(fs.readFileSync(nativeTarget, 'utf8')).toContain('nativeCompactionFailure');

    expect(emergencyCompactionPatch.applyPatch(runtimeRoot)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(once);
  });
});
