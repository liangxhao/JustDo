import { afterEach, expect, test, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.7.1-2/039-recovery-compaction-progress.cjs') as {
  transform: (content: string, filePath: string) => string;
  progressHelper: string;
};

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for('justdo.compaction-stream-listeners')
  ];
});

const fixture = `async function run() {
  const onCompactionHookMessages = async (payload) => {
    const messages = payload.messages.filter((message) => message.trim().length > 0);
    if (messages.length === 0) return;
    await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
  };
  const runOwnsCompactionBeforeHook = async () => {};
  const runOwnsCompactionAfterHook = async () => {};

  let timeoutCompactResult;
  await runOwnsCompactionBeforeHook("timeout recovery");
  try {
    timeoutCompactResult = await compactContextEngineWithSafetyTimeout(contextEngine, {});
  } catch (compactErr) {
    timeoutCompactResult = { ok: false, compacted: false, reason: String(compactErr) };
  }
  const previousSessionId = timeoutCompactResult.compacted ? activeSessionId : void 0;
  await runOwnsCompactionAfterHook("timeout recovery", timeoutCompactResult, previousSessionId);

  let compactResult;
  let previousSessionId;
  await runOwnsCompactionBeforeHook("overflow recovery");
  try {
    compactResult = await compactContextEngineWithSafetyTimeout(contextEngine, {});
  } catch (compactErr) {
    compactResult = { ok: false, compacted: false, reason: String(compactErr) };
  }
  await runOwnsCompactionAfterHook("overflow recovery", compactResult, previousSessionId);
}`;

test('publishes direct recovery compaction lifecycle and streamed summary updates', () => {
  const transformed = patch.transform(fixture, 'embedded-agent.js');

  expect(transformed).toContain('JUSTDO_RECOVERY_COMPACTION_PROGRESS_V2026_7_1_2');
  expect(transformed).toContain('phase: "start"');
  expect(transformed).toContain('phase: "update"');
  expect(transformed).toContain('elapsedMs: Date.now() - startedAt');
  expect(transformed).toContain('if (justDoRecoveryCompactionProgressActive) return');
  expect(transformed).toContain('finishJustDoTimeoutCompactionProgress(timeoutCompactResult)');
  expect(transformed).toContain('finishJustDoOverflowCompactionProgress(compactResult)');
  expect(
    transformed.indexOf('finishJustDoTimeoutCompactionProgress(timeoutCompactResult)'),
  ).toBeGreaterThan(
    transformed.indexOf(
      'runOwnsCompactionAfterHook("timeout recovery", timeoutCompactResult, previousSessionId)',
    ),
  );
  expect(transformed).toContain('listeners.get(compactionSessionId) === listener');
  expect(patch.transform(transformed, 'embedded-agent.js')).toBe(transformed);

  const bundled = transformed.replace(
    /\s*\/\/ JUSTDO_RECOVERY_COMPACTION_PROGRESS_V2026_7_1_2/u,
    '',
  );
  expect(patch.transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
});

test('rejects an ambiguous recovery anchor', () => {
  expect(() => patch.transform(`${fixture}\n${fixture}`, 'ambiguous.js')).toThrow(
    /anchor count is 2, expected 1/u,
  );
});

test('streams ordered deltas, publishes the final snapshot, and releases the listener', async () => {
  vi.useFakeTimers();
  const events: Array<Record<string, unknown>> = [];
  const createProgress = new Function(
    'params',
    'activeSessionId',
    `let justDoRecoveryCompactionProgressActive = false;
${patch.progressHelper}
return {
  begin: beginJustDoRecoveryCompactionProgress,
  isActive: () => justDoRecoveryCompactionProgressActive
};`,
  ) as (
    params: Record<string, unknown>,
    activeSessionId: string,
  ) => {
    begin: (
      reason: string,
      attempt: number,
    ) => Promise<(result: Record<string, unknown>) => Promise<void>>;
    isActive: () => boolean;
  };
  const progress = createProgress(
    {
      sessionKey: 'agent:main:justdo:session-1',
      onAgentEvent: async (event: { data: Record<string, unknown> }) => {
        events.push(event.data);
      },
    },
    'session-1',
  );

  const finish = await progress.begin('overflow', 2);
  const listeners = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for('justdo.compaction-stream-listeners')
  ] as Map<string, (delta: string) => void>;
  listeners.get('session-1')?.('first ');
  listeners.get('session-1')?.('second');
  await vi.advanceTimersByTimeAsync(80);
  await finish({
    ok: true,
    compacted: true,
    result: { tokensBefore: 120_000, tokensAfter: 18_000 },
  });

  expect(events).toEqual([
    expect.objectContaining({ phase: 'start', reason: 'overflow', attempt: 2 }),
    expect.objectContaining({ phase: 'update', delta: 'first second' }),
    expect.objectContaining({
      phase: 'end',
      completed: true,
      text: 'first second',
      tokensBefore: 120_000,
      tokensAfter: 18_000,
    }),
  ]);
  expect(listeners.has('session-1')).toBe(false);
  expect(progress.isActive()).toBe(false);
});

test('publishes elapsed heartbeats while the compaction model has not produced text', async () => {
  vi.useFakeTimers();
  const events: Array<Record<string, unknown>> = [];
  const createProgress = new Function(
    'params',
    'activeSessionId',
    `let justDoRecoveryCompactionProgressActive = false;
${patch.progressHelper}
return beginJustDoRecoveryCompactionProgress;`,
  ) as (
    params: Record<string, unknown>,
    activeSessionId: string,
  ) => (
    reason: string,
    attempt: number,
  ) => Promise<(result: Record<string, unknown>) => Promise<void>>;
  const begin = createProgress(
    {
      sessionKey: 'agent:main:justdo:session-1',
      onAgentEvent: async (event: { data: Record<string, unknown> }) => {
        events.push(event.data);
      },
    },
    'session-1',
  );

  const finish = await begin('timeout_recovery', 1);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(events).toEqual([
    expect.objectContaining({ phase: 'start' }),
    expect.objectContaining({ phase: 'update', elapsedMs: 5_000 }),
  ]);

  await finish({ ok: false, compacted: false, reason: 'provider timeout' });
  const eventCountAfterFinish = events.length;
  await vi.advanceTimersByTimeAsync(10_000);

  expect(events).toHaveLength(eventCountAfterFinish);
  expect(events.at(-1)).toEqual(
    expect.objectContaining({ phase: 'failed', error: 'provider timeout' }),
  );
});
