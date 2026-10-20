// Build real shipped companions and load their retained Main entries in Electron.
// The disposable database has only product infrastructure; plugin schemas remain real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';
import { buildAppSdk } from '../../plugins/build-app-sdk.mjs';

const require = createRequire(import.meta.url);
const useNode = process.argv.includes('--node');
const workspace = process.cwd();
const sourceRoot =
  process.env.APP_PLUGIN_PROBE_SOURCE_ROOT ?? path.join(workspace, 'plugins/extensions');
const rewritten = process.env.APP_PLUGIN_PROBE_REWRITE === '1';
const temporary = await mkdtemp(path.join(tmpdir(), 'app-built-artifacts-'));
let child;
try {
  await buildAppSdk(path.join(temporary, 'sdk'));
  const artifacts = [];
  for (const id of ['agent-team', 'swarm-workflow']) {
    artifacts.push(
      await buildAppPlugin(path.join(sourceRoot, id), path.join(temporary, 'artifacts')),
    );
  }
  const runtimeRoot = path.join(temporary, '原生 runtime');
  for (const artifact of artifacts)
    await cp(artifact.packageRoot, path.join(runtimeRoot, 'dist/extensions', artifact.id), {
      recursive: true,
    });
  const runtimeAlias = path.join(temporary, 'current');
  await symlink(runtimeRoot, runtimeAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(
    path.join(temporary, 'artifacts/catalog.json'),
    JSON.stringify(artifacts.map(({ id, hash }) => ({ id, hash }))),
  );
  const compiled = path.join(temporary, 'host.cjs');
  await build({
    stdin: {
      contents: `export {inspectAppArtifact,retainAppArtifact} from ${JSON.stringify(path.join(workspace, 'src/main/plugins/app/artifact.ts'))};\nexport {AppPluginRegistry} from ${JSON.stringify(path.join(workspace, 'src/main/plugins/app/registry.ts'))};\nexport {AppPluginManager,discoverAppCandidates} from ${JSON.stringify(path.join(workspace, 'src/main/plugins/app/manager.ts'))};`,
      resolveDir: workspace,
      loader: 'ts',
    },
    outfile: compiled,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const runner = path.join(temporary, 'load.cjs');
  await writeFile(
    runner,
    `
const assert=require('node:assert/strict');
const {inspectAppArtifact,retainAppArtifact,AppPluginRegistry,AppPluginManager,discoverAppCandidates}=require(${JSON.stringify(compiled)});
const {readFileSync,realpathSync}=require('node:fs');
const path=require('node:path');
const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});
const database=new Database(':memory:');
database.exec("CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY,title TEXT,updated_at INTEGER); CREATE TABLE agents (id TEXT PRIMARY KEY,name TEXT)");
const source='11111111-1111-4111-8111-111111111111';
const key='agent:main:justdo:'+source;
const session={id:source,title:'Fixture',agentId:'main',cwd:${JSON.stringify(temporary)},executionMode:'local',permissionMode:'ask'};
let enabled=false;
const registry=new AppPluginRegistry(id=>({enabled,confirmed:true,binding:{pluginId:id,registrationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',processId:123,gatewayMethods:[]}}));
const calls=[];
const request=async(method,params)=>{calls.push({method,params});if(method==='swarmWorkflow.list')return{flows:[]};if(method==='swarmWorkflow.summary')return{count:0,running:false};if(method==='swarmWorkflow.activity')return{parentKeys:[],snapshot:'fixture:1'};throw new Error('unexpected synthetic Gateway request: '+method);};
const nativeClient={request};
const runtime={captureGatewayResponseContext:()=>({isCurrent:()=>true}),getGatewayClient:()=>nativeClient,getSessionKeysForSession:()=>[key],getPlanMode:async()=>({enabled:false}),getGoalExecution:()=>null};
const execution={getSessionRuntimeStatus:async()=>({known:true,running:false,mainRunning:false,subagentRunning:false}),stopSession:async()=>{},onSessionDeleted:()=>{}};
const resources={getDatabase:()=>database,getNativeStateDirectory:()=>${JSON.stringify(path.join(temporary, 'state'))},
getSessions:()=>({getSession:id=>id===source?session:null,getSessionByNativeKey:input=>input===key?session:null,getAgent:()=>null,listAgents:()=>[],getSessionRuns:()=>[],getSessionRunByClientTurnId:()=>null,getGoalExecutionSnapshot:()=>null,listPlanHandoffs:()=>[]}),
getExecution:()=>execution,
getRuntime:()=>runtime,requestGateway:request,requestConnectedGateway:request,ensureReady:async()=>{},onNativeEvent:()=>()=>{},onSessionStopped:()=>()=>{},sessionsChanged:()=>{},createAssistant:async()=>{throw new Error('not exercised');}};
const checks={};
(async()=>{try{
const handshakes=new Map();
for(const artifact of ${JSON.stringify(artifacts)}){
 const binding=JSON.parse(readFileSync(path.join(artifact.root,'native.binding.json'),'utf8'));
 handshakes.set(artifact.id+'.app.handshake',{pluginId:artifact.id,registrationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',processId:123,gatewayMethods:[],nativeEntry:realpathSync(path.join(${JSON.stringify(runtimeAlias)},'dist/extensions',artifact.id,'index.js')),sourceSha256:binding.sha256});
}
const manager=new AppPluginManager({
 retentionRoot:${JSON.stringify(path.join(temporary, 'manager-retained'))},
 candidates:()=>discoverAppCandidates(${JSON.stringify(path.join(temporary, 'artifacts'))},${JSON.stringify(runtimeAlias)},[],{}),
 resources:{...resources,requestConnectedGateway:async method=>handshakes.get(method)},
 readDesiredEnabled:()=>true,isGatewayConnected:()=>true,getGatewayProcessId:()=>123,broadcast:()=>{}
});
try{
 await manager.prepare();manager.initializeDatabase(database);await manager.activate();await manager.refresh();
 assert.equal(manager.snapshot().length,2);
 assert.ok(manager.snapshot().every(item=>item.state==='active'&&item.browserEntry),JSON.stringify(manager.snapshot()));
 const team=manager.snapshot().find(item=>item.id==='agent-team');
 assert.ok(team.slots.includes('plugin.settings')&&team.slots.includes('plugin.history'));
 assert.equal((await manager.invoke({id:'agent-team',epoch:team.epoch,command:'settings.read',args:[]})).success,true);
 checks['actualManager:currentRuntimeJunctionAdmitted']=true;
 checks['actualManager:teamSettingsAndHistoryPublished']=true;
}finally{manager.dispose();}
for(const artifact of ${JSON.stringify(artifacts)}){
 const inspected=await inspectAppArtifact(artifact.root);
 const retained=await retainAppArtifact(inspected,${JSON.stringify(path.join(temporary, 'retained'))});
 await registry.prepare(retained,resources);
 checks[artifact.id+':actualGraphAndMainLoaded']=true;
}
registry.initializeDatabase(database);registry.activate();
assert.ok(registry.snapshot().every(item=>item.state==='cleanup'));
enabled=true;registry.refresh();
assert.ok(registry.snapshot().every(item=>item.state==='active'),JSON.stringify(registry.snapshot()));
const invoke=(id,command,args=[])=>registry.invoke({id,command,args,epoch:registry.snapshot().find(item=>item.id===id).epoch});
if(${JSON.stringify(rewritten)}){
 for(const id of ['agent-team','swarm-workflow'])assert.deepEqual(await invoke(id,'rewrite.check'),{success:true,owner:id,marker:'plugin-only-rewrite'});
 checks['rewritten:bothMainDeclarationsExecuted']=true;
}
assert.deepEqual(await invoke('agent-team','collaboration.list'),{success:true,value:[]});
assert.deepEqual(await invoke('agent-team','discussion.list'),{success:true,value:[]});
const initialSettings=await invoke('agent-team','settings.read');
assert.equal(initialSettings.success,true);
if(${JSON.stringify(rewritten)}){assert.equal(initialSettings.value.value.collaboration.messageBudget,13);checks['rewritten:teamOwnSettingsChanged']=true;}
const changedSettings=structuredClone(initialSettings.value.value);changedSettings.collaboration.messageBudget=15;
const saved=await invoke('agent-team','settings.save',[{value:changedSettings,expectedRevision:initialSettings.value.revision}]);
assert.equal(saved.success,true,JSON.stringify(saved));assert.equal(saved.value.value.collaboration.messageBudget,15);
checks['agent-team:realCommandsAndSchemas']=true;
const workflow=await invoke('swarm-workflow','workflow.list',[source]);
assert.deepEqual(workflow,{success:true,flows:[]});
assert.deepEqual(await invoke('swarm-workflow','workflow.summary',[source]),{success:true,count:0,running:false});
assert.deepEqual(await invoke('swarm-workflow','workflow.activity'),{success:true,sessionIds:[]});
checks['swarm-workflow:realCommandLoaded']=true;
checks['swarm-workflow:compactQueriesAndLiveIdentity']=true;
const beforeDisable=registry.snapshot().find(item=>item.id==='agent-team').epoch;
enabled=false;registry.refresh();
assert.equal((await invoke('agent-team','settings.read')).success,false);
enabled=true;registry.refresh();
assert.equal((await registry.invoke({id:'agent-team',command:'settings.read',args:[],epoch:beforeDisable})).success,false);
assert.equal((await invoke('agent-team','settings.read')).value.value.collaboration.messageBudget,15);
checks['agent-team:retainedMetadataAndRetiredEpoch']=true;
console.log(JSON.stringify({actualShippedArtifacts:true,realElectronMain:Boolean(process.versions.electron),realNodeMain:true,checks}));
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
  assert.ok(path.basename(temporary).startsWith('app-built-artifacts-'));
  await rm(temporary, { recursive: true, force: true });
}
