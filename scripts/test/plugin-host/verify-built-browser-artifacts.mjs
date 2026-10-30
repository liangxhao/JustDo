// Load real separately built companions through the real BrowserRegistry in hidden Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';
import { discoverAppPluginSources } from './source-discovery.mjs';

const require = createRequire(import.meta.url);
const sourceRoot =
  process.env.APP_PLUGIN_PROBE_SOURCE_ROOT ?? path.join(process.cwd(), 'plugins/extensions');
const rewritten = process.env.APP_PLUGIN_PROBE_REWRITE === '1';
const temporary = await mkdtemp(path.join(tmpdir(), 'app-built-browser-'));
let child;
try {
  const artifacts = [];
  for (const source of await discoverAppPluginSources(sourceRoot)) {
    const artifact = await buildAppPlugin(
      source.directory,
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
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {createPortal,flushSync} from 'react-dom';
import {AppBrowserRegistry} from ${JSON.stringify(path.resolve('src/renderer/features/plugins/app/browserRegistry.ts'))};
import {appJsxRuntime} from ${JSON.stringify(path.resolve('src/renderer/features/plugins/app/jsxRuntime.ts'))};
import {pluginMessageText} from ${JSON.stringify(path.resolve('src/renderer/features/plugins/app/messagePresentation.ts'))};
import {i18nService} from ${JSON.stringify(path.resolve('src/renderer/services/i18n.ts'))};
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
 const views=registry.getViews(),modes=registry.getModes();
 for(const owner of admitted){if(owner.slots.length&&!views.some(view=>view.pluginId===owner.id)&&!modes.some(mode=>mode.pluginId===owner.id))throw new Error('Declared Browser contributions did not load: '+owner.id);}
 const root=createRoot(document.getElementById('root'));
 if(${JSON.stringify(rewritten)}){const rewrites=views.filter(view=>view.id==='rewrite-check');if(rewrites.length!==admitted.length)throw new Error('Rewritten Browser declarations missing');flushSync(()=>root.render(React.createElement(React.Fragment,null,...rewrites.map(view=>React.createElement(view.component,{key:view.pluginId})))));for(const owner of admitted)if(!document.body.textContent.includes('plugin-only-ui-'+owner.id))throw new Error('Rewritten Browser view missing: '+owner.id);}
 const observers=()=>registry.getViews().filter(view=>view.slot==='application.page').map(view=>React.createElement(view.component,{key:view.pluginId+':'+view.epoch+':'+view.id,active:true}));
 flushSync(()=>root.render(React.createElement(React.Fragment,null,...observers())));await wait(200);
 const ordinary='Ordinary visible user text';if(pluginMessageText(ordinary)!==ordinary)throw new Error('Ordinary text changed');
 flushSync(()=>root.render(null));
 await registry.update(admitted.map(item=>({...item,state:'cleanup',browserEntry:undefined})));
 const disabledContributionsWithdrawn=registry.getViews().length===0&&registry.getModes().length===0;
 if(!disabledContributionsWithdrawn)throw new Error('Disabled Browser contributions remain');
 const renewed=admitted.map(item=>({...item,epoch:'reenabled',browserEntry:item.browserEntry.replace('/probe/','/reenabled/')}));
 await registry.update(renewed);
 for(const owner of renewed){if(owner.slots.length&&!registry.getViews().some(view=>view.pluginId===owner.id)&&!registry.getModes().some(mode=>mode.pluginId===owner.id))throw new Error('Reenabled Browser contributions missing: '+owner.id);}
 await registry.update([]);
 const uninstalledContributionsWithdrawn=registry.getViews().length===0&&registry.getModes().length===0;
 root.unmount();registry.dispose();
 window.probe.finish({actualShippedBrowserArtifacts:true,realBrowserRegistry:true,realChromium:true,loadedPlugins:admitted.map(item=>item.id),emptyOptionalInventory:admitted.length===0,registeredViews:views.length,registeredModes:modes.length,rendererNodeUnavailable:typeof window.require==='undefined'&&typeof window.process==='undefined',disabledContributionsWithdrawn,uninstalledContributionsWithdrawn,errors,keyWarnings});
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
ipcMain.once('probe:result',async(event,result)=>{try{assert.equal(event.sender,window.webContents);console.log(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.deepEqual(result.keyWarnings,[]);for(const check of ['rendererNodeUnavailable','disabledContributionsWithdrawn','uninstalledContributionsWithdrawn'])assert.equal(result[check],true,check);clearTimeout(timeout);window.destroy();server.close(()=>app.exit(0));}catch(error){console.error(error.stack);app.exit(1);}});
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
