import fs from 'node:fs';
import path from 'node:path';

import type { Statement } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const { OWNER, TARGET, transform, readCatch } = require('../../../../scripts/patches/v2026.10.7/043-empty-split-summary-recovery.cjs').__testing as {
  OWNER: string;
  TARGET: string;
  transform: (source: string) => string;
  readCatch: (source: string) => { statements: Statement[] };
};
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js') as {
  functionRange: (source: string, name: string) => { text: string };
};

const runtime = process.env.OPENCLAW_PRISTINE_DIR ?? 'vendor/openclaw-runtime/current';
const target = path.join(runtime, TARGET);
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';

class CompactionError extends Error {}
class InvalidSummaryOutputError extends CompactionError {}

function prepare(options: { suffixTrimmed?: boolean; auditPassed?: boolean; historySummary?: string } = {}) {
  const patched = transform(fs.readFileSync(target, 'utf8'));
  const { text } = functionRange(patched, OWNER);
  const { statements } = readCatch(text);
  const controller = new AbortController();
  const prefix = [{ role: 'toolResult', content: 'Settled tool result' }];
  const section = { text: 'Current turn\nSettled tool result', segmentStarts: [13] };
  const finalized = {
    summary: 'History decisions\nCurrent turn\nSettled tool result',
    structuralSummary: 'History decisions',
    suffixTrimmed: options.suffixTrimmed ?? false,
    qualityRetentionInfeasible: false,
  };
  const dependencies = {
    CompactionError, InvalidSummaryOutputError,
    signal: controller.signal,
    bestSummary: undefined,
    historySummary: options.historySummary ?? 'History decisions',
    turnPrefixMessages: prefix,
    buildSplitTurnContextSection: vi.fn(() => section),
    preservedTurnsSectionLocal: { text: '', segmentStarts: [] },
    finalizeSummaryText: vi.fn(async () => finalized),
    producerLosses: new Set(),
    appendSummarySection: (summary: string, suffix: string) => `${summary}\n${suffix}`,
    identifiers: [], latestUserAsk: 'Continue the report', latestUnresolvedUserRequest: undefined,
    requiredAskContext: 'Continue the report', identifierPolicy: 'strict',
    auditSummaryQuality: vi.fn(() => ({ ok: options.auditPassed ?? true })),
    degrade: (summary: string) => ({ summary, qualityDegraded: true }),
  };
  const recover = new Function(...Object.keys(dependencies),
    `return async (attemptError) => ${statements[0].parent.getText()};`)(...Object.values(dependencies)) as
    (error: Error) => Promise<{ summary: string; qualityDegraded: boolean }>;
  return { controller, recover, dependencies, finalized, patched, prefix, section };
}

const blankSummary = () => new CompactionError('Summary failed', {
  cause: new InvalidSummaryOutputError('No text'),
});

describe.skipIf(!required && !fs.existsSync(target))('native empty split summary recovery', () => {
  it('audits the reconciled summary and bounded native prefix before returning a degraded result', async () => {
    const fixture = prepare();

    await expect(fixture.recover(blankSummary())).resolves.toEqual({
      summary: fixture.finalized.summary, qualityDegraded: true,
    });

    expect(fixture.dependencies.buildSplitTurnContextSection).toHaveBeenCalledWith(fixture.prefix);
    expect(fixture.dependencies.finalizeSummaryText).toHaveBeenCalledWith('History decisions',
      expect.objectContaining({ splitTurnSection: fixture.section }), expect.any(Set), expect.any(Object), true);
    expect(fixture.dependencies.auditSummaryQuality).toHaveBeenCalledWith(expect.objectContaining({
      summary: fixture.finalized.summary, structuralSummary: fixture.finalized.structuralSummary,
    }));
    expect(transform(fixture.patched)).toBe(fixture.patched);
    expect(() => transform(fixture.patched.replace('emptyPrefixRecovery.suffixTrimmed || ', ''))).toThrow();
  });

  it.each([{ suffixTrimmed: true }, { auditPassed: false }, { historySummary: '' }])(
    'retains the failure without a safe summary (%j)', async options => {
      const fixture = prepare(options);
      const failure = blankSummary();

      await expect(fixture.recover(failure)).rejects.toBe(failure);
    },
  );

  it('keeps another summary failure and honors cancellation during artifact fitting', async () => {
    const fixture = prepare();
    const providerError = new CompactionError('Provider unavailable', { cause: new Error('Connection failed') });
    await expect(fixture.recover(providerError)).rejects.toBe(providerError);
    expect(fixture.dependencies.finalizeSummaryText).not.toHaveBeenCalled();

    const cancelled = new Error('Cancelled');
    fixture.dependencies.finalizeSummaryText.mockImplementationOnce(async () => {
      fixture.controller.abort(cancelled);
      return fixture.finalized;
    });
    await expect(fixture.recover(blankSummary())).rejects.toBe(cancelled);
  });
});
