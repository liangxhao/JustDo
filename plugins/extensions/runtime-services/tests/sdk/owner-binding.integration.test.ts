import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it, vi } from 'vitest';

import { createOwnerClient } from '../../sdk/owner-client';
import { OWNER_BINDING_METHOD } from '../../sdk/owner-contract';
import { registerOwnerProvider } from '../../sdk/owner-provider';

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
it.skipIf(!sourceRoot)('proves writer ownership through real Native descriptors and separate Gateway lifecycles', async () => {
  const native = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(sourceRoot!, file)).href);
  const [registryModule,runtimeMock,records,scopes,methodsModule,work,retirement,dispatcher,instances] = await Promise.all([
    native('src/plugins/registry.ts'),native('src/plugin-sdk/test-helpers/plugin-runtime-mock.ts'),
    native('src/plugins/status.test-helpers.ts'),native('src/plugins/runtime/gateway-request-scope.ts'),
    native('src/gateway/methods/registry.ts'),native('src/shared/async-work-scope.ts'),
    native('src/plugins/runtime.ts'),native('src/gateway/server-plugins.ts'),native('src/plugins/plugin-instance-scope.ts'),
  ]);
  function gateway(candidateUnpublished = false) {
    const runtime=runtimeMock.createPluginRuntimeMock();
    const bindings: Record<string, unknown>[]=[];
    let pause: { reached():void; wait:Promise<void> }|undefined;
    runtime.gateway.request=async (method:string,params:Record<string,unknown>,options:unknown)=>{
      if(method===OWNER_BINDING_METHOD)bindings.push({...params});
      const value=await dispatcher.dispatchTrustedPluginGatewayMethod(method,params,options);
      if(method.startsWith('runtimeServices.ownerProof.')&&pause){const captured=pause;pause=undefined;captured.reached();await captured.wait;}
      return value;
    };
    const registry=registryModule.createPluginRegistry({logger:{error(){},warn(){},info(){},debug(){}},runtime,activateGlobalSideEffects:false,allowProcessHomeSessionCatalogs:true});
    let consumer!: Parameters<typeof createOwnerClient>[0];
    let providerApi!: Parameters<typeof registerOwnerProvider>[0];
    let provider!: ReturnType<typeof registerOwnerProvider>;
    const nativeInstances=new Map<string,{quiesce():boolean;runCleanup<T>(run:()=>T):T}>();
    for(const id of ['runtime-services','example-consumer']){
      const record=records.createPluginRecord({id,origin:'bundled',source:path.join(sourceRoot!,'.fixture','same-entry.ts')});
      registry.registry.plugins.push(record);
      const api=registry.createApi(record,{config:{}});
      nativeInstances.set(id,instances.resolvePluginInstanceOwner(record,registry.registry).instance);
      if(id==='runtime-services'){providerApi=api;provider=registerOwnerProvider(api);}else consumer=api;
    }
    // A consumer publishes its proof method during native registration, before the registry view is sealed.
    const client=createOwnerClient(consumer);
    const forged=createOwnerClient({...consumer,id:'wrong-owner'});
    let methods=methodsModule.createGatewayMethodRegistry(
      registry.registry.gatewayMethodDescriptors.filter((descriptor: { name: string }) =>
        !candidateUnpublished || !descriptor.name.startsWith('runtimeServices.ownerProof.')),
      registry.registry,
    );
    const context={trackExecution:work.trackAsyncWork,dedupe:new Map(),getRuntimeConfig:()=>({}),getGatewayMethodRegistry:()=>methods,logGateway:{error(){},warn(){},info(){},debug(){}}};
    scopes.bindGatewayContextResolver(runtime,()=>context);
    return {client,forged,provider,consumer,providerApi,bindings,
      publishCandidate(){methods=methodsModule.createGatewayMethodRegistry(registry.registry.gatewayMethodDescriptors,registry.registry);},
      quiesce(target:'consumer'|'provider'){nativeInstances.get(target==='consumer'?'example-consumer':'runtime-services')!.quiesce();},
      cleanup<T>(target:'consumer'|'provider',run:()=>T):T{return nativeInstances.get(target==='consumer'?'example-consumer':'runtime-services')!.runCleanup(run);},
      pauseProof(){let reached!:()=>void;let release!:()=>void;const arrived=new Promise<void>(resolve=>{reached=resolve;});const wait=new Promise<void>(resolve=>{release=resolve;});pause={reached,wait};return {arrived,release};},
      within<T>(run:()=>T):T{return scopes.withPluginRuntimeGatewayRequestScope({context,isWebchatConnect:()=>false},run);},close:()=>retirement.disposePluginRegistryInstances(registry.registry)};
  }
  const a=gateway();const b=gateway();const c=gateway();const d=gateway();const candidate=gateway(true);
  try{
    // A hot candidate's service starts before the attached Gateway method table
    // publishes its proof RPC. Only published business requests may bind it.
    expect(await candidate.client.ensureBound()).toBe(false);
    expect(candidate.client.captureLease()).toBeUndefined();
    candidate.publishCandidate();
    expect(await candidate.client.ensureBound()).toBe(true);
    const fresh=candidate.client.captureLease()!;
    candidate.quiesce('consumer');
    expect(fresh.isCurrent()).toBe(false);
    expect(await candidate.client.ensureBound()).toBe(false);
    expect(await b.within(()=>a.client.bind())).toBe(true);
    expect(await a.within(()=>b.client.bind())).toBe(true);
    const old=a.client.captureLease()!;const other=b.client.captureLease()!;
    expect(a.provider.resolve(old.token)?.pluginId).toBe('example-consumer');
    expect(b.provider.resolve(old.token)).toBeUndefined();
    expect(a.provider.resolve(other.token)).toBeUndefined();
    expect(await a.forged.bind()).toBe(false);
    await expect(a.consumer.lifecycle.runInBackgroundContext!(()=>a.consumer.runtime.gateway.request(OWNER_BINDING_METHOD,a.bindings[0],{scopes:['operator.read']}))).rejects.toThrow();
    expect(old.isCurrent()).toBe(true);
    const retired=vi.fn();old.onRetire(retired);
    expect(await a.client.bind()).toBe(true);
    expect(old.isCurrent()).toBe(false);expect(retired).toHaveBeenCalledOnce();
    // Native deliberately admits host cleanup while ordinary registration calls
    // are quiesced. The writer probe must use its captured registration context,
    // not borrow that future ambient cleanup admission.
    for(const [fixture,target] of [[c,'consumer'],[d,'provider']] as const){
      expect(await fixture.client.bind()).toBe(true);
      const captured=fixture.client.captureLease()!;const revoke=vi.fn();captured.onRetire(revoke);
      fixture.cleanup(target,()=>{
        fixture.quiesce(target);
        const api=target==='consumer'?fixture.consumer:fixture.providerApi;
        expect(api.lifecycle.signal!.aborted).toBe(false);
        expect(api.lifecycle.runInBackgroundContext!(()=>true)).toBe(true);
        expect(fixture.provider.resolve(captured.token)).toBeUndefined();
        expect(captured.isCurrent()).toBe(false);expect(revoke).toHaveBeenCalledOnce();
      });
      expect(await fixture.client.bind()).toBe(false);
    }
    const current=a.client.captureLease()!;
    const paused=a.pauseProof();const late=a.client.bind();await paused.arrived;
    const closing=a.close();paused.release();expect(await late).toBe(false);await closing;
    expect(current.isCurrent()).toBe(false);expect(a.provider.resolve(current.token)).toBeUndefined();
    expect(other.isCurrent()).toBe(true);
    await b.close();expect(other.isCurrent()).toBe(false);
  }finally{await a.close();await b.close();await c.close();await d.close();await candidate.close();}
});
