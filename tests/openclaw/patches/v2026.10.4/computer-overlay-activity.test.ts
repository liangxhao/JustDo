import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { computerOverlayInvoke } = require('../../../../scripts/patches/v2026.10.4/computer-overlay-activity.js');
const { transformService, transformHandler, transformGuard, SERVICE, HANDLER, GUARD } = require('../../../../scripts/patches/v2026.10.4/023-computer-overlay-activity.cjs').__testing;
const { applyPatch, verifyPatch } = require('../../../../scripts/patches/v2026.10.4/023-computer-overlay-activity.cjs');
const service = `function createGatewayComputerService(options) {
  const execution = { settled: options.settled, physicalId: randomUUID(), releaseOwner() {} };
  return { async invoke(request) {
    request.assertCurrent();
    if (execution.settled.has(request.idempotencyKey)) throw new Error('settled');
    const result = child.invoke({command: request.command, params: {...request.params, executionId: execution.physicalId},
      signal: request.signal, timeoutMs: request.timeoutMs,
      assertCurrent: () => { assertRuntime(runtime); request.assertCurrent(); }});
    return await result;
  }};
}`;
const handler = `const computerHandlers = { "computer.invoke": async (options) => {
  const {params, context} = options;
  const service = context.gatewayComputerService;
  const caller = resolveComputerCaller(options);
  caller.assertCurrent();
  return await service.invoke({...params, ...caller});
}};`;
const guard = `const EVENT_SCOPE_GUARDS = { "chat": ["operator.read"] }; function hasEventScope() {}`;

function invokeFor(platform: string) {
  const native = vm.runInNewContext(`(${computerOverlayInvoke.toString()})`, {
    process: { platform }, setInterval, clearInterval,
  }) as (request: object, desktop: string, invoke: () => Promise<unknown>, id: string, execution: object) => Promise<unknown>;
  return (request: object, desktop: string, invoke: () => Promise<unknown>, id: string, execution = { releaseOwner() {} }) => native(request, desktop, invoke, id, execution);
}

