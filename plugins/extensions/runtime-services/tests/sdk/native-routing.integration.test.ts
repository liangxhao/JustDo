import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import { createRuntimeServicesClient } from '../../sdk/native-client';
import { registerRuntimeServicesProvider, RUNTIME_SERVICES_BINDING_METHOD } from '../../sdk/provider';

const declaredSourceRoot = process.env.OPENCLAW_SOURCE_ROOT;
const sourceRoot = declaredSourceRoot ? realpathSync(declaredSourceRoot) : undefined;
if (sourceRoot) {
  const metadata = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (metadata.name !== 'openclaw' || !statSync(path.join(sourceRoot, 'src/plugins/registry.ts')).isFile())
    throw new Error('OPENCLAW_SOURCE_ROOT must identify the matching native source checkout.');
}

/**
 * Explicit source-conformance profile, not a listening Gateway or model test.
 * Private native imports assemble fixtures and observe the selected context only.
 * Production SDK/provider/client never import these helpers or private registries.
 * The registry, PluginInstance, public API/background runner, trusted request,
 * ownership checks, request authorization and in-process dispatcher are real.
 * Use native-routing.vitest.config.mts for source-package resolution. Optional
 * incomplete-dependency stubs throw if touched and are separately opted into.
 */
it.skipIf(!sourceRoot)('binds separate Native registrations to their own Gateway authority and synchronous read context', async () => {
  const native = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(sourceRoot!, file)).href);
  const [registryModule, runtimeMock, records, scopes, methodsModule, work, retirement, instances] = await Promise.all([
    native('src/plugins/registry.ts'),
    native('src/plugin-sdk/test-helpers/plugin-runtime-mock.ts'),
    native('src/plugins/status.test-helpers.ts'),
    native('src/plugins/runtime/gateway-request-scope.ts'),
    native('src/gateway/methods/registry.ts'),
    native('src/shared/async-work-scope.ts'),
    native('src/plugins/runtime.ts'),
    native('src/plugins/plugin-instance-scope.ts'),
  ]);
  const { dispatchTrustedPluginGatewayMethod } = await native('src/gateway/server-plugins.ts');
  const sharedStateDir = path.join(sourceRoot!, '.fixture-content-free-state');
  const sharedSource = path.join(sourceRoot!, '.fixture-plugin', 'index.ts');

  function gateway(label: 'A' | 'B') {
    const runtime = runtimeMock.createPluginRuntimeMock();
    runtime.state.resolveStateDir = () => sharedStateDir;
    let pausedReply: { reached(): void; wait: Promise<void> } | undefined;
    runtime.gateway.request = async (method: string, params: Record<string, unknown>, options: unknown) => {
      const value = await dispatchTrustedPluginGatewayMethod(method, params, options);
      if (method === RUNTIME_SERVICES_BINDING_METHOD && pausedReply) {
        const captured = pausedReply; pausedReply = undefined; captured.reached(); await captured.wait;
      }
      return value;
    };
    const registry = registryModule.createPluginRegistry({
      logger: { error() {}, warn() {}, info() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
      allowProcessHomeSessionCatalogs: true,
    });
    let consumer: Parameters<typeof createRuntimeServicesClient>[0] | undefined;
    let providerApi: Parameters<typeof registerRuntimeServicesProvider>[0] | undefined;
    const nativeInstances = new Map<string, { quiesce(): boolean; runCleanup<T>(run: () => T): T }>();
    const observations: unknown[] = [];
    let context: Record<string, unknown>;
    for (const id of ['runtime-services', 'fixture-consumer']) {
      const record = records.createPluginRecord({ id, origin: 'bundled', source: sharedSource });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });
      nativeInstances.set(id, instances.resolvePluginInstanceOwner(record, registry.registry).instance);
      if (id === 'runtime-services') {
        providerApi = api;
        registerRuntimeServicesProvider(api, {
          readExecutionAdmission() {
            const selectedContext = scopes.getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.() ??
              scopes.getPluginRuntimeGatewayRequestScope()?.context;
            observations.push(selectedContext);
            return selectedContext === context ? { state: 'clear', generation: label === 'A' ? 1 : 2 } : { state: 'unknown' };
          },
        });
      } else consumer = api;
    }
    const methods = methodsModule.createGatewayMethodRegistry(registry.registry.gatewayMethodDescriptors, registry.registry);
    context = {
      trackExecution: work.trackAsyncWork,
      dedupe: new Map(),
      getRuntimeConfig: () => ({}),
      getGatewayMethodRegistry: () => methods,
      logGateway: { error() {}, warn() {}, info() {}, debug() {} },
    };
    // Assembly seam equivalent to native loader binding; clients see only the API.
    scopes.bindGatewayContextResolver(runtime, () => context);
    return {
      context,
      observations,
      api: consumer!,
      providerApi: providerApi!,
      client: createRuntimeServicesClient(consumer!),
      source: registry.registry.plugins.map((record: { source: string }) => record.source),
      within<T>(run: () => T): T {
        return scopes.withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, run);
      },
      quiesce(target: 'consumer' | 'provider') {
        nativeInstances.get(target === 'consumer' ? 'fixture-consumer' : 'runtime-services')!.quiesce();
      },
      withinCleanup<T>(target: 'consumer' | 'provider', run: () => T): T {
        return nativeInstances.get(target === 'consumer' ? 'fixture-consumer' : 'runtime-services')!.runCleanup(run);
      },
      pauseReply() {
        let reached!: () => void; let release!: () => void;
        const arrived = new Promise<void>(resolve => { reached = resolve; });
        const wait = new Promise<void>(resolve => { release = resolve; });
        pausedReply = { reached, wait }; return { arrived, release };
      },
      close: () => retirement.disposePluginRegistryInstances(registry.registry),
    };
  }
  const a = gateway('A');
  const b = gateway('B');
  const c = gateway('A');
  const d = gateway('B');
  try {
    expect(a.api).not.toBe(b.api);
    expect(a.api.lifecycle.signal).not.toBe(b.api.lifecycle.signal);
    expect(a.source).toEqual(b.source);
    expect(a.source).toEqual([sharedSource, sharedSource]);
    expect((a.api.runtime as unknown as { state: { resolveStateDir(): string } }).state.resolveStateDir()).toBe(sharedStateDir);
    expect((b.api.runtime as unknown as { state: { resolveStateDir(): string } }).state.resolveStateDir()).toBe(sharedStateDir);
    // The caller's public background runner selects its own attached dispatcher,
    // even when the async handshake starts inside the other Gateway's request.
    expect(await b.within(() => a.client.bind())).toBe(true);
    expect(await a.within(() => b.client.bind())).toBe(true);
    const handleA = a.client.captureExecutionAdmission()!;
    const handleB = b.client.captureExecutionAdmission()!;
    const source = { sessionKey: 'agent:main:content-free', sessionId: 'native-fixture' };
    // The synchronous projection must also enter the provider's native context.
    // Removing its background runner would select B here and fail these checks.
    expect(b.within(() => handleA.readExecutionAdmission(source))).toEqual({ state: 'clear', generation: 1 });
    expect(a.within(() => handleB.readExecutionAdmission(source))).toEqual({ state: 'clear', generation: 2 });
    expect(a.observations).toEqual([a.context]);
    expect(b.observations).toEqual([b.context]);
    a.quiesce('consumer');
    expect(a.api.lifecycle.signal!.aborted).toBe(false);
    a.withinCleanup('consumer', () => {
      // The actual public runner permits already admitted cleanup; the captured
      // registration probe must independently test fresh ordinary admission.
      expect(a.api.lifecycle.runInBackgroundContext!(() => true)).toBe(true);
      expect(handleA.isCurrent()).toBe(false);
    });
    expect(handleA.readExecutionAdmission(source)).toEqual({ state: 'unknown' });
    expect(handleB.isCurrent()).toBe(true);
    expect(await c.client.bind()).toBe(true);
    const handleC = c.client.captureExecutionAdmission()!;
    c.quiesce('provider');
    expect(c.providerApi.lifecycle.signal!.aborted).toBe(false);
    expect(c.api.lifecycle.signal!.aborted).toBe(false);
    c.withinCleanup('provider', () => {
      expect(c.providerApi.lifecycle.runInBackgroundContext!(() => true)).toBe(true);
      expect(handleC.isCurrent()).toBe(false);
    });
    expect(handleC.readExecutionAdmission(source)).toEqual({ state: 'unknown' });
    const paused = d.pauseReply();
    const pending = d.client.bind(); await paused.arrived;
    d.quiesce('consumer'); expect(d.api.lifecycle.signal!.aborted).toBe(false);
    paused.release(); expect(await pending).toBe(false);
    expect(d.client.captureCapabilities()).toBeUndefined();
  } finally {
    await a.close();
    await b.close();
    await c.close();
    await d.close();
  }
});
