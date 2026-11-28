import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const { TARGET, OWNER, transform } = require('../../../../scripts/patches/v2026.10.7/045-midturn-truncation-progress.cjs').__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const target = path.join(process.env.OPENCLAW_PRISTINE_DIR ?? 'vendor/openclaw-runtime/current', TARGET);
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';

describe.skipIf(!required && !fs.existsSync(target))('native mid-turn truncation progress', () => {
  it('hands a zero-change truncation to native compaction and retains actual truncation recovery', async () => {
    const patched = transform(fs.readFileSync(target, 'utf8'));
    const shrink = vi.fn()
      .mockResolvedValueOnce({ truncated: false, reason: 'no oversized or aggregate tool results' })
      .mockResolvedValueOnce({ truncated: true, truncatedCount: 1 });
    const replaceSessionMessages = vi.fn();
    const recover = runInNewContext(`async ${functionRange(patched, OWNER).text}; ${OWNER}`, {
      log$6: { warn: vi.fn() },
      buildPreflightRecoveryBudgetSnapshot: () => ({ estimatedPromptTokens: 32_000 }),
      resolveLiveToolResultMaxChars: () => 12_000,
      truncateOversizedToolResultsInSessionManager: shrink,
      sanitizeCompactionReplayMessages: (messages: unknown[]) => messages,
      PREEMPTIVE_OVERFLOW_ERROR_TEXT: 'Use the existing native overflow handler.',
    });
    const input = {
      attempt: { sessionId: 'fixture', contextTokenBudget: 24_000 },
      request: { route: 'truncate_tool_results_only', estimatedPromptTokens: 32_000 },
      sessionManager: { buildSessionContext: () => ({ messages: ['settled result'] }) },
      replaceSessionMessages,
    };

    const noProgress = await recover(input);
    expect(noProgress).toMatchObject({
      preflightRecovery: { route: 'compact_only', source: 'mid-turn' },
      promptError: { message: 'Use the existing native overflow handler.' },
    });
    expect(noProgress.preflightRecovery).not.toHaveProperty('handled');
    expect(replaceSessionMessages).not.toHaveBeenCalled();
    expect(await recover(input)).toMatchObject({
      preflightRecovery: { route: 'truncate_tool_results_only', handled: true, truncatedCount: 1 },
    });
    expect(replaceSessionMessages).toHaveBeenCalledExactlyOnceWith(['settled result']);
    expect(transform(patched)).toBe(patched);
  });
});
