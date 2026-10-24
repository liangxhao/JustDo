/* eslint-disable @typescript-eslint/no-explicit-any -- Execute the actual locked native dispatch with explicit boundary stubs. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { projectToolCallRecoveryFailureSummary } from '../../../../plugins/extensions/runtime-services/tool-call-recovery/policy.mjs';

const { __testing: patch } = require('../../../../scripts/patches/v2026.10.6/029-tool-call-format-recovery.cjs');
const runtime = process.env.OPENCLAW_PRISTINE_DIR ?? path.resolve('build/runtimes/openclaw/win-x64');
const file = path.join(runtime, 'dist/agent-turn-service-CVZmpyt7.mjs');
const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
// In memory only: exercise both pristine/current shapes when using a built runtime.
const native = source && patch.extractFunction(source, 'dispatchAgentRunFromGateway').body.replace(
  'projectToolCallRecoveryFailureSummary(result, readAgentRunTerminalError(result), params.abortController.signal.aborted || diagnostics.incognito)',
  '"failed"',
);
const transformed = native && patch.transformDispatch(native, file);
const diagnostic = Symbol('exact-native-terminal-error');

async function execute(options: any = {}) {
  const result = options.result ?? { meta: { modelFallbackStopReason: 'tool_call_format_recovery' }, [diagnostic]: 'Latest service overloaded.' };
  const controller = new AbortController();
  const published: any[] = [];
  const replies: any[] = [];
  const invoke = vi.fn(async () => { if (options.thrown) throw options.thrown; return result; });
  const params = { runId: 'native-run', ingressOpts: { sessionKey: 'native-session', sessionId: 'physical-session' },
    isIncognito: options.incognito, abortController: controller, context: { chatAbortControllers: new Map(), deps: {}, dedupe: new Map(), logGateway: {} },
    cleanupAbortController: vi.fn(), io: { emitFinal: (reply: any) => replies.push(reply) } };
  const read = (value: any) => Object.hasOwn(value, diagnostic) ? value[diagnostic] : undefined;
  const run = vm.runInNewContext(`${transformed}; dispatchAgentRunFromGateway`, {
    projectToolCallRecoveryFailureSummary,
    createAgentRunDiagnostics: (_key: string, incognito: boolean) => ({ incognito: incognito === true, runtime: {}, forReplay: (entry: any) => entry, warning: () => vi.fn(), errorMeta: () => ({}) }),
    bindGatewayAgentTerminalProducer: () => ({ complete: async () => {}, settle: (promise: Promise<any>) => promise }),
    withAgentCommandExecutionIdentitySpawnFacts: (value: any) => value,
    readAgentRunDispatchExecutionIdentity: () => ({}), justDoManagedRunEnabled: () => false,
    runWithCanonicalSkillWorkspace: (_root: string, fn: () => unknown) => fn(), agentCommandFromGatewayIngress: invoke,
    readAgentRunTerminalOutcome: () => options.ok ? 'completed' : 'failed', readAgentRunTerminalError: read,
    resolveResolvedAgentTimeoutStopReason: () => undefined, normalizeAgentRunTimeoutPhase: (value: unknown) => value,
    buildAgentRunTerminalOutcome: (value: any) => value, formatErrorMessage: (value: unknown) => String(value),
    completeUserTurnProcessing: async (_recorder: unknown, outcome: any) => { if (options.lateAbort) controller.abort(); return outcome; },
    classifyAgentRunTerminalOutcome: (outcome: any) => outcome.status,
    RESOLVED_GATEWAY_STATUS_BY_TERMINAL_CLASSIFICATION: { ok: 'ok', error: 'error', timeout: 'timeout' },
    normalizeAgentRunTerminalReplySnapshot: () => undefined, normalizeAgentRunTerminalReceipt: () => undefined,
    captureAgentJobSession: (value: any) => value, setGatewayDedupeEntries: (value: any) => published.push(value.entry), clearAgentRunContext: vi.fn(),
    isGatewayAgentAbortRejection: () => false, isAbortError: () => false, isTimeoutError: () => false,
    errorShapeFromError: (_code: string, error: Error) => ({ message: error.message }), ErrorCodes: { UNAVAILABLE: 'UNAVAILABLE' },
    projectRejectedGatewayStatus: (outcome: any) => outcome.status, toErrorObject: (value: unknown) => value,
  });
  const settled = await run(params);
  return { result, settled, invoke, published, replies, payload: replies.at(-1)?.[1] };
}

describe.skipIf(!native)('native terminal dispatch recovery error projection', () => {
  it('preserves the current owned error in the final reply and dedupe without another invocation', async () => {
    const observed = await execute();
    expect(observed.payload).toMatchObject({ status: 'error', summary: 'Latest service overloaded.' });
    expect(observed.payload.result).toBe(observed.result);
    expect(observed.published.at(-1).payload.summary).toBe('Latest service overloaded.');
    expect(observed.settled.terminalOutcome.status).toBe('error');
    expect(observed.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    { result: { meta: { error: { message: 'private raw fallback' } } } },
    { result: { meta: { modelFallbackStopReason: 'tool_call_format_recovery', error: { message: 'private raw fallback' } } } },
    { result: { meta: { modelFallbackStopReason: 'provider_review_continuation' }, [diagnostic]: 'Other cause' } },
    { incognito: true }, { lateAbort: true },
  ])('retains the native fallback outside admitted public recovery: %j', async options => {
    const observed = await execute(options);
    expect(observed.payload).toMatchObject({ status: 'error', summary: 'failed' });
  });
  it('leaves native success and timeout summaries unchanged', async () => {
    expect((await execute({ ok: true, result: { meta: {} } })).payload).toMatchObject({ status: 'ok', summary: 'completed' });
    expect((await execute({ result: { meta: { stopReason: 'timeout', modelFallbackStopReason: 'tool_call_format_recovery' }, [diagnostic]: 'Old provider cause' } })).payload)
      .toMatchObject({ status: 'timeout', summary: 'aborted' });
  });
  it('leaves thrown failures on the existing native exception path', async () => {
    const observed = await execute({ thrown: new Error('Current thrown failure') });
    expect(observed.payload).toMatchObject({ status: 'error', summary: 'Current thrown failure' });
    expect(observed.invoke).toHaveBeenCalledTimes(1);
  });
  it('is exactly idempotent and rejects altered summary, raw fallback, privacy and abort guards', () => {
    expect(patch.transformDispatch(transformed, file, { verifyOnly: true })).toBe(transformed);
    expect(() => patch.transformDispatch(native, file, { verifyOnly: true })).toThrow(/missing/);
    for (const altered of [
      transformed.replace('readAgentRunTerminalError(result), params.', 'result.meta.error.message, params.'),
      transformed.replace(' || diagnostics.incognito', ''),
      transformed.replace('params.abortController.signal.aborted || ', ''),
      transformed.replace('responseStatus === "error"', 'responseStatus !== "error"'),
    ]) {
      expect(altered).not.toBe(transformed);
      expect(() => patch.transformDispatch(altered, file, { verifyOnly: true })).toThrow();
    }
  });
  it('rejects a diagnostic reader or public payload rebound to another result', () => {
    for (const altered of [native.replace('readAgentRunTerminalError(result)', 'readAgentRunTerminalError(foreign)'),
      native.replace('\n\t\t\tresult,', '\n\t\t\tresult: foreign,'),
      native.replace('readAgentRunTerminalError(result)', '((result) => readAgentRunTerminalError(result))(foreign)')]) {
      expect(altered).not.toBe(native);
      expect(() => patch.transformDispatch(altered, file)).toThrow();
    }
  });
});
