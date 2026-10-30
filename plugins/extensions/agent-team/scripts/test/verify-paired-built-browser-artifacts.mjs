import probePaths from '../probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
import { pathToFileURL } from 'node:url';
// Load real separately built companions through the real BrowserRegistry in hidden Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { build } = hostRequire("esbuild");

const { buildAppPlugin } = await import(pathToFileURL(path.join(hostRoot, 'scripts/plugins/build-app-plugins.mjs')).href);

const require = hostRequire;
const sourceRoot =
  process.env.APP_PLUGIN_PROBE_SOURCE_ROOT ?? (() => { throw new Error('Set APP_PLUGIN_PROBE_SOURCE_ROOT for this paired integration probe.'); })();
const rewritten = process.env.APP_PLUGIN_PROBE_REWRITE === '1';
const temporary = await mkdtemp(path.join(tmpdir(), 'app-built-browser-'));
let child;
try {
  const artifacts = [];
  for (const id of ['agent-team', 'swarm-workflow']) {
    const artifact = await buildAppPlugin(
      path.join(sourceRoot, id),
      path.join(temporary, 'artifacts'),
    );
    const index = JSON.parse(await readFile(path.join(artifact.root, 'app.artifact.json'), 'utf8'));
    artifacts.push({ ...artifact, manifest: index.manifest });
  }
  const snapshots = artifacts.map(({ id, hash, manifest }) => ({
    ...manifest,
    id,
    hash,
    epoch: 'probe',
    state: 'active',
    installed: true,
    browserEntry: `/assets/app-plugins/${hash}/probe/${manifest.entries.browser}`,
    ...(manifest.entries.presentation
      ? { presentationEntry: `/assets/app-plugins/${hash}/presentation/${manifest.entries.presentation}` }
      : {}),
  }));
  const harness = path.join(temporary, 'harness.mjs');
  await build({
    stdin: {
      resolveDir: hostRoot,
      loader: 'tsx',
      contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {createPortal,flushSync} from 'react-dom';
import {AppBrowserRegistry} from ${JSON.stringify(path.resolve(hostRoot, 'src/renderer/features/plugins/app/browserRegistry.ts'))};
import {appJsxRuntime} from ${JSON.stringify(path.resolve(hostRoot, 'src/renderer/features/plugins/app/jsxRuntime.ts'))};
import {pluginMessageText} from ${JSON.stringify(path.resolve(hostRoot, 'src/renderer/features/plugins/app/messagePresentation.ts'))};
import {i18nService} from ${JSON.stringify(path.resolve(hostRoot, 'src/renderer/services/i18n.ts'))};
import {appendAgentTeamInstruction} from ${JSON.stringify(path.resolve(sourceRoot,'agent-team/prompt/agentTeamPrompt.ts'))};
import {buildSwarmWorkflowInstruction} from ${JSON.stringify(path.resolve(sourceRoot,'swarm-workflow/prompt/request.ts'))};
const errors=[],keyWarnings=[];window.addEventListener('error',event=>errors.push(event.message));window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));const reportError=console.error.bind(console);console.error=(...args)=>{if(args.some(value=>typeof value==='string'&&value.includes('Each child in a list')))keyWarnings.push(args.map(String).join(' '));reportError(...args);};
const Empty=()=>null;const session={id:'source',title:'Fixture',cwd:'',agentId:'main',status:'idle'};const snapshot={agent:{agents:[]},cowork:{sessions:[],currentSession:session,sessionRunTimings:{},pendingInteractions:[],draftPrompts:{},draftMessageQuotes:{},sessionRuntimeActivity:{}}};
const sessionListeners=new Set(),eventListeners=new Set();let collaborations=[],discussions=[],flows=[],activitySessions=[],activityReadFails=false,teamListFails=false;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(predicate,label)=>{const deadline=performance.now()+5000;while(!predicate()){if(performance.now()>deadline)throw new Error(label);await wait(10);}};
i18nService.setLanguage('en',{persist:false});
const ui={i18n:i18nService,Modal:({children})=>React.createElement('div',{'data-modal':true},children),useOwnerDocument:()=>document,useOwnerWindow:()=>window};
globalThis[Symbol.for('app-plugin.browser-runtime.v1')]={React,createPortal,flushSync,...appJsxRuntime,services:{ui,primitives:new Proxy({},{get:()=>Empty}),rendering:{toSanitizedMarkdownHtml:text=>text,normalizeMessage:()=>({role:'user',timestamp:0,content:[]})},composerStyles:{COMPOSER_FRAME_CLASS:'',COMPOSER_SURFACE_CLASS:'',COMPOSER_TEXTAREA_CLASS:'',COMPOSER_TEXTAREA_MAX_HEIGHT:240,COMPOSER_TEXTAREA_MIN_HEIGHT:40,resizeComposerTextarea(){}}}};
const settings={version:1,revision:0,value:{collaboration:{maxMembers:12,messageBudget:16},discussion:{maxMembers:6,defaultRounds:2,maxRounds:4,maxTurns:null,maxConcurrent:null,organizerParticipates:false}}};
const registry=new AppBrowserRegistry({snapshot:async()=>[],onChanged:()=>()=>{},onEvent:listener=>{eventListeners.add(listener);return()=>eventListeners.delete(listener);},invoke:async input=> input.command==='settings.read'?{success:true,value:settings}:input.command==='workflow.list'?{success:true,flows}:input.command==='workflow.summary'?{success:true,count:flows.length,running:flows.some(flow=>flow.state==='running')}:input.command==='workflow.activity'?(activityReadFails?{success:false}:{success:true,sessionIds:activitySessions}):input.command==='collaboration.list'?(teamListFails?{success:false}:{success:true,value:collaborations}):input.command==='discussion.list'?(teamListFails?{success:false}:{success:true,value:discussions}):{success:true,value:[]}},
{t:key=>i18nService.t(key),translations:(id,value)=>i18nService.registerPluginTranslations(id,value),components:{},renderHistory:()=>null,application:{metadata:{getSnapshot:()=>snapshot,subscribe:()=>()=>{}},sessions:{onChanged:listener=>{sessionListeners.add(listener);return()=>sessionListeners.delete(listener);},getDetails:async()=>({session:null}),loadSession:async()=>null},drafts:{addQuote(){},setPrompt(){}},files:{selectDirectory:async()=>({success:true,path:null}),selectFiles:async()=>({success:true,paths:[]}),readFileAsDataUrl:async()=>({success:false})},stageAudio:async()=>({success:false})}});
try{
 const admitted=${JSON.stringify(snapshots)};await registry.update(admitted);
 const legacyTeam=appendAgentTeamInstruction('Visible Team user text','task');const legacyWorkflow='Visible Workflow user text'+String.fromCharCode(10,10)+buildSwarmWorkflowInstruction({mode:'auto',verify:true});
 const pureModules=await Promise.all(admitted.map(item=>import(item.presentationEntry)));
 const pureLabels=admitted.map((item,index)=>({key:item.id==='agent-team'?'teamTitle':'swarmWorkflowTitle',value:pureModules[index].presentation.translations.en[item.id==='agent-team'?'teamTitle':'swarmWorkflowTitle']}));
 const pureHistory=()=>pluginMessageText(legacyTeam)==='Visible Team user text'&&pluginMessageText(legacyWorkflow)==='Visible Workflow user text';
 const pureTranslations=()=>pureLabels.every(({key,value})=>typeof value==='string'&&value!==key&&i18nService.t(key)===value);
 if(!pureHistory()||!pureTranslations())throw new Error('Built pure history or actual translations were not registered');
 const views=registry.getViews();const modes=registry.getModes();
 const team=views.find(item=>item.pluginId==='agent-team'&&item.slot==='plugin.settings');
 const workflow=views.find(item=>item.pluginId==='swarm-workflow'&&item.id==='workflow'&&item.slot==='workspace.tab');
 if(!team||!workflow)throw new Error('Actual browser contributions were not registered');
 const rewrites=views.filter(view=>view.id==='rewrite-check');
 if(${JSON.stringify(rewritten)}&&rewrites.length!==2)throw new Error('Rewritten contributions missing');
 const root=createRoot(document.getElementById('root'));const observers=()=>registry.getViews().filter(view=>view.slot==='application.page').map(view=>React.createElement(view.component,{key:view.pluginId+':'+view.epoch+':'+view.id,active:true}));
 flushSync(()=>root.render(React.createElement(React.Fragment,null,...observers())));await wait(200);
 if(registry.sessionPresentation('source').summaryAvailable||registry.getWorkspaceRequests().length)throw new Error('Empty plugin metadata opened a summary or workspace');
 collaborations=[{id:'task-room',anchorSessionId:'source',members:[]}];sessionListeners.forEach(listener=>listener());
 await until(()=>registry.getWorkspaceRequests().some(request=>request.pluginId==='agent-team'&&request.sessionId==='source'&&request.selection===undefined),'First collaboration did not open Team');
 const taskRequest=registry.getWorkspaceRequests().find(request=>request.pluginId==='agent-team');registry.acknowledgeWorkspaceRequest(taskRequest);
 await until(()=>registry.sessionPresentation('source').summaryAvailable===true,'Team did not advertise closed summary content');
 discussions=[{id:'group-room',sourceSessionId:'source',members:[]}];sessionListeners.forEach(listener=>listener());
 await until(()=>registry.getWorkspaceRequests().some(request=>request.selection?.key==='group:group-room'),'First discussion did not open its Team record');
 registry.getWorkspaceRequests().forEach(request=>registry.acknowledgeWorkspaceRequest(request));
 sessionListeners.forEach(listener=>listener());await wait(100);const dismissedTeamNotReopened=registry.getWorkspaceRequests().length===0;
 collaborations=[];discussions=[];sessionListeners.forEach(listener=>listener());await until(()=>registry.sessionPresentation('source').summaryAvailable!==true,'Removed Team content retained its summary hint');
 flows=[{id:'flow',revision:1,goal:'Fixture flow',createdAt:1,status:'running',nodes:[{id:'stage-a',title:'Fixture stage A',kind:'work',status:'done',deps:[],sessionKey:'fixture:stage-a'},{id:'stage-b',title:'Fixture stage B',kind:'work',status:'queued',deps:['stage-a'],sessionKey:'fixture:stage-b'}]}];const workflowSnapshot=admitted.find(item=>item.id==='swarm-workflow');eventListeners.forEach(listener=>listener({id:workflowSnapshot.id,hash:workflowSnapshot.hash,epoch:workflowSnapshot.epoch,name:'changed',payload:{sessionId:'source',flowId:'flow',revision:1}}));
 await until(()=>registry.sessionPresentation('source').summaryAvailable===true,'Closed Workflow summary did not observe its real metadata event');const closedSummaryDiscovered=true;
 flushSync(()=>root.render(React.createElement(React.Fragment,null,...observers(),React.createElement(team.component,{onClose(){}}),React.createElement(workflow.component,{session}),...rewrites.map(view=>React.createElement(view.component,{key:view.pluginId})))));await wait(200);
 const workflowRendered=()=>document.querySelector('.swarm-panel nav button[aria-pressed="true"]')?.textContent.includes('Fixture flow')&&document.querySelector('.swarm-panel svg[role="group"] [role="button"][aria-label^="Fixture stage A:"]')&&document.querySelector('.swarm-panel svg[role="group"] [role="button"][aria-label^="Fixture stage B:"]')&&document.querySelectorAll('.swarm-panel .swarm-workflow-edge').length===1;await until(workflowRendered,'Workflow flow, stages or dependency edge did not render');
 const result={actualShippedBrowserArtifacts:true,realBrowserRegistry:true,realChromium:true,pureHistoryRegistered:pureHistory(),pureTranslationsRegistered:pureTranslations(),registeredViews:views.length,registeredModes:modes.length,applicationObserversMounted:observers().length>=3,teamSettingsRendered:document.querySelectorAll('select').length>0,workflowRendered:!!workflowRendered(),firstTeamRecordsOpened:true,dismissedTeamNotReopened,closedSummaryDiscovered,rendererNodeUnavailable:typeof window.require==='undefined'&&typeof window.process==='undefined',rewrittenViewsRendered:!${JSON.stringify(rewritten)}||['agent-team','swarm-workflow'].every(id=>document.body.textContent.includes('plugin-only-ui-'+id)),errors};
 collaborations=[{id:'active-task',anchorSessionId:'source',members:[{sessionId:'peer',agentId:'reviewer',sessionKey:'agent:reviewer:justdo:peer'}]}];snapshot.cowork.sessionRuntimeActivity={peer:true};sessionListeners.forEach(listener=>listener());await until(()=>registry.sessionPresentation('source').status==='running','Team activity was not published');activitySessions=['workflow-source'];eventListeners.forEach(listener=>listener({id:workflowSnapshot.id,hash:workflowSnapshot.hash,epoch:workflowSnapshot.epoch,name:'changed',payload:{sessionId:'source',flowId:'flow',revision:2}}));await until(()=>registry.sessionPresentation('workflow-source').status==='running','Native activity was not published');
 flushSync(()=>root.render(null));await registry.update(admitted.map(item=>({...item,state:'cleanup',browserEntry:undefined})));result.disabledActivityRetained=registry.sessionPresentation('workflow-source').status==='running';result.disabledTeamActivityRetained=registry.sessionPresentation('source').status==='running';result.disabledContributionsWithdrawn=registry.getViews().length===0&&registry.getModes().length===0&&!registry.sessionPresentation('source').summaryAvailable&&sessionListeners.size===0&&eventListeners.size===0;result.disabledPureHistoryRetained=pureHistory();result.disabledPureTranslationsRetained=pureTranslations();
 activityReadFails=true;teamListFails=true;collaborations=[{id:'existing-task',anchorSessionId:'source',members:[]}];discussions=[{id:'existing-group',sourceSessionId:'source',members:[]}];const renewed=admitted.map(item=>({...item,epoch:'reenabled',browserEntry:item.browserEntry.replace('/probe/','/reenabled/')}));await registry.update(renewed);flushSync(()=>root.render(React.createElement(React.Fragment,null,...observers())));await until(()=>registry.sessionPresentation('source').summaryAvailable===true,'Renewed observers did not restore summary metadata');await wait(100);result.reenabledHistoryDidNotOpenWorkspace=registry.getWorkspaceRequests().length===0;result.failedActivityReadRetained=registry.sessionPresentation('workflow-source').status==='running';result.failedTeamReadRetained=registry.sessionPresentation('source').status==='running';activityReadFails=false;activitySessions=[];const currentWorkflow=renewed.find(item=>item.id==='swarm-workflow');eventListeners.forEach(listener=>listener({id:currentWorkflow.id,hash:currentWorkflow.hash,epoch:currentWorkflow.epoch,name:'changed',payload:{sessionId:'source',flowId:'flow',revision:3}}));await until(()=>registry.sessionPresentation('workflow-source').status!=='running','Confirmed complete idle snapshot did not clear activity');result.confirmedIdleCleared=true;teamListFails=false;collaborations=[];discussions=[];snapshot.cowork.sessionRuntimeActivity={};sessionListeners.forEach(listener=>listener());await until(()=>registry.sessionPresentation('source').status!=='running','Confirmed Team metadata did not clear retained activity');result.confirmedTeamIdleCleared=true;
 flushSync(()=>root.render(null));await registry.update([]);result.uninstalledPureHistoryWithdrawn=pluginMessageText(legacyTeam)===legacyTeam&&pluginMessageText(legacyWorkflow)===legacyWorkflow;result.uninstalledPureTranslationsWithdrawn=pureLabels.every(({key})=>i18nService.t(key)===key);root.unmount();registry.dispose();window.probe.finish({...result,keyWarnings});
}catch(error){window.probe.finish({errors:[String(error),...errors]});}
`,
    },
    outfile: harness,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    loader: { '.md': 'text' },
    logLevel: 'silent',
  });
  const preload = path.join(temporary, 'preload.cjs');
  await writeFile(
    preload,
    "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{finish:result=>ipcRenderer.send('probe:result',result)});\n",
  );
  const runner = path.join(temporary, 'browser.cjs');
  const routes = Object.fromEntries(
    artifacts.flatMap(artifact =>
      [...['probe', 'reenabled'].map(epoch => [
        `/assets/app-plugins/${artifact.hash}/${epoch}/${artifact.manifest.entries.browser}`,
        path.join(artifact.root, artifact.manifest.entries.browser),
      ]), ...(artifact.manifest.entries.presentation ? [[
        `/assets/app-plugins/${artifact.hash}/presentation/${artifact.manifest.entries.presentation}`,
        path.join(artifact.root, artifact.manifest.entries.presentation),
      ]] : [])],
    ),
  );
  await writeFile(
    runner,
    `
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs');const{app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(temporary, 'userdata'))});app.disableHardwareAcceleration();let server,window;const timeout=setTimeout(()=>app.exit(1),30000);
(async()=>{await app.whenReady();const routes=${JSON.stringify(routes)};server=http.createServer((request,response)=>{if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><div id="root"></div><script type="module" src="/harness.mjs"></script>');return;}const file=request.url==='/harness.mjs'?${JSON.stringify(harness)}:routes[request.url];if(!file){response.writeHead(404);response.end();return;}response.setHeader('Content-Type','text/javascript');response.end(fs.readFileSync(file));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
ipcMain.once('probe:result',async(event,result)=>{try{assert.equal(event.sender,window.webContents);console.log(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.deepEqual(result.keyWarnings,[]);for(const check of ['teamSettingsRendered','workflowRendered','rendererNodeUnavailable','rewrittenViewsRendered','applicationObserversMounted','firstTeamRecordsOpened','dismissedTeamNotReopened','closedSummaryDiscovered','disabledContributionsWithdrawn','reenabledHistoryDidNotOpenWorkspace','disabledActivityRetained','failedActivityReadRetained','confirmedIdleCleared','disabledTeamActivityRetained','failedTeamReadRetained','confirmedTeamIdleCleared','pureHistoryRegistered','pureTranslationsRegistered','disabledPureHistoryRetained','disabledPureTranslationsRetained','uninstalledPureHistoryWithdrawn','uninstalledPureTranslationsWithdrawn'])assert.equal(result[check],true,check);clearTimeout(timeout);window.destroy();server.close(()=>app.exit(0));}catch(error){console.error(error.stack);app.exit(1);}});
window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},nodeIntegration:false,contextIsolation:true,sandbox:true}});await window.loadURL('http://127.0.0.1:'+server.address().port+'/');})().catch(error=>{console.error(error.stack);app.exit(1);});
`,
  );
  const electronEnvironment = { ...process.env };
  delete electronEnvironment.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [runner], {
    windowsHide: true,
    env: electronEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => {
    output += bytes;
  });
  child.stderr.on('data', bytes => {
    output += bytes;
  });
  const timeout = setTimeout(() => child.kill(), 40000);
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
  assert.ok(path.basename(temporary).startsWith('app-built-browser-'));
  await rm(temporary, { recursive: true, force: true });
}
