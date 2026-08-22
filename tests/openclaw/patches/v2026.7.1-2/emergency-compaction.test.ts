import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

const emergencyPatch =
  require('../../../../scripts/patches/v2026.7.1-2/031-compaction-emergency-handoff.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    transformNative: (content: string, filePath: string) => string;
    transformSafeguard: (content: string, filePath: string) => string;
    verifyPatch: (runtimeDir: string) => void;
  };

const safeguardFixture = `function compactionSafeguardExtension(api) {
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
}`;

const nativeFixture = `const TURN_PREFIX_SUMMARIZATION_PROMPT = "prefix";
/** Generate compaction summary data from prepared session history. */
async function compact(preparation, model, apiKey, headers, customInstructions, signal) {
  const historyResult = await generateSummary();
  if (!historyResult.ok) return err(historyResult.error);
  const turnPrefixResult = await generateTurnPrefixSummary();
  if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
  const summaryResult = await generateSummary();
  if (!summaryResult.ok) return err(summaryResult.error);
}`;

function loadSafeguardHelpers() {
  const transformed = emergencyPatch.transformSafeguard(safeguardFixture, 'safeguard.js');
  const start = transformed.indexOf('const JUSTDO_EMERGENCY_PREVIOUS_CHARS');
  const end = transformed.indexOf('function compactionSafeguardExtension', start);
  const source = transformed.slice(start, end);
  const clearReason = vi.fn();
  const factory = new Function(
    'truncateFailureText',
    'normalizeFailureText',
    'extractMessageText',
    'capCompactionSummary',
    'MAX_TOOL_FAILURE_CHARS',
    'MAX_COMPACTION_SUMMARY_CHARS',
    'computeFileLists',
    'setCompactionSafeguardCancelReason',
    `${source}; return { buildJustDoEmergencyCompaction, commitJustDoEmergencyCompaction };`,
  );
  const helpers = factory(
    (value: string, max: number) => value.slice(0, max),
    (value: unknown) => String(value),
    (message: { content?: string }) => message.content ?? '',
    (value: string, max: number) => value.slice(0, max),
    240,
    16000,
    () => ({ readFiles: ['read.ts'], modifiedFiles: ['write.ts'] }),
    clearReason,
  ) as {
    buildJustDoEmergencyCompaction: (
      preparation: Record<string, unknown>,
      messages: unknown[],
      reason: unknown,
    ) => { compaction: { summary: string; details: Record<string, unknown> } };
    commitJustDoEmergencyCompaction: (
      manager: unknown,
      preparation: Record<string, unknown>,
      messages: unknown[],
      reason: unknown,
    ) => { compaction: { summary: string; details: Record<string, unknown> } } | { cancel: true };
  };
  return { transformed, clearReason, ...helpers };
}

function loadNativeHelpers() {
  const transformed = emergencyPatch.transformNative(nativeFixture, 'native.js');
  const start = transformed.indexOf('const JUSTDO_NATIVE_EMERGENCY_MAX_CHARS');
  const end = transformed.indexOf('/** Generate compaction summary data', start);
  const source = transformed.slice(start, end);
  const factory = new Function(
    'computeFileLists',
    'err',
    'ok',
    `${source}; return { buildJustDoNativeEmergencyCompaction, recoverJustDoNativeCompaction };`,
  );
  return {
    transformed,
    ...(factory(
      () => ({ readFiles: ['native-read.ts'], modifiedFiles: ['native-write.ts'] }),
      (error: unknown) => ({ ok: false, error }),
      (value: unknown) => ({ ok: true, value }),
    ) as {
      buildJustDoNativeEmergencyCompaction: (
        preparation: Record<string, unknown>,
        reason: unknown,
      ) => { summary: string; details: Record<string, unknown> };
      recoverJustDoNativeCompaction: (
        preparation: Record<string, unknown>,
        signal: { aborted: boolean },
        failure: unknown,
      ) => { ok: boolean; value?: unknown; error?: unknown };
    }),
  };
}

