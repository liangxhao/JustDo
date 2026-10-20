// Real Registry + Electron SQLite, isolated from application and Gateway state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const useNode = process.argv.includes('--node');
const workspace = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), 'app-registry-scope-'));
let child;
try {
  const compiled = path.join(temporary, 'registry.cjs');
  await build({
    stdin: {
      contents: `export {AppPluginRegistry} from ${JSON.stringify(path.join(workspace, 'src/main/plugins/app/registry.ts'))};\nexport {AppPluginManager} from ${JSON.stringify(path.join(workspace, 'src/main/plugins/app/manager.ts'))};\nexport {AppSessionParticipants} from ${JSON.stringify(path.join(workspace, 'src/main/plugins/app/sessionParticipants.ts'))};\nexport {appendAppInput} from ${JSON.stringify(path.join(workspace, 'plugins/extensions/runtime-services/contracts/app-input.ts'))};\nexport {bindPluginGatewayClient} from ${JSON.stringify(path.join(workspace, 'src/main/engine/gateway/pluginRequestBinding.ts'))};`,
      resolveDir: workspace,
      loader: 'ts',
    },
    outfile: compiled,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const runner = path.join(temporary, 'scope-probe.cjs');
  await writeFile(
    runner,
    `
    const assert=require('node:assert/strict');
    const {AppPluginRegistry,AppPluginManager,AppSessionParticipants,appendAppInput,bindPluginGatewayClient}=require(${JSON.stringify(compiled)});
    const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const database=new Database(':memory:');
    const artifact={root:${JSON.stringify(temporary)},artifact:{hash:'a'.repeat(64),files:{},manifest:{id:'fixture',nativePluginId:'fixture',version:'1',entries:{main:'unused.mjs'},commands:['read'],capabilities:[],slots:[]}}};
    let enabled=true,host,event,resume,lateWrite,receipt,resumeSchema,schemaContinuation;
    const subscriptions=new Set(),events=[],requests=[],effects={create:0,prepare:0,stop:0,delete:0};
    const checks={};
    const binding={pluginId:'fixture',registrationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',processId:123,gatewayMethods:[]};
    const client=bindPluginGatewayClient({request:async(method,params,options)=>{requests.push({method,params,options});return{success:true};}});
    const registry=new AppPluginRegistry(()=>({enabled,confirmed:true,binding}));
    const execution={prepareSession:async()=>effects.prepare++,stopSession:async()=>effects.stop++,getSessionRuntimeStatus:async()=>({known:true,running:false}),onSessionDeleted:()=>{}};
    const resources={
      getDatabase:()=>database,getNativeStateDirectory:()=>${JSON.stringify(temporary)},
      getSessions:()=>({getSession:()=>({id:'source'}),createSession:()=>{effects.create++;return{id:'new'};},deleteSession:()=>effects.delete++}),
      getExecution:()=>execution,
      getRuntime:()=>({getGatewayClient:()=>client}),
      requestGateway:(...args)=>client.request(...args),requestConnectedGateway:(...args)=>client.request(...args),ensureReady:async()=>{},
      onNativeEvent:listener=>{subscriptions.add(listener);events.push(listener);return()=>subscriptions.delete(listener);},
      onSessionStopped:()=>()=>{},sessionsChanged:()=>{},
    };
    const deny=operation=>assert.throws(operation,/appPlugin/);
    const emit=payload=>{for(const listener of [...subscriptions])listener(payload);};
    const count=kind=>database.prepare('SELECT count(*) AS count FROM metadata WHERE kind=?').get(kind).count;
    const input=()=>({id:'fixture',epoch:registry.snapshot()[0].epoch,command:'read',args:[]});
    (async()=>{try{
      await registry.prepare(artifact,resources,async()=>({register(value){host=value;return{
        commands:[{id:'read',invoke:async()=>{lateWrite=host.getDatabase().prepare("INSERT INTO metadata VALUES ('late-business')");await new Promise(resolve=>resume=resolve);lateWrite.run();return{success:true};}}],
        schemas:[{id:'metadata',initialize(db){db.exec('CREATE TABLE metadata (kind TEXT NOT NULL)');
          schemaContinuation=new Promise(resolve=>resumeSchema=resolve).then(()=>db.exec("INSERT INTO metadata VALUES ('late-schema')")).then(()=>false,()=>true);
        }}],
        cleanupGatewayMethods:['fixture.cancel','fixture.cleanup'],
        activate(){host.onExecutionReceipt(value=>{receipt=value;host.getDatabase().prepare("INSERT INTO metadata VALUES ('receipt')").run();deny(()=>host.getSessions().createSession('receipt'));deny(()=>host.getExecution().stopSession('source'));deny(()=>host.requestGateway('fixture.cleanup',{}));});},
        onEnable(){event=()=>{host.getSessions().createSession('event');};return host.onNativeEvent(event);},
        beforeDisable:async()=>{host.getDatabase().prepare("INSERT INTO metadata VALUES ('cancel')").run();await host.requestGateway('fixture.cancel',{});return()=>{};},
        resources:{protectedResources:()=>['source'],expandResources:ids=>[...ids],acquireDeletion:()=>{host.getDatabase().prepare("INSERT INTO metadata VALUES ('lease')").run();return()=>host.getDatabase().prepare("DELETE FROM metadata WHERE kind='lease'").run();},isDeleting:()=>false,isManaged:()=>false,
          prepareDelete:async()=>{host.getDatabase().prepare("INSERT INTO metadata VALUES ('cleanup')").run();await host.getExecution().stopSession('source');await host.requestGateway('fixture.cleanup',{});deny(()=>host.getSessions().createSession('cleanup'));deny(()=>host.getExecution().prepareSession('source'));deny(()=>host.requestGateway('chat.send',{}));},deleteManaged:async()=>false},
      };}}));
      registry.initializeDatabase(database);registry.activate();
      assert.equal(registry.snapshot()[0].state,'active');
      const oldCallback=events.at(-1);
      const pending=registry.invoke(input());assert.equal(typeof resume,'function');
      await registry.mutate('fixture',false,async()=>{enabled=false;});
      assert.equal(count('cancel'),1);assert.equal(requests.at(-1).method,'fixture.cancel');checks.disabledCancel=true;
      oldCallback({event:'agent',payload:{}});assert.equal(effects.create,0);checks.disabledCallbackBlocked=true;
      deny(()=>host.getSessions().createSession('outside'));deny(()=>host.getExecution().prepareSession('source'));deny(()=>host.requestGateway('chat.send',{}));deny(()=>host.getRuntime().getGatewayClient().request('fixture.cleanup',{}));deny(()=>host.getDatabase().prepare("INSERT INTO metadata VALUES ('outside')").run());assert.equal(count('outside'),0);checks.noScopeBusinessAndWritesBlocked=true;
      assert.equal(host.getDatabase().prepare("SELECT count(*) AS count FROM metadata").get().count,1);checks.noScopeMetadataRead=true;
      emit({event:'agent',payload:{stream:'lifecycle',sessionKey:'native-key',runId:'run',sessionId:'sid',raw:'not allowed',data:{phase:'end',executionSettled:true,aborted:false,text:'not allowed'}}});
      assert.equal(count('receipt'),1);assert.deepEqual(receipt,{stream:'lifecycle',sessionKey:'native-key',runId:'run',sessionId:'sid',data:{phase:'end',executionSettled:true,aborted:false}});checks.disabledReceiptMetadataOnly=true;
      emit({event:'agent',payload:{stream:'lifecycle',sessionKey:'native-key',runId:'run',data:{phase:'end',executionSettled:false}}});assert.equal(count('receipt'),1);checks.unsettledReceiptIgnored=true;
      await registry.registrations()[0].resources.prepareDelete(['source']);assert.equal(count('cleanup'),1);assert.equal(effects.stop,1);assert.equal(requests.at(-1).method,'fixture.cleanup');checks.disabledResourceCleanup=true;
      const release=registry.registrations()[0].resources.acquireDeletion(['source']);
      try{release();checks.cleanupLeaseReleaseRetainsScope=count('lease')===0;}catch{checks.cleanupLeaseReleaseRetainsScope=false;}
      await registry.mutate('fixture',true,async()=>{enabled=true;});
      oldCallback({event:'agent',payload:{}});assert.equal(effects.create,0);checks.oldCallbackAfterReenableBlocked=true;
      resume();assert.equal((await pending).success,false);assert.equal(count('late-business'),0);checks.oldDatabaseBusinessWriteBlocked=true;
      resumeSchema();checks.expiredSchemaDatabaseWriteBlocked=await schemaContinuation && count('late-schema')===0;
      events.at(-1)({event:'ordinary',payload:{}});assert.equal(effects.create,1);checks.newCallbackStillWorks=true;
      assert.equal(effects.prepare,0);assert.equal(effects.delete,0);
      registry.dispose();
      class Resources{protectedResources(){return['source'];}expandResources(ids){return ids;}acquireDeletion(){return()=>{};}isDeleting(){return false;}isManaged(){return false;}async prepareDelete(){}async deleteManaged(){return false;}}
      class Submission{matches(){return true;}async register(){}async markSubmissionStarted(){}async cancel(){}async abortBeforeSend(){return true;}async releaseIfSettled(){return true;}}
      const prototypeRegistry=new AppPluginRegistry(()=>({enabled:true,confirmed:true,binding}));
      await prototypeRegistry.prepare(artifact,resources,async()=>({register:()=>({commands:[],resources:new Resources(),submission:new Submission()})}));
      const registration=prototypeRegistry.registrations()[0];
      checks.prototypeResourceMethodsPreserved=['protectedResources','expandResources','acquireDeletion','isDeleting','isManaged','prepareDelete','deleteManaged'].every(name=>typeof registration.resources[name]==='function');
      checks.prototypeSubmissionMethodsPreserved=['matches','register','markSubmissionStarted','cancel','abortBeforeSend','releaseIfSettled'].every(name=>typeof registration.submission[name]==='function');
      prototypeRegistry.dispose();
      let structuredEnabled=true,structuredInput;
      const structuredBinding={pluginId:'structured',registrationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',processId:234,gatewayMethods:[]};
      const structuredRegistry=new AppPluginRegistry(()=>({enabled:structuredEnabled,confirmed:true,binding:structuredBinding}));
      const structuredArtifact={...artifact,artifact:{...artifact.artifact,manifest:{...artifact.artifact.manifest,id:'structured',nativePluginId:'structured',commands:[]}}};
      await structuredRegistry.prepare(structuredArtifact,resources,async()=>({register:host=>({commands:[],submission:{
        matches:(_prompt,submission)=>submission?.input?.options?.count===2,
        register:async input=>{structuredInput=input.submission;host.getSessions().createSession('structured');await host.requestGateway('fixture.structured',{input:input.submission.input});},
        markSubmissionStarted:async()=>{host.getSessions().createSession('structured-start');},abortBeforeSend:async()=>true,cancel:async()=>{},releaseIfSettled:async()=>true,
      }})}));
      structuredRegistry.activate();
      const structuredParticipants=new AppSessionParticipants(structuredRegistry);
      const structuredEpoch=structuredRegistry.snapshot()[0].epoch;
      const data={options:{count:2},binding:{pluginId:'foreign',registrationId:'forged',processId:999}};
      const encoded=appendAppInput('visible',{v:1,pluginId:'structured',epoch:structuredEpoch,mode:'custom',prompt:'native request',input:data});
      checks.structuredInputAvailableToMatch=structuredParticipants.matches(encoded);
      const createsBefore=effects.create;
      await structuredParticipants.register({sessionId:'source',clientTurnId:'structured-turn',prompt:encoded});
      checks.structuredInputArrivesInBusinessScope=structuredInput.input.options.count===2&&effects.create===createsBefore+1;
      checks.structuredDataCannotChooseNativeOwner=requests.at(-1).method==='structured.app.dispatch'&&requests.at(-1).params.registrationId===structuredBinding.registrationId&&requests.at(-1).params.processId===structuredBinding.processId;
      await assert.rejects(structuredRegistry.registrations()[0].submission.register({sessionId:'source',clientTurnId:'outside',prompt:encoded,submission:structuredInput}));
      checks.structuredRegistrationOutsideScopeCannotEffect=effects.create===createsBefore+1;
      await assert.rejects(structuredParticipants.register({sessionId:'source',clientTurnId:'conflict',prompt:encoded,submission:{pluginId:'structured',epoch:'wrong',mode:'custom'}}));
      checks.structuredConflictingEnvelopeRejected=effects.create===createsBefore+1;
      const large=appendAppInput('visible',{v:1,pluginId:'structured',epoch:structuredEpoch,mode:'custom',prompt:'native request',input:{options:{count:2},large:'x'.repeat(1100000)}});
      await assert.rejects(structuredParticipants.register({sessionId:'source',clientTurnId:'large',prompt:large}));
      checks.structuredOversizedDataRejected=effects.create===createsBefore+1;
      await structuredRegistry.mutate('structured',false,async()=>{structuredEnabled=false;});
      await assert.rejects(structuredParticipants.markSubmissionStarted('source','structured-turn'));
      checks.structuredRetiredSubmissionCannotStart=effects.create===createsBefore+1;
      await structuredRegistry.mutate('structured',true,async()=>{structuredEnabled=true;});
      await assert.rejects(structuredParticipants.register({sessionId:'source',clientTurnId:'stale',prompt:encoded}));
      checks.structuredOldEnvelopeCannotBorrowNewEpoch=effects.create===createsBefore+1;
      structuredRegistry.dispose();
      const manager=new AppPluginManager({retentionRoot:${JSON.stringify(path.join(temporary, 'retained'))},resources,readDesiredEnabled:()=>false,
        candidates:async()=>[{trusted:true,cleanupOnly:true,root:${JSON.stringify(path.join(temporary, 'missing-artifact'))},nativeRoot:${JSON.stringify(temporary)}}],broadcast:()=>{},isGatewayConnected:()=>false});
      const originalWarning=console.warn;console.warn=()=>{};try{await manager.prepare();}finally{console.warn=originalWarning;}
      const bootstrapDatabase=new Database(':memory:');bootstrapDatabase.exec("CREATE TABLE old_plugin_metadata (resource_id TEXT);INSERT INTO old_plugin_metadata VALUES ('source')");
      manager.initializeDatabase(bootstrapDatabase);assert.equal(bootstrapDatabase.prepare('SELECT count(*) AS count FROM app_plugin_resources').get().count,0);
      deny(()=>manager.sessions.acquireDeletion(['source']));checks.brokenBootstrapFencesEmptyJournal=true;manager.dispose();bootstrapDatabase.close();
      const regularManager=new AppPluginManager({retentionRoot:${JSON.stringify(path.join(temporary, 'regular-retained'))},resources,readDesiredEnabled:()=>false,
        candidates:async()=>[{trusted:true,root:${JSON.stringify(path.join(temporary, 'missing-regular-artifact'))},nativeRoot:${JSON.stringify(temporary)}}],broadcast:()=>{},isGatewayConnected:()=>false});
      console.warn=()=>{};try{await regularManager.prepare();}finally{console.warn=originalWarning;}
      const regularDatabase=new Database(':memory:');regularDatabase.exec("CREATE TABLE old_plugin_metadata (resource_id TEXT);INSERT INTO old_plugin_metadata VALUES ('source')");
      regularManager.initializeDatabase(regularDatabase);
      try{regularManager.sessions.acquireDeletion(['source'])();checks.brokenRegularCandidateFencesEmptyJournal=false;}catch{checks.brokenRegularCandidateFencesEmptyJournal=true;}
      regularManager.dispose();regularDatabase.close();
      let schemaUnhandled=false;const observeUnhandled=()=>{schemaUnhandled=true;};process.on('unhandledRejection',observeUnhandled);
      const asynchronousSchema=new AppPluginRegistry(()=>({enabled:true,confirmed:true,binding}));const schemaDatabase=new Database(':memory:');
      try{
        await asynchronousSchema.prepare(artifact,resources,async()=>({register:()=>({commands:[],schemas:[{id:'invalid.async',async initialize(db){await 0;db.exec('CREATE TABLE unexpected_write (id TEXT)');}}]})}));
        asynchronousSchema.initializeDatabase(schemaDatabase);await new Promise(resolve=>setImmediate(resolve));
        checks.invalidAsyncSchemaFailureIsolated=!schemaUnhandled&&asynchronousSchema.snapshot()[0].state==='blocked';
      }finally{process.off('unhandledRejection',observeUnhandled);asynchronousSchema.dispose();schemaDatabase.close();}
      let eventUnhandled=false,resumeEvent,eventCallback,eventEnabled=true;
      const observeEventUnhandled=()=>{eventUnhandled=true;};process.on('unhandledRejection',observeEventUnhandled);
      const asynchronousEvent=new AppPluginRegistry(()=>({enabled:eventEnabled,confirmed:true,binding}));
      try{
        await asynchronousEvent.prepare(artifact,{...resources,onNativeEvent:callback=>{eventCallback=callback;return()=>{};}},async()=>({register:host=>({commands:[],onEnable:()=>host.onNativeEvent(async()=>{await new Promise(resolve=>resumeEvent=resolve);host.getSessions().createSession('late-event');})})}));
        asynchronousEvent.activate();const createBefore=effects.create;eventCallback({event:'ordinary',payload:{}});
        await asynchronousEvent.mutate('fixture',false,async()=>{eventEnabled=false;});resumeEvent();await new Promise(resolve=>setImmediate(resolve));
        checks.asyncStaleEventFailureIsolated=!eventUnhandled&&effects.create===createBefore;
      }finally{process.off('unhandledRejection',observeEventUnhandled);asynchronousEvent.dispose();}
      let receiptUnhandled=false,resumeReceipt,receiptCallback;
      const observeReceiptUnhandled=()=>{receiptUnhandled=true;};process.on('unhandledRejection',observeReceiptUnhandled);
      const asynchronousReceipt=new AppPluginRegistry(()=>({enabled:false,confirmed:true,binding}));
      try{
        await asynchronousReceipt.prepare(artifact,{...resources,onNativeEvent:callback=>{receiptCallback=callback;return()=>{};}},async()=>({register:host=>({commands:[],activate:()=>{host.onExecutionReceipt(async()=>{await new Promise(resolve=>resumeReceipt=resolve);host.getDatabase().prepare("INSERT INTO metadata VALUES ('late-receipt')").run();});}})}));
        asynchronousReceipt.activate();receiptCallback({event:'agent',payload:{stream:'lifecycle',sessionKey:'native-key',runId:'run',data:{phase:'end',executionSettled:true}}});
        asynchronousReceipt.dispose();resumeReceipt();await new Promise(resolve=>setImmediate(resolve));
        checks.retiredAsyncReceiptFailureIsolated=!receiptUnhandled&&count('late-receipt')===0;
      }finally{process.off('unhandledRejection',observeReceiptUnhandled);asynchronousReceipt.dispose();}
      let stoppedCallback;
      const stoppedRegistry=new AppPluginRegistry(()=>({enabled:false,confirmed:true,binding}));
      await stoppedRegistry.prepare(artifact,{...resources,onSessionStopped:callback=>{stoppedCallback=callback;return()=>{};}},async()=>({register:host=>({commands:[],activate:()=>{host.onSessionStopped(()=>{});}})}));
      stoppedRegistry.activate();stoppedRegistry.dispose();
      try{stoppedCallback('source');checks.disposedStopObserverIgnored=true;}catch{checks.disposedStopObserverIgnored=false;}
      const cancellations=[];
      const participants=new AppSessionParticipants({registrations:()=>[
        {submission:{cancel:async()=>{cancellations.push('first');throw new Error('unresolved');}}},
        {submission:{cancel:async()=>{cancellations.push('second');}}},
      ]});
      await assert.rejects(participants.cancel('source'));
      checks.everyStopParticipantAttempted=cancellations.join(',')==='first,second';
      const synchronousCancellations=[];
      const synchronousParticipants=new AppSessionParticipants({registrations:()=>[
        {submission:{cancel:()=>{synchronousCancellations.push('first');throw new Error('synchronous unresolved');}}},
        {submission:{cancel:async()=>{synchronousCancellations.push('second');}}},
      ]});
      await assert.rejects(synchronousParticipants.cancel('source'));
      checks.synchronousStopFailureStillAttemptsOtherParticipants=synchronousCancellations.join(',')==='first,second';
      console.log(JSON.stringify({realRegistry:true,realElectronSqlite:Boolean(process.versions.electron),realSqlite:true,checks}));
      assert.ok(Object.values(checks).every(Boolean),'All scoped lifecycle controls must pass');
    }finally{registry.dispose();database.close();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
  `,
  );
  child = spawn(useNode ? process.execPath : require('electron'), [runner], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => {
    output += bytes;
  });
  child.stderr.on('data', bytes => {
    output += bytes;
  });
  const timeout = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(timeout);
  assert.equal(code, 0, output);
  process.stdout.write(output);
} finally {
  child?.kill();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-registry-scope-'));
  await rm(temporary, { recursive: true, force: true });
}
