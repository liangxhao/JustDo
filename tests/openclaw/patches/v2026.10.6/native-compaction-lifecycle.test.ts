import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.6/022-native-compaction-lifecycle.cjs');
const { justDoCreateCompactionHandlers, justDoRunRecoveryCompaction, transform, CONTRACT } = patch.__testing;
const key = 'agent:main:chat:compaction';
const operationId = '9c57045e-05f0-4eec-9b2f-2118865b47bd';
const deferred = () => {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
};
const makeHandlers = (native: (options: any) => Promise<void>) => {
  const events: any[] = [];
  const opaque = Symbol('native custody');
  const dependencies = {
    randomUUID: () => operationId,
    assertValidParams: () => true,
    validateSessionsCompactParams: () => true,
    readGatewayRequestMutationAuthority: (options: any) => options[opaque] ?? { assertCurrent() {} },
    bindGatewayRequestHandlerMutationAuthority: vi.fn((original: any, adapted: any) => {
      // Native custody is non-enumerable and belongs to the exact options.
      Object.defineProperty(adapted, opaque, { value: dependencies.readGatewayRequestMutationAuthority(original) });
      return adapted;
    }),
    emitSessionOperation: (_context: object, event: unknown) => events.push(event),
    errorShape: (code: string, message: string) => ({ code, message }),
    ErrorCodes: { INVALID_REQUEST: 'INVALID_REQUEST', UNAVAILABLE: 'UNAVAILABLE' },
  };
  const handlers = justDoCreateCompactionHandlers({ 'sessions.compact': native }, dependencies);
  const deps = {};
  const context = { deps };
  const request = (id = operationId, session = key) => ({ context, params: { key: session, operationId: id }, respond: vi.fn() });
  return { handlers, events, dependencies, opaque, request, context };
};

afterEach(() => { vi.useRealTimers(); });

