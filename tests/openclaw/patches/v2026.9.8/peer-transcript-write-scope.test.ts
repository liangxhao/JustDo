import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const { transform, CONTRACT } = require('../../../../scripts/patches/v2026.9.8/039-peer-transcript-write-scope.cjs').__testing;

// The caller factory restores its whole snapshot before the bound dispatcher.
// Detaching outside this factory is too early: the source writer returns.
const fixture = `
function runWithoutOwnedSessionTranscriptWrites(run) { return writer.exit(run); }
async function callAgentToolGatewayRequestBound(request, resolver, identity, assertCaller, forceTransport = false, revalidate = true) {
  const method = request.method;
  const signal = request.signal;
  const guard = request.sessionMutationCommitGuard;
  request.assertDispatchCurrent?.();
  assertCaller?.();
  guard?.();
  signal?.throwIfAborted();
  return runBoundInProcessGatewayCall(() => dispatchGatewayMethodInProcess(method, request.params, withInProcessAgentRuntimeIdentity({resolver, forceTransport, revalidate}, identity)));
}
function bindAgentToolGatewayRequest() {
  const caller = authority.getStore();
  const snapshot = AsyncLocalStorage.snapshot();
  return request => snapshot(() => callAgentToolGatewayRequestBound(request, caller.resolver, caller.identity, caller.assertCurrent));
}`;

function createHarness() {
  const writer = new AsyncLocalStorage<string>();
  const cliHistory = new AsyncLocalStorage<string>();
  const authority = new AsyncLocalStorage<{ resolver: object; identity: object; assertCurrent: () => void }>();
  const observed: unknown[] = [];
  const context = vm.createContext({
    AsyncLocalStorage, writer, authority,
    runBoundInProcessGatewayCall: (run: () => unknown) => run(),
    withInProcessAgentRuntimeIdentity: (options: object, identity: object) => ({ ...options, identity }),
    dispatchGatewayMethodInProcess: async (method: string, params: unknown, options: unknown) => {
      await Promise.resolve();
      observed.push({ method, params, options, writer: writer.getStore(), cliHistory: cliHistory.getStore(), authority: authority.getStore() });
      return 'accepted';
    },
  });
  // Model the native detach helper, including the CLI-history boundary.
  const source = fixture.replace('return writer.exit(run);', 'return writer.exit(() => cliHistory.run(undefined, run));');
  Object.assign(context, { cliHistory });
  vm.runInContext(transform(source), context);
  return { context, writer, cliHistory, authority, observed };
}

describe('native peer transcript write scope', () => {
  it('detaches after the captured source snapshot while retaining caller authority and exact arguments', async () => {
    const { context, writer, cliHistory, authority, observed } = createHarness();
    const caller = { resolver: {}, identity: {}, assertCurrent: () => undefined };
    const params = { sessionKey: 'agent:researcher:worker', idempotencyKey: 'original-run' };
    await authority.run(caller, () => writer.run('source-writer', () => cliHistory.run('source-cli', async () => {
      const call = context.bindAgentToolGatewayRequest();
      expect(await writer.exit(() => call({ method: 'agent', params }))).toBe('accepted');
      expect(writer.getStore()).toBe('source-writer');
      expect(cliHistory.getStore()).toBe('source-cli');
    })));
    expect(observed).toEqual([{ method: 'agent', params, options: { resolver: caller.resolver, identity: caller.identity, forceTransport: false, revalidate: true }, writer: undefined, cliHistory: undefined, authority: caller }]);
    expect((observed[0] as { params: unknown }).params).toBe(params);
  });

  it('preserves writer context for session control and other RPCs', async () => {
    const { context, writer, authority, observed } = createHarness();
    await authority.run({ resolver: {}, identity: {}, assertCurrent: () => undefined }, () => writer.run('source-writer', async () => {
      const call = context.bindAgentToolGatewayRequest();
      await call({ method: 'sessions.patch', params: {} });
      await call({ method: 'sessions.abort', params: {} });
    }));
    expect(observed.map(item => (item as { writer: string }).writer)).toEqual(['source-writer', 'source-writer']);
  });

  it.each(['caller', 'commit', 'dispatch', 'abort'])('retains the %s rejection without dispatch or retry', async guard => {
    const { context, writer, authority, observed } = createHarness();
    const error = new Error('revoked ' + guard);
    const reject = () => { throw error; };
    const caller = { resolver: {}, identity: {}, assertCurrent: guard === 'caller' ? reject : () => undefined };
    await authority.run(caller, () => writer.run('source-writer', async () => {
      const call = context.bindAgentToolGatewayRequest();
      await expect(call({
        method: 'agent', params: {},
        sessionMutationCommitGuard: guard === 'commit' ? reject : undefined,
        assertDispatchCurrent: guard === 'dispatch' ? reject : undefined,
        signal: guard === 'abort' ? AbortSignal.abort(error) : undefined,
      })).rejects.toBe(error);
      expect(writer.getStore()).toBe('source-writer');
    }));
    expect(observed).toEqual([]);
  });

  it('accepts only the current exact patch and the markerless bundled shape', () => {
    const patched = transform(fixture);
    expect(transform(patched)).toBe(patched);
    expect(transform(patched.replace('// ' + CONTRACT, ''), 'gateway-bundle.mjs')).toBe(patched.replace('// ' + CONTRACT, ''));
    expect(() => transform(patched.replace('args[0]?.method === "agent"', 'true'))).toThrow('partial');
    expect(() => transform(patched.replace('runWithoutOwnedSessionTranscriptWrites;', 'otherWriter;'))).toThrow('binding');
    expect(() => transform(patched.replace(CONTRACT, CONTRACT.replace('9_8', '9_7')))).toThrow('historical');
    expect(() => transform(patched.replace('// ' + CONTRACT, ''))).toThrow('missing');
    expect(() => transform(fixture + fixture)).toThrow('topology');
    expect(() => transform(fixture.replace('request.signal', 'undefined'))).toThrow('safety');
  });

  it('recognizes the pinned native worker with renamed local parameters', () => {
    const worker = fixture.replaceAll('request', 'Ot');
    const patched = transform(worker);
    expect(transform(patched)).toBe(patched);
  });

  it('verifies the esbuild-renamed dispatcher without broadening its method condition', () => {
    const bundled = transform(fixture).replace('// ' + CONTRACT, '')
      .replace(/\bargs\b/g, 'args2').replace(/\bdispatch\b/g, 'dispatch2');
    expect(transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    expect(() => transform(bundled.replace('args2[0]?.method === "agent"', 'true'), 'gateway-bundle.mjs')).toThrow('partial');
  });
});
