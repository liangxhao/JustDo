import fs from 'node:fs';
import os from 'node:os';
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
  require('../../../../scripts/patches/v2026.7.1-2/017-managed-session-classification.cjs') as {
    __testing: {
      isJustDoManagedSessionFromRuns: (runs: Map<string, RunEntry>, sessionKey: string) => boolean;
    };
  };
const sameRunJoinPatch =
  require('../../../../scripts/patches/v2026.7.1-2/018-managed-same-run-join.cjs') as {
    __testing: {
      buildJustDoManagedJoinResult: (entry: RunEntry) => Record<string, unknown>;
      partitionJustDoManagedJoinResults: (entries: RunEntry[]) => {
        completed: RunEntry[];
        pending: number;
      };
      selectJustDoManagedJoinVisibleRuns: (entries: RunEntry[]) => RunEntry[];
      reconcileJustDoManagedJoinRuns: (
        expectedByChildSessionKey: Map<string, string>,
        entries: RunEntry[],
      ) => {
        currentRuns: RunEntry[];
        replacements: Array<{ childSessionKey: string; previousRunId: string; runId: string }>;
        missingRunIds: string[];
      };
      hasManagedJoinMutationPersistenceContract: (content: string) => boolean;
    };
  };
const commitPatch = require('../../../../scripts/patches/v2026.7.1-2/019-managed-join-commits.cjs') as {
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
    hasManagedJoinPersistenceContracts: (content: string) => boolean;
  };
};
const recoveryPatch = require('../../../../scripts/patches/v2026.7.1-2/020-managed-join-recovery.cjs') as {
  __testing: {
    restoreJustDoManagedJoinEntry: (entry: RunEntry) => boolean;
    shouldRestoreJustDoManagedJoinRun: (
      runId: string,
      entry: RunEntry,
      controller: string,
      requestedRunIds: Set<string> | null,
      requestedChildSessionKeys?: Set<string> | null,
      onlyCommitted?: boolean,
    ) => boolean;
  };
};
const identityDeliveryPatch =
  require('../../../../scripts/patches/v2026.7.1-2/021-managed-join-identity-delivery.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      shouldSuppressJustDoManagedJoinAnnounce: (entry: RunEntry) => boolean;
      carryJustDoManagedJoinToReplacement: (
        source: RunEntry,
        next: RunEntry,
        previousRunId: string,
        now: number,
      ) => boolean;
    };
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
  test('requires persistence inside the managed join mutation function', () => {
    const direct = `function mutateJustDoManagedJoinEntries(entries, mutator) {
  for (const candidate of entries) {
    const entry = subagentRuns.get(candidate.runId);
    if (entry) mutator(entry);
  }
  persistSubagentRunsToDiskOrThrow(subagentRuns);
}
function next() {}`;
    const atomic = `function mutateJustDoManagedJoinEntries(entries2, mutator) {
  return mutateJustDoManagedJoinEntriesAtomically(subagentRuns, entries2, mutator, persistSubagentRunsToDiskOrThrow);
}
function next() {}`;
    const adjacentOnly = `function mutateJustDoManagedJoinEntries(entries, mutator) {
  for (const candidate of entries) {
    const entry = subagentRuns.get(candidate.runId);
    if (entry) mutator(entry);
  }
}
async function waitForJustDoManagedSubagentsCore() {
  persistSubagentRunsToDiskOrThrow(subagentRuns);
}`;

    expect(sameRunJoinPatch.__testing.hasManagedJoinMutationPersistenceContract(direct)).toBe(
      true,
    );
    expect(sameRunJoinPatch.__testing.hasManagedJoinMutationPersistenceContract(atomic)).toBe(
      true,
    );
    expect(
      sameRunJoinPatch.__testing.hasManagedJoinMutationPersistenceContract(adjacentOnly),
    ).toBe(false);
  });

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

  test('follows a durable steer replacement and reports only truly vanished runs', () => {
    const replacement: RunEntry = {
      runId: 'run-restarted',
      childSessionKey: 'child-restarted',
      delivery: { justDoManagedJoin: { state: 'waiting' } },
    };
    expect(
      sameRunJoinPatch.__testing.reconcileJustDoManagedJoinRuns(
        new Map([
          ['child-present', 'run-present'],
          ['child-restarted', 'run-old'],
          ['child-vanished', 'run-vanished'],
        ]),
        [{ runId: 'run-present', childSessionKey: 'child-present' }, replacement],
      ),
    ).toEqual({
      currentRuns: [{ runId: 'run-present', childSessionKey: 'child-present' }, replacement],
      replacements: [
        {
          childSessionKey: 'child-restarted',
          previousRunId: 'run-old',
          runId: 'run-restarted',
        },
      ],
      missingRunIds: ['run-vanished'],
    });
  });
});

