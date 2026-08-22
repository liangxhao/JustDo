import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.7.1-2/040-compaction-error-attribution.cjs') as {
  transform: (content: string, filePath: string) => string;
  failureHelper: string;
  applyPatch: (runtimeDir: string) => string[];
  verifyPatch: (runtimeDir: string) => void;
};

const fixture = `async function run() {
  let overflowCompactionAttempts = 0;
  const errorText = contextOverflowError.text;
  let compactResult = { ok: false, compacted: false, reason: "Error: Compaction timed out" };
  if (timeoutCompactResult.compacted) {
    retryAfterTimeoutCompaction();
  }
  const hadAttemptLevelCompaction = attemptCompactionCount > 0;
  if (!isCompactionFailure && hadAttemptLevelCompaction && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
    retryAfterAttemptCompaction();
  }
  if (preflightRecovery && isNoRealConversationCompactionNoop(compactResult)) {
    continueFromCurrentTranscript();
  }
  if (compactResult.compacted) {
    adoptCompactionTranscript(compactResult);
  }
  log$1.warn(\`auto-compaction failed for \${provider}/\${modelId}: \${compactResult.reason ?? "nothing to compact"}\`);
  const justDoRetryCancelledCodexCompaction =
    compactResult.ok === true && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS;
  if (truncResult.truncated) {
    log$1.info(\`[context-overflow-recovery] Truncated \${truncResult.truncatedCount} tool result(s); retrying prompt\`);
    continueFromCurrentTranscript();
  }
  const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
  const overflowRecoveryText = "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
  return {
    payloads: [{ text: overflowRecoveryText, isError: true }],
    meta: {
      error: {
        kind,
        message: errorText
      }
    }
  };
}`;

test('retains the actual compaction failure in the terminal payload and metadata', () => {
  const transformed = patch.transform(fixture, 'embedded-agent.js');

  expect(transformed).toContain('JUSTDO_COMPACTION_ERROR_ATTRIBUTION_V2026_7_1_2_V3');
  expect(transformed).toContain('const clearJustDoLastOverflowRecoveryFailure = () =>');
  expect(transformed).toContain(
    'promptErrorSource === "prompt" || contextOverflowError.source === "assistantError"',
  );
  expect(transformed).toContain('justDoLastOverflowRecoveryFailure = {');
  expect(transformed).toContain('compactResult.ok === false ? "compaction_failure"');
  expect(transformed).toContain('justDoTerminalRecoveryFailure?.message ?? errorText');
  expect(transformed).toContain('message: justDoTerminalErrorText');
  expect(patch.transform(transformed, 'embedded-agent.js')).toBe(transformed);

  const bundled = transformed.replace(
    /\s*\/\/ JUSTDO_COMPACTION_ERROR_ATTRIBUTION_V2026_7_1_2_V3/u,
    '',
  );
  expect(patch.transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
});

test('selects provider overflow only when it is the actual terminal error', () => {
  const resolveFailure = new Function(
    `${patch.failureHelper}\nreturn resolveJustDoOverflowTerminalFailure;`,
  )() as (params: {
    lastCompactionFailure?: { kind: string; message: string };
    isCompactionFailure: boolean;
    errorText: string;
    promptErrorSource: string;
    providerConfirmedOverflow: boolean;
  }) => { kind: string; message: string } | undefined;

  expect(
    resolveFailure({
      lastCompactionFailure: {
        kind: 'compaction_failure',
        message: 'Error: Compaction timed out',
      },
      isCompactionFailure: false,
      errorText: 'Context overflow: prompt too large for the model (precheck).',
      promptErrorSource: 'precheck',
      providerConfirmedOverflow: false,
    }),
  ).toEqual({ kind: 'compaction_failure', message: 'Error: Compaction timed out' });

  expect(
    resolveFailure({
      isCompactionFailure: false,
      errorText: 'Context overflow: prompt too large for the model (precheck).',
      promptErrorSource: 'precheck',
      providerConfirmedOverflow: false,
    }),
  ).toEqual({
    kind: 'precheck_budget',
    message:
      'Automatic compaction could not reduce the request below the locally estimated prompt safety budget.',
  });

  expect(
    resolveFailure({
      isCompactionFailure: false,
      errorText: 'maximum context length exceeded',
      promptErrorSource: 'prompt',
      providerConfirmedOverflow: true,
    }),
  ).toBeUndefined();

  expect(
    resolveFailure({
      isCompactionFailure: false,
      errorText: 'hook returned an overflow-like diagnostic',
      promptErrorSource: 'hook:before_agent_run',
      providerConfirmedOverflow: false,
    }),
  ).toEqual({
    kind: 'context_recovery_failure',
    message: 'hook returned an overflow-like diagnostic',
  });
});

test('rejects ambiguous or partial targets', () => {
  expect(() => patch.transform(`${fixture}\n${fixture}`, 'ambiguous.js')).toThrow(
    /anchor count is 2, expected 1/u,
  );

  expect(() =>
    patch.transform(
      `${fixture}\n// JUSTDO_COMPACTION_ERROR_ATTRIBUTION_V2026_7_1_2_V3`,
      'partial.js',
    ),
  ).toThrow(/partial compaction error attribution patch/u);
});

test('clears stale failures before newer recovery evidence takes ownership', () => {
  const transformed = patch.transform(fixture, 'embedded-agent.js');
  const providerOverflow = transformed.indexOf('promptErrorSource !== "precheck"');
  const timeoutCompaction = transformed.indexOf('if (timeoutCompactResult.compacted)');
  const attemptCompaction = transformed.indexOf(
    'if (!isCompactionFailure && hadAttemptLevelCompaction',
  );
  const noConversation = transformed.indexOf(
    'if (preflightRecovery && isNoRealConversationCompactionNoop(compactResult))',
  );
  const successfulCompaction = transformed.indexOf('if (compactResult.compacted)');
  const successfulTruncation = transformed.indexOf('if (truncResult.truncated)');

  for (const anchor of [
    providerOverflow,
    timeoutCompaction,
    attemptCompaction,
    noConversation,
    successfulCompaction,
    successfulTruncation,
  ]) {
    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(transformed.slice(anchor, anchor + 300)).toContain(
      'clearJustDoLastOverflowRecoveryFailure();',
    );
  }
});

test('recognizes markerless source and bundle output as already patched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-error-attribution-'));
  try {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist);
    const bundled = patch
      .transform(fixture, 'embedded-agent.js')
      .replace(/\s*\/\/ JUSTDO_COMPACTION_ERROR_ATTRIBUTION_V2026_7_1_2_V3/u, '');
    fs.writeFileSync(path.join(dist, 'embedded-agent.js'), bundled);
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundled);

    expect(patch.applyPatch(root)).toEqual([]);
    expect(() => patch.verifyPatch(root)).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