describe('OpenClaw v2026.7.1-2 emergency compaction handoff', () => {
  test('first fallback includes prior summary, retained originals and recent tail', () => {
    const { buildJustDoEmergencyCompaction } = loadSafeguardHelpers();
    const result = buildJustDoEmergencyCompaction(
      {
        previousSummary: 'previous-summary-sentinel',
        firstKeptEntryId: 'kept',
        tokensBefore: 42,
        fileOps: {},
        details: { preservedDetail: true },
        justDoRetainedUserMessages: {
          version: 1,
          messages: [{ sourceEntryId: 'u1', text: 'retained-user-sentinel' }],
        },
      },
      [{ role: 'assistant', content: 'recent-assistant-sentinel' }],
      'provider unavailable',
    ).compaction;

    expect(result.summary).toContain('previous-summary-sentinel');
    expect(result.summary).toContain('retained-user-sentinel');
    expect(result.summary).toContain('recent-assistant-sentinel');
    expect(result.summary.length).toBeLessThanOrEqual(16000);
    expect(result.details).toMatchObject({
      preservedDetail: true,
      readFiles: ['read.ts'],
      modifiedFiles: ['write.ts'],
      emergencyHandoff: true,
      justdoRetainedUserMessages: {
        messages: [{ sourceEntryId: 'u1', text: 'retained-user-sentinel' }],
      },
    });
  });

  test('repeated and legacy archives remain readable and bounded', () => {
    const { buildJustDoEmergencyCompaction } = loadSafeguardHelpers();
    const repeated = buildJustDoEmergencyCompaction(
      {
        previousSummary: `old-${'p'.repeat(9000)}-new-previous`,
        fileOps: {},
        justDoRetainedUserMessages: {
          version: 1,
          messages: [
            { sourceEntryId: 'old', text: 'old-retained' },
            { sourceEntryId: 'new', text: `${'r'.repeat(8000)}-new-retained` },
          ],
        },
      },
      [{ role: 'assistant', content: `${'t'.repeat(9000)}-recent-tail` }],
      'timeout',
    ).compaction;
    expect(repeated.summary.length).toBeLessThanOrEqual(16000);
    expect(repeated.summary).toContain('new-previous');
    expect(repeated.summary).toContain('-new-retained');
    expect(repeated.summary).toContain('-recent-tail');

    const legacy = buildJustDoEmergencyCompaction(
      {
        previousSummary: 'legacy previous',
        fileOps: {},
        details: {
          justdoRetainedUserMessages: { messages: [{ text: 'legacy-retained-sentinel' }] },
        },
      },
      [],
      'missing auth',
    ).compaction;
    expect(legacy.summary).toContain('legacy-retained-sentinel');
    expect(legacy.details).toHaveProperty('justdoRetainedUserMessages');
  });

  test('native fallback preserves details and retains abort cancellation', () => {
    const { buildJustDoNativeEmergencyCompaction, recoverJustDoNativeCompaction } =
      loadNativeHelpers();
    const preparation = {
      previousSummary: 'native-previous',
      messagesToSummarize: [{ role: 'user', content: 'native-recent-user' }],
      turnPrefixMessages: [{ role: 'assistant', content: 'native-recent-assistant' }],
      fileOps: {},
      details: { nativeDetail: 1 },
      justDoRetainedUserMessages: {
        version: 1,
        messages: [{ text: 'native-retained-user' }],
      },
    };
    const fallback = buildJustDoNativeEmergencyCompaction(preparation, new Error('native fail'));

    expect(fallback.summary).toContain('native-previous');
    expect(fallback.summary).toContain('native-retained-user');
    expect(fallback.summary).toContain('native-recent-assistant');
    expect(fallback.summary.length).toBeLessThanOrEqual(16000);
    expect(fallback.details).toMatchObject({
      nativeDetail: 1,
      readFiles: ['native-read.ts'],
      modifiedFiles: ['native-write.ts'],
      emergencyHandoff: true,
    });

    const abort = new Error('stop');
    abort.name = 'AbortError';
    expect(recoverJustDoNativeCompaction(preparation, { aborted: false }, abort)).toEqual({
      ok: false,
      error: abort,
    });
    expect(
      recoverJustDoNativeCompaction(preparation, { aborted: false }, new Error('fail')).ok,
    ).toBe(true);
    const codexFailure = new Error('codex local failure');
    expect(
      recoverJustDoNativeCompaction(
        { ...preparation, justDoCodexLocal: true },
        { aborted: false },
        codexFailure,
      ),
    ).toEqual({ ok: false, error: codexFailure });
  });

  test('all failure entries commit locally while successful fallback clears stale cancel reason', () => {
    const { transformed, clearReason, commitJustDoEmergencyCompaction } = loadSafeguardHelpers();
    expect(transformed.match(/commitJustDoEmergencyCompaction\(/g)).toHaveLength(5);
    expect(transformed).toContain('signal?.aborted || isAbortError(err)');
    expect(transformed).toContain('signal?.aborted || isAbortError(error)');

    const manager = {};
    commitJustDoEmergencyCompaction(
      manager,
      { previousSummary: '', fileOps: {} },
      [],
      'staged summary failure',
    );
    expect(clearReason).toHaveBeenCalledWith(manager, undefined);

    expect(
      commitJustDoEmergencyCompaction(
        manager,
        { previousSummary: '', fileOps: {}, justDoCodexLocal: true },
        [],
        'provider failed',
      ),
    ).toEqual({ cancel: true });
    expect(clearReason).toHaveBeenLastCalledWith(
      manager,
      expect.stringContaining('without replacing history'),
    );

    const { transformed: native } = loadNativeHelpers();
    expect(native.match(/recoverJustDoNativeCompaction\(preparation, signal/g)).toHaveLength(4);
  });

  test('patches source and bundle targets atomically and remains byte-idempotent', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-emergency-bundle-'));
    const dist = path.join(runtimeRoot, 'dist');
    fs.mkdirSync(dist);
    const safeguardPath = path.join(dist, 'safeguard.js');
    const nativePath = path.join(dist, 'native.js');
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    fs.writeFileSync(safeguardPath, safeguardFixture);
    fs.writeFileSync(nativePath, nativeFixture);
    fs.writeFileSync(bundlePath, `${safeguardFixture}\n${nativeFixture}\n`);

    expect(emergencyPatch.applyPatch(runtimeRoot)).toHaveLength(3);
    emergencyPatch.verifyPatch(runtimeRoot);
    const first = [safeguardPath, nativePath, bundlePath].map(filePath =>
      fs.readFileSync(filePath),
    );
    expect(() => new Function(first[2].toString())).not.toThrow();

    expect(emergencyPatch.applyPatch(runtimeRoot)).toEqual([]);
    emergencyPatch.verifyPatch(runtimeRoot);
    expect(
      [safeguardPath, nativePath, bundlePath].map(filePath => fs.readFileSync(filePath)),
    ).toEqual(first);
  });
});