describe('native computer presentation observer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps one presentation identity across actions and closes it on native release', async () => {
    const onComputerActivity = vi.fn();
    const releaseOwner = vi.fn();
    const execution = { releaseOwner };
    const request = { command: 'screen.snapshot', params: {}, onComputerActivity };
    await invokeFor('win32')(request, 'native', async () => 'one', 'first', execution);
    await invokeFor('win32')(request, 'native', async () => 'two', 'second', execution);
    expect(onComputerActivity.mock.calls.every(([event]) => event.execution === 'first')).toBe(true);
    execution.releaseOwner();
    expect(releaseOwner).toHaveBeenCalledOnce();
    expect(onComputerActivity).toHaveBeenLastCalledWith({ v: 2, id: 'first', execution: 'first', phase: 'close', cursor: false, click: false });
  });

  it('owner cancellation fences heartbeats and late completion without changing the native result', async () => {
    const owner = new AbortController();
    const onComputerActivity = vi.fn();
    const execution = { releaseOwner: vi.fn() };
    let finish!: (result: string) => void;
    const pending = invokeFor('win32')({ command: 'screen.snapshot', params: {}, ownerSignal: owner.signal, onComputerActivity },
      'native', () => new Promise<string>(resolve => { finish = resolve; }), 'id', execution);
    owner.abort();
    expect(onComputerActivity.mock.calls.map(([event]) => event.phase)).toEqual(['start', 'close']);
    vi.advanceTimersByTime(10_000);
    finish('exact-result');
    expect(await pending).toBe('exact-result');
    execution.releaseOwner();
    expect(onComputerActivity).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['type', 'key'])('does not pretend %s occurs under the physical mouse', async action => {
    const onComputerActivity = vi.fn();
    await invokeFor('win32')({ command: 'computer.act', params: { action }, onComputerActivity }, 'native', async () => ({}), 'id');
    expect(onComputerActivity.mock.calls.every(([event]) => !event.cursor)).toBe(true);
  });

  it('publishes only closed metadata and preserves the exact native result', async () => {
    const onComputerActivity = vi.fn();
    const request = { command: 'computer.act', params: { action: 'left_click', text: 'secret', x: 73 }, onComputerActivity };
    const result = { ok: true, details: { scope: 'desktop' } };
    expect(await invokeFor('win32')(request, 'native', async () => result, 'id')).toBe(result);
    expect(onComputerActivity.mock.calls.map(([value]) => value)).toEqual([
      { v: 2, id: 'id', execution: 'id', phase: 'start', cursor: true, click: false },
      { v: 2, id: 'id', execution: 'id', phase: 'end', cursor: true, click: true },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['linux', 'darwin'])('does not present an unsupported %s desktop', async platform => {
    const onComputerActivity = vi.fn();
    const invoke = vi.fn(async () => 'unchanged');
    expect(await invokeFor(platform)({ params: {}, onComputerActivity }, 'native', invoke, 'id')).toBe('unchanged');
    expect(onComputerActivity).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('does not present a managed virtual desktop', async () => {
    const onComputerActivity = vi.fn();
    await invokeFor('win32')({ params: {}, onComputerActivity }, 'managed', async () => 'ok', 'id');
    expect(onComputerActivity).not.toHaveBeenCalled();
  });

  it.each([{ windowRef: 'w' }, { elementRef: 'e' }, { browserRef: 'b' }])('keeps scoped background operations free of a fake cursor: %j', async target => {
    const onComputerActivity = vi.fn();
    await invokeFor('win32')({ command: 'computer.act', params: { action: 'left_click', ...target }, onComputerActivity },
      'native', async () => ({ ok: true, details: { scope: 'desktop' } }), 'id');
    expect(onComputerActivity.mock.calls.every(([event]) => !event.cursor && !event.click)).toBe(true);
  });

  it.each([
    { ok: false, details: { scope: 'desktop' } },
    { ok: true, details: { scope: 'window' } },
    { ok: true, details: { scope: 'desktop' }, effect: 'suspected_noop' },
    { ok: true, details: { scope: 'desktop' }, escalation: { required: true } },
    null,
    'unknown',
  ])('does not confirm failed, uncertain or scoped native results: %j', async result => {
    const onComputerActivity = vi.fn();
    const request = { command: 'computer.act', params: { action: 'left_click' }, onComputerActivity };
    expect(await invokeFor('win32')(request, 'native', async () => result, 'id')).toBe(result);
    expect(onComputerActivity).toHaveBeenLastCalledWith({ v: 2, id: 'id', execution: 'id', phase: 'end', cursor: true, click: false });
  });

  it('renews in-flight presentation and always clears its timer on failure', async () => {
    const onComputerActivity = vi.fn();
    let reject!: (error: Error) => void;
    const failure = new Error('native refusal');
    const native = new Promise((_resolve, fail) => { reject = fail; });
    const pending = invokeFor('win32')({ command: 'screen.snapshot', params: {}, onComputerActivity }, 'native', () => native, 'id');
    vi.advanceTimersByTime(10_000);
    expect(onComputerActivity).toHaveBeenCalledTimes(3);
    reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(onComputerActivity).toHaveBeenLastCalledWith({ v: 2, id: 'id', execution: 'id', phase: 'end', cursor: false, click: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot change input execution when the UI broadcaster throws', async () => {
    const invoke = vi.fn(async () => ({ native: true }));
    const request = { command: 'screen.snapshot', params: {}, onComputerActivity: () => { throw new Error('UI gone'); } };
    await expect(invokeFor('win32')(request, 'native', invoke, 'id')).resolves.toEqual({ native: true });
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('computer activity patch boundaries', () => {
  it('keeps owner/admission checks before observation and forwards only the native callback', async () => {
    const published: unknown[] = [];
    const child = { invoke: vi.fn(async () => 'result') };
    const context = vm.createContext({
      process: { platform: 'win32' }, setInterval, clearInterval, child,
      runtime: { desktopTarget: 'native' }, execution: { settled: new Set(), physicalId: 'physical' },
      assertRuntime: vi.fn(), randomUUID: () => 'uuid',
      resolveComputerCaller: () => ({ assertCurrent() {} }),
    });
    vm.runInContext(transformService(service) + '\nconst service = createGatewayComputerService({settled: execution.settled});\n' + transformHandler(handler), context);
    await vm.runInContext('computerHandlers["computer.invoke"]', context)({
      params: { command: 'screen.snapshot', params: { text: 'private' }, idempotencyKey: 'one' },
      context: { gatewayComputerService: vm.runInContext('service', context), broadcast: (...args: unknown[]) => published.push(args) },
    });
    expect(child.invoke).toHaveBeenCalledOnce();
    expect(published).toHaveLength(2);
    expect(JSON.stringify(published)).not.toMatch(/private|physical|idempotencyKey/);
    vm.runInContext('execution.settled.add("one")', context);
    await expect(vm.runInContext('service.invoke({idempotencyKey:"one", assertCurrent(){}})', context)).rejects.toThrow('settled');
    expect(published).toHaveLength(2);
  });

  it.each([[transformService, service, SERVICE], [transformHandler, handler, HANDLER], [transformGuard, guard, GUARD]])('accepts only the current exact patch and its compiled form', (transform, original, marker) => {
    const patched = transform(original, 'native.mjs');
    expect(transform(patched, 'native.mjs')).toBe(patched);
    const compiled = transformSync(patched, { minifySyntax: true, legalComments: 'none' }).code;
    expect(transform(compiled, 'gateway-bundle.mjs')).toBe(compiled);
    expect(() => transform(patched.replace(marker, marker.replace('10_4', '9_8')), 'native.mjs')).toThrow();
    expect(() => transform(patched.replace(`// ${marker}\n`, ''), 'native.mjs')).toThrow();
    expect(() => transform(`// ${marker}\n${original}`, 'native.mjs')).toThrow();
  });

  it('admits the display event only to administrative operators', () => {
    const permissions = vm.runInNewContext(transformGuard(guard) + '; EVENT_SCOPE_GUARDS');
    expect(permissions['computer.activity']).toEqual(['operator.admin']);
    expect(permissions.chat).toEqual(['operator.read']);
    expect(() => transformGuard(transformGuard(guard).replace('["operator.admin"]', '["operator.read"]'))).toThrow();
  });

  it('preserves the identifiers renamed by the Gateway bundler and lazy recovery initializer', () => {
    const renamedService = service.replace(/\brequest\b/g, 'request5').replace(/\brandomUUID\b/g, 'randomUUID177');
    const renamedHandler = handler.replace(/\bcontext\b/g, 'context8').replace(/\bparams\b/g, 'params3').replace('{params3, context8}', '{params: params3, context: context8}').replace(/\bcaller\b/g, 'caller2').replace('const computerHandlers', 'computerHandlers');
    const patchedService = transformService(renamedService, 'gateway-bundle.mjs');
    const patchedHandler = transformHandler(renamedHandler, 'gateway-bundle.mjs');
    expect(patchedService).toContain('computerOverlayInvoke(request5, runtime.desktopTarget');
    expect(patchedService).toContain('randomUUID177()');
    expect(patchedHandler).toContain('options.context.broadcast');
    expect(patchedHandler).toContain('...params3, ...caller2');
    expect(transformService(transformSync(patchedService, { minifySyntax: true, legalComments: 'none' }).code, 'gateway-bundle.mjs')).toBeTruthy();
    expect(transformHandler(transformSync(patchedHandler, { minifySyntax: true, legalComments: 'none' }).code, 'gateway-bundle.mjs')).toBeTruthy();
    expect(() => transformService(patchedService.replace('5_000', '7_000'), 'gateway-bundle.mjs')).toThrow();
    expect(() => transformHandler(patchedHandler.replace('computer.activity', 'other.activity'), 'gateway-bundle.mjs')).toThrow();
  });

  it('keeps the executable bundle shebang at byte zero', () => {
    let source = '#!/usr/bin/env node\n' + service + '\n' + handler + '\n' + guard;
    for (const transform of [transformService, transformHandler, transformGuard]) source = transform(source, 'gateway-bundle.mjs');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(() => transformSync(source, { format: 'esm' })).not.toThrow();
  });

  it.each([false, true])('patches shared native modules and the optional bundle (bundle=%s)', bundle => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-overlay-topology-'));
    try {
      fs.mkdirSync(path.join(root, 'dist', 'worker'), { recursive: true });
      const monolith = service + '\n' + handler + '\n' + guard;
      const worker = transformSync(monolith, { minifyIdentifiers: true, minifySyntax: true, minifyWhitespace: true }).code;
      const files = {
        'dist/computer-service.mjs': service,
        'dist/computer.mjs': handler,
        'dist/server-start.mjs': guard,
        ...(bundle ? { 'gateway-bundle.mjs': '#!/usr/bin/env node\n' + monolith } : {}),
      };
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
      expect(applyPatch(root)).toHaveLength(Object.keys(files).length);
      expect(() => verifyPatch(root)).not.toThrow();
      expect(applyPatch(root)).toEqual([]);
      for (const [name, marker] of [
        ['computer-service.mjs', SERVICE], ['computer.mjs', HANDLER], ['server-start.mjs', GUARD],
      ]) {
        const patched = fs.readFileSync(path.join(root, 'dist', name), 'utf8');
        expect(patched).toContain(marker);
      }
      fs.writeFileSync(path.join(root, 'dist', 'unexpected-service.mjs'), service);
      expect(() => verifyPatch(root)).toThrow(/topology changed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not capture a minified caller that shadows the handler context', async () => {
    const shadowed = `const computerHandlers = { "computer.invoke": async Ot => {
      const { params: Kt, context: _n } = Ot;
      const Dn = _n.gatewayComputerService;
      return (async () => {
        const _n = resolveComputerCaller(Ot);
        _n.assertCurrent();
        return await Dn.invoke({ ...Kt, ..._n });
      })();
    }};`;
    const broadcast = vi.fn();
    const gatewayComputerService = { invoke: async (request: { onComputerActivity: (event: object) => void }) => request.onComputerActivity({ v: 1 }) };
    const invoke = vm.runInNewContext(transformHandler(shadowed) + '; computerHandlers["computer.invoke"]', {
      resolveComputerCaller: () => ({ assertCurrent() {} }),
    });
    await invoke({ params: {}, context: { broadcast, gatewayComputerService } });
    expect(broadcast).toHaveBeenCalledWith('computer.activity', { v: 1 }, { dropIfSlow: true });
  });

  it('refuses mixed sub-capabilities or bundle states before any writes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-overlay-mixed-'));
    const files = ['dist/service.mjs', 'dist/handler.mjs', 'dist/guard.mjs', 'gateway-bundle.mjs'];
    const originals = [service, handler, guard];
    const transforms = [transformService, transformHandler, transformGuard];
    try {
      fs.mkdirSync(path.join(root, 'dist'));
      for (const [nativeStates, bundleStates] of [[[true, true, true], [false, false, false]], [[false, false, false], [true, true, true]], [[true, false, false], [false, false, false]], [[false, false, false], [false, true, false]]] as const) {
        files.forEach((file, i) => fs.writeFileSync(path.join(root, file), i < 3
          ? (nativeStates[i] ? transforms[i](originals[i], file) : originals[i])
          : transformSync(originals.map((value, j) => bundleStates[j] ? transforms[j](value, file) : value).join('\n'), { minifySyntax: true, legalComments: 'none' }).code));
        const before = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
        expect(() => applyPatch(root)).toThrow(/Mixed/);
        expect(files.map(file => fs.readFileSync(path.join(root, file), 'utf8'))).toEqual(before);
      }
      files.forEach((file, i) => fs.writeFileSync(path.join(root, file), i < 3 ? transforms[i](originals[i], file) : transformSync(originals.map((value, j) => transforms[j](value, file)).join('\n'), { minifySyntax: true, legalComments: 'none' }).code));
      expect(verifyPatch(root)).toEqual([]);
      expect(applyPatch(root)).toEqual([]);
      files.forEach((file, i) => fs.writeFileSync(path.join(root, file), i < 3 ? originals[i] : [service, handler, guard.replace('EVENT_SCOPE_GUARDS', 'CHANGED_GUARDS')].join('\n')));
      const before = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
      expect(() => applyPatch(root)).toThrow();
      expect(files.map(file => fs.readFileSync(path.join(root, file), 'utf8'))).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
