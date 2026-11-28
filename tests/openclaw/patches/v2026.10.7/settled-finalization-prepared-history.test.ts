import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const { TARGET, HARNESS, HISTORY, transform, verifyCurrent } = require('../../../../scripts/patches/v2026.10.7/047-settled-finalization-prepared-history.cjs').__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const target = path.join(process.env.OPENCLAW_PRISTINE_DIR ?? 'vendor/openclaw-runtime/current', TARGET);
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';

const request = { role: 'user', content: 'Write the report and explain what it found.' };
const summary = { role: 'compactionSummary', summary: 'Relevant facts already selected for the source turn.' };
const assistant = { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'write-1', name: 'write' }] };
const receipt = { role: 'toolResult', toolCallId: 'write-1', toolName: 'write', isError: false, content: 'Report written successfully.' };
const empty = { role: 'assistant', stopReason: 'stop', content: [] };
const prepared = [summary, request, assistant, receipt, empty];
const rawHistory = [
  { role: 'user', content: 'Excluded raw history. '.repeat(1_000) },
  { role: 'assistant', stopReason: 'stop', content: 'Earlier answer.' },
  request, assistant, receipt, empty,
];
const sourceAttempt = {
  messagesSnapshot: prepared,
  currentAttemptAssistant: empty,
  itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
  toolMetas: [{ toolCallId: 'write-1', toolName: 'write', isError: false }],
};

function createFixture(source: string) {
  const sessionManager = { messages: [...rawHistory] };
  const wire = vi.fn((messages: unknown[]) => {
    if (Buffer.byteLength(JSON.stringify(messages)) > 4_096) throw new Error('413 request too large');
    return 'The report was written.';
  });
  const run = vi.fn(async (attempt) => {
    const agent = { state: { messages: [...sessionManager.messages] } };
    const activeSession = { agent, get messages() { return agent.state.messages; } };
    await runtime.prepareHistory({
      attempt,
      setup: { effectiveWorkspace: '.', sessionAgentId: 'fixture' },
      prepared: {
        toolCatalog: { toolSearchRunPlan: { capabilityToolNames: [], replayAllowedToolNames: ['write'] } },
        sessionRuntime: {
          agentSession: { activeSession, settingsManager: { getCompactionReserveTokens: () => 0 } },
          state: { systemPromptText: 'Only summarize the results.' },
          boundary: {},
          sessionManager: attempt.sessionManager,
          transcriptPolicy: {},
          transport: {},
        },
      },
    }, vi.fn());
    return wire(activeSession.messages);
  });
  const runtime = runInNewContext([
    `async ${functionRange(source, HISTORY).text}`,
    functionRange(source, HARNESS).text,
    functionRange(source, 'buildRestrictedFinalizationAttempt').text,
    functionRange(source, 'resolveSettledToolBatchEvidence').text,
    functionRange(source, 'readSettledToolCalls').text,
    `({ createHarness: ${HARNESS}, prepareHistory: ${HISTORY} })`,
  ].join('\n'), {
    process: { env: {} },
    BUILTIN_AGENT_HARNESS_METADATA: {},
    builtInOpenClawHarnesses: new WeakSet(),
    OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST: {},
    runHostPreparedIsolatedCompletion: vi.fn(),
    runEmbeddedAttempt: run,
    projectSettledTurnFinalizationAttemptResult: (result: unknown) => result,
    sanitizeSessionHistory: async ({ messages }: { messages: unknown[] }) => messages,
    validateReplayTurns: async ({ messages }: { messages: unknown[] }) => messages,
    prepareHarnessContextEnginePrompt: async ({ messages }: { messages: unknown[] }) => ({
      messages, systemPrompt: 'Only summarize the results.',
    }),
    hasAsyncActivity: () => false,
  });
  return {
    finalize: (settledAttempt: unknown) => runtime.createHarness().finalizeSettledTurn({
      attempt: { model: { api: 'openai-completions', contextWindow: 24_000 }, sessionManager, sessionPersistence: 'detached' },
      settledAttempt,
    }),
    run,
    wire,
    sessionManager,
  };
}

describe.skipIf(!required && !fs.existsSync(target))('built-in settled finalization prepared history', () => {
  it('fits using the source attempt view and keeps the active request, write receipt and transcript', async () => {
    const native = fs.readFileSync(target, 'utf8');
    const patched = transform(native);
    const fixture = createFixture(patched);
    const withContext = {
      ...sourceAttempt,
      settledTurnFinalizationContext: { source: 'openclaw-transcript', messages: Object.freeze([...prepared]) },
    };

    if (native !== patched) {
      const baseline = createFixture(native);
      await expect(baseline.finalize(withContext)).rejects.toThrow('413 request too large');
      expect(baseline.wire).toHaveBeenCalledExactlyOnceWith(rawHistory);
    }
    await expect(fixture.finalize(withContext)).resolves.toBe('The report was written.');
    await expect(fixture.finalize(sourceAttempt)).resolves.toBe('The report was written.');
    expect(fixture.wire.mock.calls).toEqual([[prepared], [prepared]]);
    expect(fixture.run.mock.calls.every(([attempt]) => attempt.disableTools === true &&
      attempt.skipPreparedUserTurnMessage === true && attempt.suppressNextUserMessagePersistence === true &&
      attempt.sessionManager === fixture.sessionManager && Object.isFrozen(attempt.settledTurnFinalizationMessages))).toBe(true);
    expect(fixture.sessionManager.messages).toEqual(rawHistory);
  });

  it('retains the native fallback when the prepared history cannot prove the active request and settled batch', async () => {
    const fixture = createFixture(transform(fs.readFileSync(target, 'utf8')));
    const hidden = { ...request, display: false, provenance: { kind: 'internal_system' } };
    const controls = [
      { source: 'unavailable' },
      { source: 'openclaw-transcript', messages: [summary, hidden, assistant, receipt, empty] },
      { source: 'openclaw-transcript', messages: [summary, request, assistant, empty] },
    ];

    for (const context of controls) {
      await expect(fixture.finalize({ ...sourceAttempt, settledTurnFinalizationContext: context }))
        .rejects.toThrow('413 request too large');
    }
    expect(fixture.wire.mock.calls).toEqual(controls.map(() => [rawHistory]));
  });

  it('verifies the compiled owner and rejects a patch that stops short of using the prepared history', () => {
    const patched = transform(fs.readFileSync(target, 'utf8'));
    const compiled = transformSync(patched, { format: 'esm', target: 'node24' }).code;
    expect(transform(patched)).toBe(patched);
    expect(() => verifyCurrent(compiled)).not.toThrow();
    const partial = patched.replace('selectedFinalizationMessages ? [...selectedFinalizationMessages] : activeSession.messages', 'activeSession.messages');
    expect(partial).not.toBe(patched);
    expect(() => transform(partial)).toThrow('does not reach the native model view');
  });
});
