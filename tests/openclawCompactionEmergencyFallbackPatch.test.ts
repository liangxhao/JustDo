import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const {
  applyPatch,
  verifyPatch,
  MAX_EMERGENCY_SUMMARY_CHARS,
  MAX_PREVIOUS_SUMMARY_CHARS,
  MAX_RECENT_MESSAGE_CHARS,
  MAX_RECENT_TRANSCRIPT_CHARS,
  MAX_OPERATION_CONTEXT_CHARS,
} = require('../scripts/patches/v2026.6.11/019-compaction-emergency-fallback.cjs') as {
  applyPatch: (runtimeDir: string) => string[];
  verifyPatch: (runtimeDir: string) => boolean;
  MAX_EMERGENCY_SUMMARY_CHARS: number;
  MAX_PREVIOUS_SUMMARY_CHARS: number;
  MAX_RECENT_MESSAGE_CHARS: number;
  MAX_RECENT_TRANSCRIPT_CHARS: number;
  MAX_OPERATION_CONTEXT_CHARS: number;
};

const temporaryRoots: string[] = [];

function createFixture() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-compaction-fallback-'));
  temporaryRoots.push(runtimeDir);
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  fs.writeFileSync(
    bundlePath,
    `
function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  return trimmedPreviousSummary || "No prior conversation content was available to summarize.";
}
function appendSummarySection(summary, section) { return summary + section; }
function extractMessageText2(message) {
  return typeof message.content === "string" ? message.content : "";
}
function capCompactionSummary(summary, maxChars) {
  return summary.slice(0, maxChars);
}
const log54 = { info() {}, warn() {} };
function isAbortError6(error) { return error?.name === "AbortError"; }
function isTimeoutError3(error) { return error?.name === "TimeoutError"; }
function getCompactionProvider() { return {}; }
function resolveContextWindowForCompactionHint() { return 200000; }
function resolveHeartbeatBleedHint() { return undefined; }
function buildContextOverflowResetHint() { return " reserveTokensFloor should increase"; }
function formatNoModelSelectedMessage() { return "no model"; }
function unwrapCoreResult(value) { return value; }
function prepareCompaction() { return { firstKeptEntryId: "entry-1" }; }
async function compact() { throw new Error("native compaction should not run"); }
class FixtureSessionAgent {
  constructor(model, auth, extensionResult) {
    this.overflowRecoveryAttempted = false;
    this.model = model;
    this.auth = auth;
    this.extensionResult = extensionResult;
    this.thinkingLevel = "off";
    this.agent = { streamFn: undefined, state: {} };
    this.sessionManager = {
      getBranch: () => [{ id: "entry-1" }],
      appendCompaction: (...args) => { this.appended = args; },
      getEntries: () => [],
      buildSessionContext: () => ({ messages: [] })
    };
    this.currentExtensionRunner = {
      hasHandlers: () => true,
      emit: async () => this.extensionResult
    };
  }
  async getCompactionRequestAuth() { return this.auth; }
  async getAutoCompactionRequestAuth() { return this.auth; }
  resetOne() { this.overflowRecoveryAttempted = false; }
  resetTwo() { this.overflowRecoveryAttempted = false; }
  async runCompactionWork(options2) {
        const isManual = options2.mode === "manual";
        if (!this.model) {
          if (isManual) throw new Error(formatNoModelSelectedMessage());
          return { status: "skipped" };
        }
        const auth2 = isManual ? await this.getCompactionRequestAuth(this.model) : await this.getAutoCompactionRequestAuth(this.model);
        if (!auth2) return { status: "skipped" };
        const pathEntries = this.sessionManager.getBranch();
        const preparation = unwrapCoreResult(prepareCompaction(pathEntries, options2.settings));
        let compactionResult;
        let fromExtension = false;
        if (this.currentExtensionRunner.hasHandlers("session_before_compact")) {
          const extensionResult = await this.currentExtensionRunner.emit({ preparation: preparation });
          if (extensionResult?.cancel) return { status: "aborted" };
          if (extensionResult?.compaction) {
            compactionResult = extensionResult.compaction;
            fromExtension = true;
          }
        }
        compactionResult ??= unwrapCoreResult(await compact(preparation, this.model, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, this.agent.streamFn));
        if (options2.signal.aborted) return { status: "aborted" };
        this.sessionManager.appendCompaction(compactionResult.summary, compactionResult.firstKeptEntryId, compactionResult.tokensBefore, compactionResult.details, fromExtension);
        return { status: "compacted", result: compactionResult };
  }
  async checkCompaction() {
          if (this.overflowRecoveryAttempted) {
            this.emit({
              type: "compaction_end",
              reason: "overflow",
              result: void 0,
              aborted: false,
              willRetry: false,
              errorMessage: "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
            });
            return false;
          }
          this.overflowRecoveryAttempted = true;
          return await this.runAutoCompaction("overflow", true);
  }
  async runAutoCompaction(reason, willRetry) {
        const settings2 = this.settingsManager.getCompactionSettings();
        this.emit({
          type: "compaction_start",
          reason
        });
        return { settings2, willRetry };
  }
}
async function compactionSafeguardExtension(api) {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    const baseMessagesToSummarize = [];
    const baseTurnPrefixMessages = [];
    const readFiles = [];
    const modifiedFiles = [];
    const toolFailureSection = "";
    const fileOpsSummary = "";
    const turnPrefixMessages = [];
    const providerId = "provider";
    if (providerId) {
      const compactionProvider = getCompactionProvider(providerId);
      if (compactionProvider) try {
        if (signal.aborted) throw signal.reason;
        const providerTimeout = new Error("provider timeout");
        providerTimeout.name = "TimeoutError";
        throw providerTimeout;
      } catch (err3) {
        if (isAbortError6(err3) || isTimeoutError3(err3)) throw err3;
        log54.warn(\`Compaction provider path failed unexpectedly: \${err3 instanceof Error ? err3.message : String(err3)}\`);
      }
      else log54.warn(\`Compaction provider "\${providerId}" is configured but not registered. Falling back to LLM.\`);
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
    try {
      return { compaction: true };
    } catch (error51) {
      const message2 = formatErrorMessage(error51);
      log54.warn(\`Compaction summarization failed; cancelling compaction to preserve history: \${message2}\`);
      setCompactionSafeguardCancelReason(ctx.sessionManager, \`Compaction safeguard could not summarize the session: \${message2}\`);
      return { cancel: true };
    }
  });
}
function buildContextOverflowRecoveryText(params) {
  const prefix = params.preserveSessionMapping ? "\\u26A0\\uFE0F Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session." : params.duringCompaction ? "\\u26A0\\uFE0F Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again." : "\\u26A0\\uFE0F Context limit exceeded. I've reset our conversation to start fresh - please try again.";
  const primaryContextWindow = resolveContextWindowForCompactionHint({
    cfg: params.cfg,
    primaryProvider: params.primaryProvider,
    primaryModel: params.primaryModel,
    runtimeProvider: params.runtimeProvider,
    runtimeModel: params.runtimeModel,
    agentId: params.agentId,
    activeSessionEntry: params.activeSessionEntry
  });
  return prefix + ((!params.runtimeProvider || !params.runtimeModel || params.runtimeProvider === params.activeSessionEntry?.modelProvider && params.runtimeModel === params.activeSessionEntry?.model ? resolveHeartbeatBleedHint({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: params.primaryProvider,
    primaryModel: params.primaryModel,
    activeSessionEntry: params.activeSessionEntry
  }) : void 0) ?? buildContextOverflowResetHint(primaryContextWindow));
}
export { buildJustDoEmergencyCompaction, buildContextOverflowRecoveryText, FixtureSessionAgent, compactionSafeguardExtension };
`,
  );
  return { bundlePath, runtimeDir };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commits a bounded local handoff for every non-user compaction failure path', async () => {
  const { bundlePath, runtimeDir } = createFixture();

  expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
  expect(verifyPatch(runtimeDir)).toBe(true);

  const patched = fs.readFileSync(bundlePath, 'utf8');
  expect(patched).toContain('function buildJustDoEmergencyCompaction(params)');
  expect(patched).toContain(`slice(-${MAX_PREVIOUS_SUMMARY_CHARS})`);
  expect(patched).toContain(`text.slice(0, ${MAX_RECENT_MESSAGE_CHARS})`);
  expect(patched).toContain(`recentChars + line.length > ${MAX_RECENT_TRANSCRIPT_CHARS}`);
  expect(patched).toContain(
    `capCompactionSummary(sections.join("\\n\\n"), ${MAX_EMERGENCY_SUMMARY_CHARS})`,
  );
  expect(patched).toContain(`.slice(0, ${MAX_OPERATION_CONTEXT_CHARS})`);
  expect(patched.match(/return buildJustDoEmergencyCompaction\(/g)).toHaveLength(4);
  expect(patched).toContain('if (signal.aborted && isAbortError6(error51))');
  expect(patched).not.toContain('cancelling compaction to preserve history');
  expect(patched).not.toContain(
    'messages: [...baseMessagesToSummarize, ...baseTurnPrefixMessages]',
  );
  expect(patched).toContain('this.overflowRecoveryAttempted >= 3');
  expect(patched).toContain('{ ...baseSettings, keepRecentTokens: 0 }');
  expect(patched).not.toContain('Auto-compaction could not recover this turn');

  const fixture = (await import(`${bundlePath}?test=${Date.now()}`)) as {
    buildJustDoEmergencyCompaction: (params: {
      preparation: { firstKeptEntryId: string; previousSummary: string; tokensBefore: number };
      messages: Array<{ role: string; content: string }>;
      readFiles: string[];
      modifiedFiles: string[];
      toolFailureSection: string;
      fileOpsSummary: string;
    }) => { compaction: { summary: string; details: { emergencyFallback: boolean } } };
    FixtureSessionAgent: new (
      model: unknown,
      auth: unknown,
      extensionResult: unknown,
    ) => {
      appended?: unknown[];
      overflowRecoveryAttempted: number;
      settingsManager: { getCompactionSettings: () => { keepRecentTokens: number } };
      emit: () => void;
      runCompactionWork: (options: {
        mode: string;
        settings: object;
        signal: AbortSignal;
      }) => Promise<{ status: string }>;
      checkCompaction: () => Promise<false | { settings2: { keepRecentTokens: number } }>;
    };
    compactionSafeguardExtension: (api: {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
    }) => void;
    buildContextOverflowRecoveryText: (params: {
      preserveSessionMapping: boolean;
      activeSessionEntry?: object;
    }) => string;
  };
  const result = fixture.buildJustDoEmergencyCompaction({
    preparation: {
      firstKeptEntryId: 'entry-1',
      previousSummary: `discarded-${'p'.repeat(MAX_PREVIOUS_SUMMARY_CHARS)}-kept`,
      tokensBefore: 90_000,
    },
    messages: Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}-${'x'.repeat(MAX_RECENT_MESSAGE_CHARS)}`,
    })),
    readFiles: ['src/read.ts'],
    modifiedFiles: ['src/changed.ts'],
    toolFailureSection: 'tool failure retained',
    fileOpsSummary: 'file operations retained',
  });

  expect(result.compaction.details.emergencyFallback).toBe(true);
  expect(result.compaction.summary.length).toBeLessThanOrEqual(MAX_EMERGENCY_SUMMARY_CHARS);
  expect(result.compaction.summary).toContain('message-9-');
  expect(result.compaction.summary).toContain('tool failure retained');
  expect(result.compaction.summary).toContain('file operations retained');

  const extensionResult = {
    compaction: {
      summary: 'local handoff',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 90_000,
      details: { emergencyFallback: true },
    },
  };
  for (const [model, auth] of [
    [undefined, undefined],
    [{ id: 'model' }, undefined],
  ]) {
    const agent = new fixture.FixtureSessionAgent(model, auth, extensionResult);
    await expect(
      agent.runCompactionWork({
        mode: 'auto',
        settings: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'compacted' });
    expect(agent.appended?.[0]).toBe('local handoff');
  }

  const retryAgent = new fixture.FixtureSessionAgent(undefined, undefined, extensionResult);
  retryAgent.settingsManager = { getCompactionSettings: () => ({ keepRecentTokens: 20_000 }) };
  retryAgent.emit = () => undefined;
  await expect(retryAgent.checkCompaction()).resolves.toMatchObject({
    settings2: { keepRecentTokens: 20_000 },
  });
  await expect(retryAgent.checkCompaction()).resolves.toMatchObject({
    settings2: { keepRecentTokens: 0 },
  });
  await expect(retryAgent.checkCompaction()).resolves.toMatchObject({
    settings2: { keepRecentTokens: 0 },
  });
  await expect(retryAgent.checkCompaction()).resolves.toBe(false);

  let providerHandler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  fixture.compactionSafeguardExtension({
    on: (_name, handler) => {
      providerHandler = handler as typeof providerHandler;
    },
  });
  const preparation = {
    firstKeptEntryId: 'entry-1',
    previousSummary: '',
    tokensBefore: 90_000,
  };
  await expect(
    providerHandler?.({ preparation, signal: new AbortController().signal }, { model: undefined }),
  ).resolves.toMatchObject({ compaction: { details: { emergencyFallback: true } } });

  const userAbort = new AbortController();
  const abortError = new Error('user cancelled');
  abortError.name = 'AbortError';
  userAbort.abort(abortError);
  await expect(
    providerHandler?.({ preparation, signal: userAbort.signal }, { model: undefined }),
  ).resolves.toEqual({ cancel: true });

  const exhaustedText = fixture.buildContextOverflowRecoveryText({
    preserveSessionMapping: true,
    activeSessionEntry: {},
  });
  expect(exhaustedText).toContain('bounded automatic recovery');
  expect(exhaustedText).not.toContain('reserveTokensFloor');
});

test('is idempotent after the complete fallback patch is present', () => {
  const { runtimeDir } = createFixture();

  applyPatch(runtimeDir);

  expect(applyPatch(runtimeDir)).toEqual([]);
  expect(verifyPatch(runtimeDir)).toBe(true);
});

test('preserves the request metadata stream when patch 016 has already run', () => {
  const { bundlePath, runtimeDir } = createFixture();
  const content = fs.readFileSync(bundlePath, 'utf8').replace(
    '        compactionResult ??= unwrapCoreResult(await compact(preparation, this.model, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, this.agent.streamFn));',
    `          // JUSTDO_LITELLM_NATIVE_COMPACTION_REQUEST_METADATA
        const compactionStreamFn = createLiteLLMContextCompactionStreamFn(
          this.agent.streamFn,
          this.model.api
        );
        compactionResult ??= unwrapCoreResult(await compact(preparation, this.model, auth2.apiKey, auth2.headers, options2.customInstructions, options2.signal, this.thinkingLevel, compactionStreamFn));`,
  );
  fs.writeFileSync(bundlePath, content, 'utf8');

  expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
  const patched = fs.readFileSync(bundlePath, 'utf8');
  expect(patched).toContain('JUSTDO_LITELLM_NATIVE_COMPACTION_REQUEST_METADATA');
  expect(patched).toContain('compactionModel.api');
  expect(patched).toContain('this.thinkingLevel, compactionStreamFn));');
  expect(verifyPatch(runtimeDir)).toBe(true);
});

test('migrates an already-patched legacy helper instead of only updating its marker', () => {
  const { bundlePath, runtimeDir } = createFixture();
  applyPatch(runtimeDir);
  const patched = fs.readFileSync(bundlePath, 'utf8');
  const helperStart = patched.indexOf('// JUSTDO_COMPACTION_EMERGENCY_FALLBACK');
  const helperEnd = patched.indexOf('\nfunction appendSummarySection', helperStart);
  const legacyHelper = `// JUSTDO_COMPACTION_EMERGENCY_FALLBACK
// JUSTDO_COMPACTION_EMERGENCY_FALLBACK_V2
function buildJustDoEmergencyCompaction(params) {
  const previousSummary = params.preparation.previousSummary.slice(-8000);
  const summary = capCompactionSummaryPreservingSuffix(previousSummary, "recent", 16000);
  return { compaction: { summary, details: { emergencyFallback: true } } };
}`;
  fs.writeFileSync(
    bundlePath,
    `${patched.slice(0, helperStart)}${legacyHelper}${patched.slice(helperEnd)}`,
  );

  expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
  expect(verifyPatch(runtimeDir)).toBe(true);
  const migrated = fs.readFileSync(bundlePath, 'utf8');
  expect(migrated).toContain(`slice(-${MAX_PREVIOUS_SUMMARY_CHARS})`);
  expect(migrated).toContain('## Operational context');
  expect(
    migrated.slice(helperStart, migrated.indexOf('\nfunction appendSummarySection')),
  ).not.toContain('capCompactionSummaryPreservingSuffix');
});

test('fails loudly when an upstream safeguard failure branch changes', () => {
  const { bundlePath, runtimeDir } = createFixture();
  fs.writeFileSync(
    bundlePath,
    fs
      .readFileSync(bundlePath, 'utf8')
      .replace(
        'setCompactionSafeguardCancelReason(ctx.sessionManager, authResult.reason);',
        'recordCompactionAuthFailure(authResult.reason);',
      ),
  );

  expect(() => applyPatch(runtimeDir)).toThrow('missing auth');
});
