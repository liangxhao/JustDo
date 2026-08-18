import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

type RunEntry = {
  runId?: string;
  childSessionKey?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  cleanup?: 'keep' | 'delete';
  cleanupHandled?: boolean;
  cleanupCompletedAt?: number;
  expectsCompletionMessage?: boolean;
  startedAt?: number;
  endedAt?: number;
  outcome?: { status?: string; error?: string };
  completion?: { required?: boolean; resultText?: string; capturedAt?: number };
  delivery?: {
    status?: string;
    justDoManagedJoin?: {
      state?: string;
      controllerSessionKey?: string;
      toolCallId?: string;
      startedAt?: number;
      originalCleanup?: 'keep' | 'delete';
      originalExpectsCompletionMessage?: boolean;
      toolResultCommittedAt?: number;
      consumedAt?: number;
    };
  };
};

const classificationPatch =
  require('../scripts/patches/v2026.7.1-2/017-managed-session-classification.cjs') as {
    __testing: {
      isJustDoManagedSessionFromRuns: (runs: Map<string, RunEntry>, sessionKey: string) => boolean;
    };
  };
const sameRunJoinPatch =
  require('../scripts/patches/v2026.7.1-2/018-managed-same-run-join.cjs') as {
    __testing: {
      buildJustDoManagedJoinResult: (entry: RunEntry) => Record<string, unknown>;
      partitionJustDoManagedJoinResults: (entries: RunEntry[]) => {
        completed: RunEntry[];
        pending: number;
      };
      selectJustDoManagedJoinVisibleRuns: (entries: RunEntry[]) => RunEntry[];
    };
  };
const commitPatch = require('../scripts/patches/v2026.7.1-2/019-managed-join-commits.cjs') as {
  __testing: {
    markJustDoManagedJoinToolResultInRuns: (
      runs: Map<string, RunEntry>,
      controllerSessionKey: string,
      toolCallId: string,
      now: number,
    ) => boolean;
    commitJustDoManagedJoinContinuationInRuns: (
      runs: Map<string, RunEntry>,
      controllerSessionKey: string,
      now: number,
    ) => { changed: boolean; deleteRunIds: string[] };
  };
};
const recoveryPatch = require('../scripts/patches/v2026.7.1-2/020-managed-join-recovery.cjs') as {
  __testing: { restoreJustDoManagedJoinEntry: (entry: RunEntry) => boolean };
};
const identityDeliveryPatch =
  require('../scripts/patches/v2026.7.1-2/021-managed-join-identity-delivery.cjs') as {
    __testing: { shouldSuppressJustDoManagedJoinAnnounce: (entry: RunEntry) => boolean };
  };