describe('managed-join-commit capability', () => {
  test('requires complete direct or atomic persistence pairs', () => {
    const direct = `function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {
  const changed = markJustDoManagedJoinToolResultInRuns();
  if (changed) persistSubagentRunsOrThrow();
}
function commitJustDoManagedJoinContinuation(controllerSessionKey) {
  const result = commitJustDoManagedJoinContinuationInRuns();
  persistSubagentRunsOrThrow();
}
function next() {}`;
    const atomic = `function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {
  return mutateJustDoSubagentRegistryAtomically(subagentRuns, () => markJustDoManagedJoinToolResultInRuns(), persistSubagentRunsOrThrow).changed;
}
function commitJustDoManagedJoinContinuation(controllerSessionKey) {
  return mutateJustDoSubagentRegistryAtomically(subagentRuns, () => commitJustDoManagedJoinContinuationInRuns(), persistSubagentRunsOrThrow);
}
function next() {}`;
    const partial = `function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {
  return mutateJustDoSubagentRegistryAtomically(subagentRuns, () => markJustDoManagedJoinToolResultInRuns(), persistSubagentRunsOrThrow).changed;
}
function commitJustDoManagedJoinContinuation(controllerSessionKey) {
  const result = commitJustDoManagedJoinContinuationInRuns();
}
function restoreJustDoManagedJoinDelivery() {
  return mutateJustDoSubagentRegistryAtomically(subagentRuns, restore, persistSubagentRunsOrThrow);
}`;

    expect(commitPatch.__testing.hasManagedJoinPersistenceContracts(direct)).toBe(true);
    expect(commitPatch.__testing.hasManagedJoinPersistenceContracts(atomic)).toBe(true);
    expect(commitPatch.__testing.hasManagedJoinPersistenceContracts(partial)).toBe(false);
  });

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

  test('scopes a failed incremental join recovery to the current yield batch', () => {
    const currentWaiting: RunEntry = {
      childSessionKey: 'agent:main:subagent:current',
      delivery: {
        justDoManagedJoin: {
          state: 'waiting',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      },
    };
    const priorCommitted: RunEntry = {
      childSessionKey: 'agent:main:subagent:prior',
      delivery: {
        justDoManagedJoin: {
          state: 'tool_result_committed',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      },
    };
    const shouldRestore = recoveryPatch.__testing.shouldRestoreJustDoManagedJoinRun;

    expect(
      shouldRestore(
        'run-current',
        currentWaiting,
        'agent:main:justdo:parent',
        new Set(['run-current']),
      ),
    ).toBe(true);
    expect(
      shouldRestore(
        'run-prior',
        priorCommitted,
        'agent:main:justdo:parent',
        new Set(['run-current']),
      ),
    ).toBe(false);
  });

  test('restores a steer successor by stable child identity before the waiter reconciles', () => {
    const replacement: RunEntry = {
      childSessionKey: 'agent:main:subagent:current',
      delivery: {
        justDoManagedJoin: {
          state: 'waiting',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      },
    };
    const priorCommitted: RunEntry = {
      childSessionKey: 'agent:main:subagent:current',
      delivery: {
        justDoManagedJoin: {
          state: 'tool_result_committed',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      },
    };
    const shouldRestore = recoveryPatch.__testing.shouldRestoreJustDoManagedJoinRun;
    const expectedRunIds = new Set(['run-before-steer']);
    const expectedChildSessionKeys = new Set(['agent:main:subagent:current']);

    expect(
      shouldRestore(
        'run-replacement',
        replacement,
        'agent:main:justdo:parent',
        expectedRunIds,
        expectedChildSessionKeys,
      ),
    ).toBe(true);
    expect(
      shouldRestore(
        'run-prior-committed',
        priorCommitted,
        'agent:main:justdo:parent',
        expectedRunIds,
        expectedChildSessionKeys,
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(process.cwd(), 'scripts/patches/v2026.7.1-2/018-managed-same-run-join.cjs'),
        'utf8',
      ),
    ).toContain('[...expectedByChildSessionKey.keys()]');
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

  test('transfers waiting ownership across a steer restart', () => {
    const source: RunEntry = {
      cleanup: 'keep',
      expectsCompletionMessage: false,
      delivery: {
        justDoManagedJoin: {
          state: 'waiting',
          controllerSessionKey: 'agent:main:justdo:parent',
          originalCleanup: 'delete',
          originalExpectsCompletionMessage: true,
        },
      },
    };
    const next: RunEntry = {
      cleanup: 'delete',
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    };

    expect(
      identityDeliveryPatch.__testing.carryJustDoManagedJoinToReplacement(
        source,
        next,
        'run-old',
        123,
      ),
    ).toBe(true);
    expect(next).toMatchObject({
      cleanup: 'keep',
      expectsCompletionMessage: false,
      completion: { required: false },
      delivery: {
        justDoManagedJoin: {
          state: 'waiting',
          controllerSessionKey: 'agent:main:justdo:parent',
          restartedFromRunId: 'run-old',
          restartedAt: 123,
        },
      },
    });
  });

  test('patches steer ownership in source chunks and a space-indented gateway bundle', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-managed-join-'));
    const distDir = path.join(runtimeDir, 'dist');
    fs.mkdirSync(distDir);
    const toolsFixture = `function waitForJustDoManagedSubagents() {}
function createSessionsYieldTool(opts) {
\treturn {
\t\t\t\t\tcontrollerSessionKey,
\t\t\t\t\toriginalCleanup: cleanup
\t};
}`;
    const stateFixture = `function clearDeliveryState(entry) {
\tentry.delivery = { status: entry.expectsCompletionMessage === false ? "not_required" : "pending" };
}
function ensureDeliveryState(entry) { return entry.delivery; }`;
    const announceFixture = `async function runSubagentAnnounceFlow(params) {
\t\tconst completionDirectOrigin = expectsCompletionMessage && !requesterIsSubagent ? await resolveSubagentCompletionOrigin({
\t\t\tsessionKey: params.childSessionKey
\t\t}) : undefined;
}`;
    const replacementFixture = (indent: string) => `const preserveFrozenResultFallback = true;
function createSubagentRunManager(params) {
${indent}const previousRunId = params.previousRunId;
${indent}const source = params.source;
${indent}const next = params.next;
${indent}const now = Date.now();
${indent}clearDeliveryState(next);
}`;

    try {
      fs.writeFileSync(path.join(distDir, 'tools.js'), toolsFixture);
      fs.writeFileSync(path.join(distDir, 'state.js'), stateFixture);
      fs.writeFileSync(path.join(distDir, 'announce.js'), announceFixture);
      fs.writeFileSync(path.join(distDir, 'replacement.js'), replacementFixture('\t\t'));
      fs.writeFileSync(
        path.join(runtimeDir, 'gateway-bundle.mjs'),
        [toolsFixture, stateFixture, announceFixture, replacementFixture('    ')].join('\n'),
      );

      expect(
        identityDeliveryPatch
          .applyPatch(runtimeDir)
          .map(fileName => fileName.replaceAll('\\', '/'))
          .sort(),
      ).toEqual([
        'dist/announce.js',
        'dist/replacement.js',
        'dist/state.js',
        'dist/tools.js',
        'gateway-bundle.mjs',
      ]);
      expect(() => identityDeliveryPatch.verifyPatch(runtimeDir)).not.toThrow();
      expect(identityDeliveryPatch.applyPatch(runtimeDir)).toEqual([]);
      expect(fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8')).toContain(
        '    carryJustDoManagedJoinToReplacement(source, next, previousRunId, now);',
      );
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
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
    '036-managed-session-identity-pin.cjs',
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
