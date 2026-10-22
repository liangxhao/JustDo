const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
(async () => {
  const root = path.resolve(__dirname, '../../..'),
    target = path.join(root, '.tmp/team-feature-ui');
  fs.mkdirSync(target, { recursive: true });
  await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {buildAgentTeamFeature} from './src/renderer/features/cowork/components/composer/AgentTeamSelector';import ComposerFeatureMenu from './src/renderer/features/cowork/components/composer/ComposerFeatureMenu';import {buildComposerFeatures} from './src/renderer/features/cowork/components/composer/composerFeatures';import {buildSwarmWorkflowComposerFeature} from './src/renderer/features/cowork/components/composer/swarmWorkflowComposerFeature';import FeatureTextarea from './src/renderer/features/cowork/components/composer/draft/FeatureTextarea';function Demo(){const [mode,setMode]=React.useState();const [text,setText]=React.useState('请组织助手评审这个方案');const items=buildComposerFeatures([{id:'attachments',label:'文件和文件夹',icon:<span/>,onSelect:()=>{},section:'添加'}, {...buildSwarmWorkflowComposerFeature({selectSwarmWorkflow:()=>setMode(undefined)}),section:'插件'}, {...buildAgentTeamFeature(mode,setMode),section:'插件'}],{loaded:true,enabled:new Map([['agent-team',true],['swarm-workflow',true]]),disabledRevisions:new Map()});return <main className="flex h-full items-end p-4"><div className="w-full rounded-xl border border-border bg-surface p-3"><FeatureTextarea value={text} onChange={e=>setText(e.target.value)} featureLabel={mode?'Agent Team · '+(mode==='group'?'群组讨论':'任务协作'):undefined} removeLabel="移除模式" onRemoveFeature={()=>setMode(undefined)} className="h-24 w-full resize-none bg-transparent p-2 text-sm leading-6"/><div className="flex items-center gap-2"><ComposerFeatureMenu items={items} label="功能" backLabel="返回"/></div></div></main>}createRoot(document.getElementById('root')).render(<Demo/>);`,
      resolveDir: root,
      loader: 'tsx',
    },
    outfile: path.join(target, 'view.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': path.join(root, 'src/renderer'), '@shared': path.join(root, 'src/shared') },
    plugins: [
      {
        name: 'fixture',
        setup(b) {
          b.onResolve({ filter: /^@\/services\/i18n$/ }, () => ({
            path: 'i18n',
            namespace: 'fixture',
          }));
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `import {translations} from ${JSON.stringify(path.join(root, 'src/renderer/services/i18n/translations.ts'))};export const i18nService={t:k=>translations.zh[k]??k};`,
            loader: 'js',
            resolveDir: root,
          }));
        },
      },
    ],
  });
  const css = fs
    .readdirSync('dist/assets')
    .filter(f => f.endsWith('.css'))
    .map(f => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'dist/assets', f))}">`)
    .join('');
  fs.writeFileSync(
    path.join(target, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">${css}<style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>`,
  );
  fs.writeFileSync(
    path.join(target, 'capture.cjs'),
    `const {app,BrowserWindow}=require('electron');const fs=require('fs');const path=require('path');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{try{const w=new BrowserWindow({width:560,height:500,show:false,webPreferences:{backgroundThrottling:false}});await w.loadFile(path.join(__dirname,'index.html'));const js=s=>w.webContents.executeJavaScript(s);const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await frame();await js('document.querySelector("button[aria-label=功能]").click()');await frame();await js('document.querySelector("[role=menuitem][aria-haspopup=menu]").click()');await frame();fs.writeFileSync(path.join(__dirname,'menu.png'),(await w.webContents.capturePage()).toPNG());await js('document.querySelector("[role=menuitemradio]").click()');await frame();const state=await js('({text:document.querySelector("textarea").value,mode:!!document.querySelector("button[aria-label=移除模式]"),menu:!!document.querySelector("[role=menu]"),overflow:document.documentElement.scrollWidth>innerWidth})');if(!state.mode||state.menu||state.overflow||state.text!=="请组织助手评审这个方案")throw new Error(JSON.stringify(state));fs.writeFileSync(path.join(__dirname,'selected.png'),(await w.webContents.capturePage()).toPNG());await js('document.querySelector("button[aria-label=移除模式]").click()');await frame();if(await js('!!document.querySelector("button[aria-label=移除模式]")'))throw new Error('remove failed');console.log('Feature menu, two-level choice, preserved text, token removal and narrow layout passed');w.destroy();app.exit(0);}catch(e){console.error(e);app.exit(1)}});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(require('electron'), [path.join(target, 'capture.cjs')], {
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