it.skipIf(!process.env.JUSTDO_EXECUTION_PRISTINE_DIR)('binds the actual target handler-custody export and rejects the in-process authority alias', () => {
  const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR!;
  const file = path.join(pristine, 'dist/sessions-compact-BM6UVlSB.mjs');
  const native = fs.readFileSync(file, 'utf8');
  expect(() => patch.__testing.assertNativeManualCustody(native, file)).not.toThrow();
  const current = transform(native, file);
  expect(current).toContain('t as bindGatewayRequestHandlerMutationAuthority');
  expect(() => patch.__testing.assertNativeManualCustody(current, file)).not.toThrow();
  const wrong = current.replace('t as bindGatewayRequestHandlerMutationAuthority', 'n as bindGatewayRequestHandlerMutationAuthority');
  expect(() => transform(wrong, file)).toThrow('custody import');
  expect(() => patch.__testing.assertNativeManualCustody(wrong, file)).toThrow('custody import');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-custody-'));
  try {
    const owner = 'session-mutation-guards-Dw3-XrL6.mjs';
    const source = fs.readFileSync(path.join(pristine, 'dist', owner), 'utf8');
    fs.writeFileSync(path.join(root, owner), source.replace('bindGatewayRequestHandlerMutationAuthority as t', 'bindInProcessRequestMutationAuthority as t'));
    expect(() => patch.__testing.assertNativeManualCustody(current, path.join(root, 'manual.mjs'))).toThrow('custody export');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('native compaction operation custody', () => {
  it('fences an unknown submission before confirming cancellation and never starts a late request', async () => {
    const native = vi.fn(async () => {});
    const { handlers, request } = makeHandlers(native);
    const abort = request();
    await handlers['sessions.compaction.abort'](abort);
    expect(abort.respond.mock.calls[0][1]).toMatchObject({ phase: 'settled', outcome: 'aborted', admitted: false });
    const late = request();
    await handlers['sessions.compact'](late);
    expect(native).not.toHaveBeenCalled();
    expect(late.respond.mock.calls[0][1]).toMatchObject({ outcome: 'aborted' });
  });

  it('keeps preparation cancellation in progress until native cleanup finishes', async () => {
    const preparation = deferred();
    const cleanup = deferred();
    const { handlers, request, events } = makeHandlers(async options => {
      try {
        await preparation.promise;
        options.signal.throwIfAborted();
        options.respond(true, { ok: true, compacted: true });
      } finally { await cleanup.promise; }
    });
    const compact = request();
    const execution = handlers['sessions.compact'](compact);
    const abort = request();
    await handlers['sessions.compaction.abort'](abort);
    expect(abort.respond.mock.calls[0][1]).toMatchObject({ phase: 'in-progress', admitted: true });
    preparation.resolve();
    await Promise.resolve();
    const pending = request();
    await handlers['sessions.compaction.status'](pending);
    expect(pending.respond.mock.calls[0][1].phase).toBe('in-progress');
    expect(events.map(event => event.phase)).toEqual(['start']);
    cleanup.resolve();
    await execution;
    const settled = request();
    await handlers['sessions.compaction.status'](settled);
    expect(settled.respond.mock.calls[0][1]).toMatchObject({ phase: 'settled', outcome: 'aborted' });
    expect(events.at(-1)).toMatchObject({ operationId, phase: 'end', outcome: 'aborted' });
  });

  it('transfers opaque native mutation custody before an asynchronous preparation boundary', async () => {
    const preparation = deferred();
    let current = true;
    const commit = vi.fn();
    const setup = makeHandlers(async options => {
      const authority = setup.dependencies.readGatewayRequestMutationAuthority(options);
      await preparation.promise;
      authority.assertCurrent();
      commit();
      options.respond(true, { ok: true, compacted: true });
    });
    const compact = setup.request();
    Object.defineProperty(compact, setup.opaque, { value: { assertCurrent() { if (!current) throw new Error('revoked source'); } } });
    const execution = setup.handlers['sessions.compact'](compact);
    current = false;
    preparation.resolve();
    await execution;
    expect(setup.dependencies.bindGatewayRequestHandlerMutationAuthority).toHaveBeenCalledOnce();
    expect(setup.dependencies.bindGatewayRequestHandlerMutationAuthority.mock.calls[0][0]).toBe(compact);
    expect(commit).not.toHaveBeenCalled();
    const status = setup.request();
    await setup.handlers['sessions.compaction.status'](status);
    expect(status.respond.mock.calls[0][1]).toMatchObject({ outcome: 'failed', phase: 'settled' });
  });

  it.each([
    [{ ok: false, compacted: false, reason: 'Already compacted' }, 'skipped'],
    [{ ok: false, compacted: false, reason: 'Nothing to compact (session too small)' }, 'skipped'],
    [{ ok: false, compacted: false, reason: 'Compaction cancelled' }, 'aborted'],
    [{ ok: false, compacted: false, reason: 'Provider error: Already compacted' }, 'failed'],
  ])('preserves native response attribution and classifies exact no-op/cancellation results', async (result, outcome) => {
    const { handlers, request } = makeHandlers(async options => { options.respond(true, result); });
    const compact = request();
    await handlers['sessions.compact'](compact);
    expect(compact.respond.mock.calls[0][1]).toMatchObject({ outcome, reason: result.reason });
    const status = request();
    await handlers['sessions.compaction.status'](status);
    expect(status.respond.mock.calls[0][1].reason).not.toBe('Provider error: Already compacted');
  });

  it('keeps a successful commit despite a late abort and retains only bounded accounting metadata', async () => {
    const done = deferred();
    const native = vi.fn(async options => {
      options.respond(true, { ok: true, compacted: true, result: { summary: 'private summary', markerExpected: true, tokensBefore: 20, tokensAfter: 8 } });
      await done.promise;
    });
    const { handlers, request } = makeHandlers(native);
    const compact = request();
    const execution = handlers['sessions.compact'](compact);
    const abort = request();
    await handlers['sessions.compaction.abort'](abort);
    done.resolve();
    await execution;
    const status = request();
    await handlers['sessions.compaction.status'](status);
    expect(status.respond.mock.calls[0][1]).toMatchObject({ outcome: 'completed', markerExpected: true, tokensBefore: 20, tokensAfter: 8 });
    expect(JSON.stringify(status.respond.mock.calls[0][1])).not.toContain('private summary');
    await handlers['sessions.compact'](request());
    expect(native).toHaveBeenCalledOnce();
    const other = request(operationId, 'agent:main:other');
    await handlers['sessions.compaction.status'](other);
    expect(other.respond.mock.calls[0][1].phase).toBe('unknown');
  });

  it('delivers a native failure detail through the live terminal and RPC without retaining it in status', async () => {
    const nativeDetail = 'fixture preparation projection rejected';
    const nativeError = { code: 'INVALID_REQUEST', message: nativeDetail };
    const { handlers, request, events } = makeHandlers(async options => {
      options.respond(false, undefined, nativeError);
    });
    const compact = request();
    await handlers['sessions.compact'](compact);
    expect(compact.respond.mock.calls[0]).toEqual([false, undefined, nativeError]);
    expect(events.at(-1)).toMatchObject({ phase: 'end', outcome: 'failed', reason: nativeDetail });
    const status = request();
    await handlers['sessions.compaction.status'](status);
    expect(status.respond.mock.calls[0][1]).toMatchObject({ phase: 'settled', outcome: 'failed', reason: 'invalid-request' });
    expect(JSON.stringify(status.respond.mock.calls)).not.toContain(nativeDetail);
    const replay = request();
    await handlers['sessions.compact'](replay);
    expect(JSON.stringify(replay.respond.mock.calls)).not.toContain(nativeDetail);
  });

  it('never evicts a cancellation fence when the bounded registry fills', async () => {
    const native = vi.fn(async () => {});
    const { handlers, request } = makeHandlers(native);
    for (let index = 0; index < 4096; index += 1) {
      await handlers['sessions.compaction.abort'](request(`${index.toString(16).padStart(8, '0')}-05f0-4eec-9b2f-2118865b47bd`));
    }
    const overflow = request();
    await handlers['sessions.compact'](overflow);
    expect(overflow.respond.mock.calls[0][0]).toBe(false);
    const old = request('00000000-05f0-4eec-9b2f-2118865b47bd');
    await handlers['sessions.compact'](old);
    expect(old.respond.mock.calls[0][1].outcome).toBe('aborted');
    expect(native).not.toHaveBeenCalled();
  });

  it('requires a UUID and exact status/abort parameters before native admission', async () => {
    const native = vi.fn(async () => {});
    const { handlers, request } = makeHandlers(native);
    const invalid = request('invalid-operation');
    await handlers['sessions.compact'](invalid);
    expect(invalid.respond.mock.calls[0][0]).toBe(false);
    const extra: any = request();
    extra.params.maxLines = 1;
    await handlers['sessions.compaction.abort'](extra);
    expect(extra.respond.mock.calls[0][0]).toBe(false);
    const status = request();
    await handlers['sessions.compaction.status'](status);
    expect(status.respond.mock.calls[0][1].phase).toBe('unknown');
    expect(native).not.toHaveBeenCalled();
  });
});

describe('native recovery compaction observations', () => {
  it.each(['budget', 'overflow', 'timeout_recovery'])('emits start/update/end without a notifier for %s', async trigger => {
    vi.useFakeTimers();
    const completed = deferred();
    const events: any[] = [];
    const input = { runParams: { sessionKey: key, onAgentEvent: (event: object) => events.push(event) } };
    const execution = justDoRunRecoveryCompaction(async () => { await completed.promise; return { result: { ok: true, compacted: true, result: { markerExpected: true, tokensBefore: 20, tokensAfter: 8 } } }; }, input, { trigger });
    await vi.advanceTimersByTimeAsync(5000);
    completed.resolve();
    await execution;
    expect(events.map(event => event.data.phase)).toEqual(['start', 'update', 'end']);
    expect(new Set(events.map(event => event.data.itemId)).size).toBe(1);
    expect(events.at(-1).data).toMatchObject({ outcome: 'completed', completed: true, markerExpected: true, tokensAfter: 8 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not delay execution or retain an unbounded heartbeat backlog behind remote notice delivery', async () => {
    vi.useFakeTimers();
    const pending = new Promise(() => {});
    const callback = vi.fn(() => pending);
    const native = vi.fn(async () => ({ result: { ok: true, compacted: false } }));
    await justDoRunRecoveryCompaction(native, { runParams: { onAgentEvent: callback } }, { trigger: 'overflow' });
    expect(native).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1][0].data.outcome).toBe('skipped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ ok: false, compacted: false, reason: 'Already compacted' }, 'skipped'],
    [{ ok: false, compacted: false, reason: 'Compaction cancelled' }, 'aborted'],
    [{ ok: false, compacted: false, reason: 'Provider error: already compacted' }, 'failed'],
    [{ ok: true, compacted: true, result: { kind: 'server-endpoint' } }, 'completed'],
  ])('reports the native outcome and marker-free success', async (result, outcome) => {
    const events: any[] = [];
    await justDoRunRecoveryCompaction(async () => ({ result }), { runParams: { onAgentEvent: (event: unknown) => events.push(event) } }, { trigger: 'timeout_recovery' });
    expect(events.at(-1).data).toMatchObject({ outcome, markerExpected: false });
  });

  it('reports thrown cancellation and retains the original error without leaking it into event metadata', async () => {
    const controller = new AbortController();
    const events: any[] = [];
    const error = new Error('private provider error');
    await expect(justDoRunRecoveryCompaction(async () => { controller.abort(); throw error; }, { runParams: { abortSignal: controller.signal, onAgentEvent: (event: unknown) => events.push(event) } }, { trigger: 'budget' })).rejects.toBe(error);
    expect(events.at(-1).data).toMatchObject({ outcome: 'aborted' });
    expect(JSON.stringify(events)).not.toContain('private provider error');
  });
});

const schemas = `const SessionsCompactParamsSchema = closedObject({key:NonEmptyString,agentId:Type.Optional(NonEmptyString),maxLines:Type.Optional(Type.Integer({minimum:1}))});
closedObject({operationId:NonEmptyString,operation:Type.Literal("compact"),phase:Type.Union([Type.Literal("start"),Type.Literal("end")]),sessionKey:NonEmptyString,agentId:Type.Optional(NonEmptyString),ts:Type.Integer({ minimum: 0 }),completed:Type.Optional(Type.Boolean()),reason:Type.Optional(Type.String())});`;
const manual = `function bindGatewayRequestHandlerMutationAuthority() {}
const sessionCompactHandlers = {"sessions.compact":async (options)=>{
const {params,respond,context,signal}=options;
const assertRequestCurrent = () => { requestAuthority.assertCurrent(); };
const operationId = randomUUID();
emitSessionOperation(context, {operationId,operation: "compact",phase: "start",sessionKey: target.canonicalKey,agentId: target.agentId});
const emitCompactionEnd = (completed, reason) => emitSessionOperation(context, {operationId,operation: "compact",phase: "end",sessionKey: target.canonicalKey,agentId: target.agentId,completed,reason});
await preparation(); assertRequestCurrent(); emitCompactionEnd(true); respond(true,{ok:true,compacted:true,operationId});
}};`;
const recovery = `async function compactEmbeddedRunForRecovery(input,recovery) {
const owner=input.prepareRecoveryOwner();const result=await compactContextEngineWithSafetyTimeout(input);
input.assertRecoveryActive();return {result};}`;
const producer =
  'function producer(){return {result:{sessionTarget: resultSessionTarget,summary: clientResult.summary}};}';
const forward =
  'function forward(){return {tokensBefore: result.result.tokensBefore,summary: result.result.summary};}';
const descriptors =
  'const coreMethods=[ ["sessions.compact","sessions-compact","operator.admin","<=2026.7"] ];';
const policies =
  'const SESSION_TARGET_POLICY_BY_METHOD = new Map([["sessions.compact", {fields: ["key"],required: true}]]);';

describe('compaction pristine build contract', () => {
  it('includes ordinary native support modules in the immutable build recipe fingerprint', () => {
    const proof = require('../../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
    const repo = path.resolve(__dirname, '../../../..');
    const support = 'src/main/openclaw/runtime/native-support/compaction-lifecycle.mjs';
    expect(proof.listBuildRecipeFiles(repo)).toContain(path.join(repo, support));
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-compaction-fingerprint-'));
    try {
      const inputs = path.join(isolated, 'scripts/patches/v2026.10.6');
      fs.mkdirSync(inputs, { recursive: true });
      fs.writeFileSync(
        path.join(inputs, '038-native-compaction-lifecycle.cjs'),
        'fixture transformer',
      );
      for (const file of proof.listBuildRecipeFiles(isolated)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'fixture recipe input');
      }
      const before = proof.buildOpenClawBuildRecipeFingerprint(isolated, 'v2026.10.6');
      fs.writeFileSync(path.join(isolated, support), 'fixture helper revision 2');
      expect(proof.buildOpenClawBuildRecipeFingerprint(isolated, 'v2026.10.6')).not.toBe(before);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('verifies exact current source and production syntax while rejecting partial or historical capability', () => {
    const source = [schemas, manual, recovery, producer, forward, descriptors, policies].join('\n');
    const patched = transform(source);
    expect(transform(patched)).toBe(patched);
    const helperSource = [justDoCreateCompactionHandlers, justDoRunRecoveryCompaction]
      .map(fn => fn.toString())
      .join('\n');
    const bundled = transformSync(
      patched.replace(/import \{ [^}]+ \} from "[^"]+compaction-lifecycle.mjs";/g, '') +
        '\n' +
        helperSource,
      { target: 'node24', format: 'esm', minifySyntax: true, legalComments: 'none' },
    ).code;
    expect(transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    const renamed = bundled
      .replace('params.operationId ?? randomUUID()', 'params.operationId ?? randomUUID242()')
      .replace('{ randomUUID, assertValidParams', '{ randomUUID: randomUUID242, assertValidParams')
      .replaceAll('result.result.markerExpected', 'result3.result.markerExpected')
      .replaceAll('result.result.tokensBefore', 'result3.result.tokensBefore');
    expect(transform(renamed, 'gateway-bundle.mjs')).toBe(renamed);
    expect(() =>
      transform(
        renamed.replace('randomUUID: randomUUID242,', 'randomUUID: randomUUID243,'),
        'gateway-bundle.mjs',
      ),
    ).toThrow(/bindings/);
    expect(() =>
      transform(patched.replace(CONTRACT, 'JUSTDO_NATIVE_COMPACTION_LIFECYCLE_V2026_8_2')),
    ).toThrow(/historical/);
    expect(() => transform(patched.replace('signal?.throwIfAborted();', ''))).toThrow(/Partial/);
    expect(() =>
      transform(bundled.replace('capacity = 4096', 'capacity = 4095'), 'gateway-bundle.mjs'),
    ).toThrow(/partial/);
    expect(() =>
      transform(patched.replace(/import \{ justDoRunRecoveryCompaction \}[^;]+;/, '')),
    ).toThrow(/partial/);
    expect(() =>
      transform(patched.replace('required:true,readOnly:true', 'required:false,readOnly:true')),
    ).toThrow(/partial/);
  });

  it('preflights every native copy before writes and rejects a mixed partial runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-compaction-patch-'));
    try {
      const dist = path.join(root, 'dist');
      fs.mkdirSync(dist);
      const fixtures: Record<string, string> = {
        'embedded.mjs': recovery,
        'compact.mjs': producer,
        'delegate.mjs': forward,
        'delegate-second.mjs': forward,
        'schemas.mjs': schemas,
        'manual.mjs': manual,
        'core.mjs': descriptors,
        'relay.mjs': descriptors,
        'relay-second.mjs': descriptors,
        'policies.mjs': policies,
      };
      for (const [name, content] of Object.entries(fixtures))
        fs.writeFileSync(path.join(dist, name), content);
      fs.writeFileSync(
        path.join(dist, 'embedded.mjs'),
        recovery.replace('input.assertRecoveryActive()', 'input.untrusted()'),
      );
      expect(() => patch.applyPatch(root)).toThrow(/custody/);
      expect(fs.readFileSync(path.join(dist, 'schemas.mjs'), 'utf8')).toBe(schemas);
      fs.writeFileSync(path.join(dist, 'embedded.mjs'), recovery);
      expect(patch.applyPatch(root)).toHaveLength(10);
      expect(patch.applyPatch(root)).toEqual([]);
      expect(() => patch.verifyPatch(root)).not.toThrow();
      const support = path.join(dist, 'native-support/compaction-lifecycle.mjs');
      const baseline = fs.readFileSync(support, 'utf8');
      const bundle = path.join(root, 'gateway-bundle.mjs');
      const monolith = [schemas, manual, recovery, producer, forward, descriptors, policies].join('\n');
      const helperSource = [justDoCreateCompactionHandlers, justDoRunRecoveryCompaction].map(fn => fn.toString()).join('\n');
      const compiled = transformSync(transform(monolith).replace(/import \{ [^}]+ \} from "[^"]+compaction-lifecycle.mjs";/g, '') + '\n' + helperSource, { target: 'node24', minifySyntax: true, legalComments: 'none' }).code;
      fs.writeFileSync(bundle, compiled);
      expect(patch.verifyPatch(root)).toEqual([]);
      expect(patch.applyPatch(root)).toEqual([]);
      const current = Object.fromEntries(Object.keys(fixtures).map(name => [name, fs.readFileSync(path.join(dist, name), 'utf8')]));
      const snapshot = () => Object.fromEntries([...Object.keys(fixtures).map(name => path.join(dist, name)), bundle, support].filter(file => fs.existsSync(file)).map(file => [file, fs.readFileSync(file, 'utf8')]));
      const refused = () => {
        const before = snapshot();
        expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
        expect(snapshot()).toEqual(before);
      };
      fs.writeFileSync(bundle, monolith);
      refused();
      for (const [name, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(dist, name), content);
      fs.unlinkSync(support);
      fs.writeFileSync(bundle, compiled);
      refused();
      fs.writeFileSync(bundle, transformSync([transform(schemas), manual, recovery, producer, forward, descriptors, policies].join('\n'), { legalComments: 'none' }).code);
      refused();
      const schemaBoundary = schemas.indexOf('\n');
      const currentSchemas = transform(schemas, 'gateway-bundle.mjs');
      const currentBoundary = currentSchemas.indexOf('\n');
      for (const partialSchemas of [
        schemas.slice(0, schemaBoundary) + '\n' + currentSchemas.slice(currentBoundary + 1),
        currentSchemas.slice(0, currentBoundary) + '\n' + schemas.slice(schemaBoundary + 1),
      ]) {
        fs.writeFileSync(bundle, transformSync([partialSchemas, manual, recovery, producer, forward, descriptors, policies].join('\n'), { legalComments: 'none' }).code);
        refused();
      }
      for (const orphan of [justDoCreateCompactionHandlers, justDoRunRecoveryCompaction]) {
        fs.writeFileSync(bundle, transformSync(monolith + '\n' + orphan.toString(), { legalComments: 'none' }).code);
        refused();
      }
      fs.writeFileSync(bundle, monolith);
      fs.writeFileSync(support, baseline);
      refused();
      for (const [name, content] of Object.entries(current)) fs.writeFileSync(path.join(dist, name), content);
      fs.writeFileSync(bundle, compiled);
      fs.unlinkSync(support);
      refused();
      fs.writeFileSync(support, baseline);
      fs.writeFileSync(support, baseline.replace('capacity = 4096', 'capacity = 4095'));
      expect(() => patch.verifyPatch(root)).toThrow(/support/);
      fs.writeFileSync(support, '');
      expect(() => patch.applyPatch(root)).toThrow(/support/);
      fs.writeFileSync(support, baseline);
      fs.writeFileSync(path.join(dist, 'embedded.mjs'), recovery);
      expect(() => patch.applyPatch(root)).toThrow(/Mixed pristine/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