describe('managed-session-classification capability', () => {
  test('accepts only an unambiguous ancestry rooted at agent:*:justdo:*', () => {
    const classify = classificationPatch.__testing.isJustDoManagedSessionFromRuns;
    const nestedRuns = new Map<string, RunEntry>([
      [
        'child',
        {
          childSessionKey: 'agent:main:subagent:child',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      ],
    ]);

    expect(classify(new Map(), 'agent:main:justdo:parent')).toBe(true);
    expect(classify(nestedRuns, 'agent:main:subagent:child')).toBe(true);
    expect(classify(new Map(), 'agent:main:cron:nightly')).toBe(false);
    expect(classify(new Map(), 'agent:main:subagent:orphan')).toBe(false);

    const cycle = new Map<string, RunEntry>([
      ['a', { childSessionKey: 'child:a', controllerSessionKey: 'child:b' }],
      ['b', { childSessionKey: 'child:b', controllerSessionKey: 'child:a' }],
    ]);
    expect(classify(cycle, 'child:a')).toBe(false);

    nestedRuns.set('conflict', {
      childSessionKey: 'agent:main:subagent:child',
      controllerSessionKey: 'agent:main:cron:nightly',
    });
    expect(classify(nestedRuns, 'agent:main:subagent:child')).toBe(false);
  });
});

describe('managed-same-run-join capability', () => {
  test('returns only durably captured waiting results and keeps the rest pending', () => {
    const completed: RunEntry = {
      runId: 'run-complete',
      childSessionKey: 'agent:main:subagent:complete',
      startedAt: 10,
      endedAt: 20,
      outcome: { status: 'ok' },
      completion: { resultText: 'finished', capturedAt: 21 },
      delivery: { justDoManagedJoin: { state: 'waiting' } },
    };
    const missingCapture: RunEntry = {
      runId: 'run-not-captured',
      endedAt: 20,
      delivery: { justDoManagedJoin: { state: 'waiting' } },
    };
    const alreadyPresented: RunEntry = {
      runId: 'run-presented',
      endedAt: 20,
      completion: { resultText: 'shown', capturedAt: 21 },
      delivery: { justDoManagedJoin: { state: 'presented' } },
    };

    expect(
      sameRunJoinPatch.__testing.partitionJustDoManagedJoinResults([
        completed,
        missingCapture,
        alreadyPresented,
      ]),
    ).toEqual({ completed: [completed], pending: 2 });
    expect(sameRunJoinPatch.__testing.buildJustDoManagedJoinResult(completed)).toEqual({
      runId: 'run-complete',
      sessionKey: 'agent:main:subagent:complete',
      status: 'ok',
      result: 'finished',
      startedAt: 10,
      endedAt: 20,
    });
    expect(
      sameRunJoinPatch.__testing.selectJustDoManagedJoinVisibleRuns([
        completed,
        missingCapture,
        alreadyPresented,
        {
          runId: 'run-committed',
          delivery: { justDoManagedJoin: { state: 'tool_result_committed' } },
        },
      ]),
    ).toEqual([completed, missingCapture]);
  });
});

describe('managed-join-commit capability', () => {
  test('fences delete cleanup behind distinct tool-result and continuation commits', () => {
    const presented: RunEntry = {
      cleanup: 'keep',
      delivery: {
        justDoManagedJoin: {
          state: 'presented',
          controllerSessionKey: 'agent:main:justdo:parent',
          toolCallId: 'yield-1',
          originalCleanup: 'delete',
        },
      },
    };
    const wrongCall: RunEntry = {
      delivery: {
        justDoManagedJoin: {
          state: 'presented',
          controllerSessionKey: 'agent:main:justdo:parent',
          toolCallId: 'yield-2',
        },
      },
    };
    const runs = new Map<string, RunEntry>([
      ['run-presented', presented],
      ['run-wrong-call', wrongCall],
    ]);

    expect(
      commitPatch.__testing.commitJustDoManagedJoinContinuationInRuns(
        runs,
        'agent:main:justdo:parent',
        99,
      ),
    ).toEqual({ changed: false, deleteRunIds: [] });
    expect(presented.cleanup).toBe('keep');

    expect(
      commitPatch.__testing.markJustDoManagedJoinToolResultInRuns(
        runs,
        'agent:main:justdo:parent',
        'yield-1',
        100,
      ),
    ).toBe(true);
    expect(presented.delivery?.justDoManagedJoin).toMatchObject({
      state: 'tool_result_committed',
      toolResultCommittedAt: 100,
    });
    expect(wrongCall.delivery?.justDoManagedJoin?.state).toBe('presented');
    expect(presented.cleanup).toBe('keep');

    expect(
      commitPatch.__testing.commitJustDoManagedJoinContinuationInRuns(
        runs,
        'agent:main:justdo:parent',
        101,
      ),
    ).toEqual({ changed: true, deleteRunIds: ['run-presented'] });
    expect(presented.delivery?.justDoManagedJoin).toMatchObject({
      state: 'consumed',
      consumedAt: 101,
    });
    expect(presented.cleanup).toBe('delete');
  });
});

describe('managed-join-recovery capability', () => {
  test('restores native delivery for unconsumed joins and leaves consumed joins fenced', () => {
    const waiting: RunEntry = {
      cleanup: 'keep',
      cleanupHandled: true,
      cleanupCompletedAt: 50,
      expectsCompletionMessage: false,
      completion: { required: false },
      delivery: {
        status: 'not_required',
        justDoManagedJoin: {
          state: 'waiting',
          startedAt: 10,
          originalCleanup: 'delete',
          originalExpectsCompletionMessage: true,
        },
      },
    };
    expect(recoveryPatch.__testing.restoreJustDoManagedJoinEntry(waiting)).toBe(true);
    expect(waiting).toMatchObject({
      cleanup: 'delete',
      cleanupHandled: false,
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending', createdAt: 10 },
    });
    expect(waiting.cleanupCompletedAt).toBeUndefined();
    expect(waiting.delivery).not.toHaveProperty('justDoManagedJoin');

    const consumed: RunEntry = {
      delivery: { justDoManagedJoin: { state: 'consumed' } },
    };
    expect(recoveryPatch.__testing.restoreJustDoManagedJoinEntry(consumed)).toBe(false);
    expect(consumed.delivery?.justDoManagedJoin?.state).toBe('consumed');
  });
});

describe('managed-session-identity-and-delivery capability', () => {
  test('suppresses native announce only while a managed join owns delivery', () => {
    const suppress = identityDeliveryPatch.__testing.shouldSuppressJustDoManagedJoinAnnounce;
    for (const state of ['waiting', 'presented', 'tool_result_committed', 'consumed']) {
      expect(suppress({ delivery: { justDoManagedJoin: { state } } })).toBe(true);
    }
    expect(suppress({ delivery: { justDoManagedJoin: { state: 'failed' } } })).toBe(false);
    expect(suppress({ delivery: { status: 'pending' } })).toBe(false);
  });

  test('restores exactly one native delivery when an owned join cannot be consumed', () => {
    const entry: RunEntry = {
      cleanup: 'keep',
      expectsCompletionMessage: false,
      completion: { required: false },
      delivery: {
        status: 'not_required',
        justDoManagedJoin: {
          state: 'presented',
          startedAt: 10,
          originalCleanup: 'delete',
          originalExpectsCompletionMessage: true,
        },
      },
    };
    const suppress = identityDeliveryPatch.__testing.shouldSuppressJustDoManagedJoinAnnounce;

    expect(suppress(entry)).toBe(true);
    expect(recoveryPatch.__testing.restoreJustDoManagedJoinEntry(entry)).toBe(true);
    expect(entry).toMatchObject({
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending', createdAt: 10 },
    });
    expect(suppress(entry)).toBe(false);
    expect(recoveryPatch.__testing.restoreJustDoManagedJoinEntry(entry)).toBe(false);
  });

  test('records identity evidence without introducing a session-id reassignment', () => {
    const patchSource = fs.readFileSync(
      path.join(
        process.cwd(),
        'scripts/patches/v2026.7.1-2/021-managed-join-identity-delivery.cjs',
      ),
      'utf8',
    );
    expect(patchSource).toContain('gatewaySessionId: opts.sessionId');
    expect(patchSource).toContain('getLatestSubagentRunByChildSessionKey(params.childSessionKey)');
    expect(patchSource).not.toContain(').getSubagentRunByChildSessionKey(params.childSessionKey)');
    expect(patchSource).not.toMatch(/(?:entry|opts)\.sessionId\s*=/);
  });
});

describe('managed join patch documentation contracts', () => {
  test('keeps the legacy sibling-transcript heuristic out of the managed delivery design', () => {
    const patchRoot = path.join(process.cwd(), 'scripts/patches/v2026.7.1-2');
    expect(
      fs
        .readdirSync(patchRoot)
        .some(name => name.endsWith('visible-sibling-completion-dedupe.cjs')),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(patchRoot, '021-managed-join-identity-delivery.cjs'), 'utf8'),
    ).toContain('shouldSuppressJustDoManagedJoinAnnounce');
    expect(
      fs.readFileSync(path.join(patchRoot, '016-completion-delivery-queue.cjs'), 'utf8'),
    ).toContain('withSubagentCompletionDeliveryLock(key, commit)');
  });

  test.each([
    '017-managed-session-classification.cjs',
    '018-managed-same-run-join.cjs',
    '019-managed-join-commits.cjs',
    '020-managed-join-recovery.cjs',
    '021-managed-join-identity-delivery.cjs',
  ])('%s declares capability, target, scope, safety and removal condition', fileName => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/patches/v2026.7.1-2', fileName),
      'utf8',
    );
    for (const heading of ['Capability:', 'Target:', 'Scope:', 'Safety:', 'Remove when:']) {
      expect(source).toContain(`// ${heading}`);
    }
  });
});
