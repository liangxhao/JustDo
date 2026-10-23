// Exercise the actual widget presentation registry in Chromium, without Gateway or public network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const widgetDocument = `<!doctype html><style>
html,body{height:100%;margin:0}canvas{display:block;width:100%;height:100%;background:#061825}
input{position:fixed;top:16px;left:16px;padding:8px;max-width:70%;box-sizing:border-box}
</style><canvas></canvas><input aria-label="Local input" value="Original input"><script>
window.documentIdentity=Math.random();
function draw(){const canvas=document.querySelector('canvas');canvas.width=innerWidth;canvas.height=innerHeight;
const context=canvas.getContext('2d');context.fillStyle='#061825';context.fillRect(0,0,canvas.width,canvas.height);
context.strokeStyle='#60d6ea';context.lineWidth=8;context.beginPath();context.arc(innerWidth/2,innerHeight/2,Math.min(innerWidth,innerHeight)*.3,0,Math.PI*2);context.stroke();}
addEventListener('resize',draw);draw();
</script>`;

if (!process.versions.electron) {
  const root = path.resolve(__dirname, '../..');
  const outputRoot = path.join(root, '.agent-tasks/browser');
  fs.mkdirSync(outputRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(outputRoot, 'widget-sidebar-'));
  const entry = path.join(fixture, 'entry.js');
  const source = relative => JSON.stringify(path.join(root, relative));
  fs.writeFileSync(
    entry,
    `
import {NativeWidgetAnchor} from ${source('src/renderer/libs/openclaw-chat/components/native-widget/anchor.ts')};
import {getNativeWidgetPresentations} from ${source('src/renderer/libs/openclaw-chat/components/native-widget/presentations.ts')};
import {decodeNativeCanvasResult} from ${source('src/renderer/libs/openclaw-chat/pipeline/native-canvas.ts')};
import {useWidgetReferenceTabs} from ${source('src/renderer/features/cowork/components/display/tabs/useWidgetReferenceTabs.tsx')};
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
const config=await fetch('/fixture').then(response=>response.json());
let reads=0,current=true;
const client={generation:1,gatewayUrl:config.gatewayUrl,request:async(method,params)=>{
  if(method!=='canvas.document.view'||params.docId!=='sidebar-widget')throw new Error('Unexpected read');
  reads++;return {html:config.html,sandboxPort:config.sandboxPort,sandboxUrl:'/mcp-app-sandbox'};
}};
const presentationOwner={};
const context={client,generation:1,sessionKey:'sidebar-session',sessionId:'sidebar-incarnation',
  presentationOwner,presentationScope:'sidebar-smoke',isCurrent:()=>current,canDraft:()=>true};
const preview=decodeNativeCanvasResult(JSON.stringify({kind:'canvas',
  presentation:{target:'assistant_message',sandbox:'scripts',title:'Interactive sidebar check'},
  view:{id:'sidebar-widget'}}),'show_widget','sidebar-call');
const chat=document.createElement('section');chat.id='history';
chat.style.cssText='position:absolute;inset:44px 450px 0 0;overflow:auto;padding:20px;box-sizing:border-box';
const sidebar=document.createElement('section');sidebar.id='sidebar';
sidebar.style.cssText='position:absolute;right:20px;top:64px;bottom:24px;width:390px;overflow:hidden;background:#fff;border:1px solid #c8cdd4;box-sizing:border-box';
const label=document.createElement('header');label.textContent='Conversation                         Sidebar';
label.style.cssText='padding:14px 20px;border-bottom:1px solid #ddd;font-weight:600';
document.body.append(label,chat,sidebar);
const manager=getNativeWidgetPresentations();
let selectSidebar;
function Sidebar(){
  const [activeId,setActiveId]=useState(null);
  selectSidebar=setActiveId;
  const references=useWidgetReferenceTabs('sidebar-smoke',setActiveId,()=>{},['sidebar-smoke']);
  return references.panel(activeId)??null;
}
createRoot(sidebar).render(React.createElement(Sidebar));
const makeAnchor=()=>{const anchor=new NativeWidgetAnchor();anchor.preview=preview;anchor.context=context;chat.append(anchor);return anchor;};
let anchor=makeAnchor();
window.fixture={manager,context,sidebar,chat,reads:()=>reads,
  get entry(){return manager.entries[0]},get anchor(){return anchor},
  get sidebarTarget(){return this.entry.sidebar},
  pin(){manager.pin(this.entry);manager.layout()},
  unpin(){manager.unpin(this.entry);manager.layout()},
  removeAnchor(){anchor.remove();manager.layout()},
  reacquire(){anchor=makeAnchor();manager.layout()},
  invalidate(){current=false;manager.refresh(presentationOwner);manager.layout()},
  sidebarActive(active){selectSidebar(active?this.entry.id:null)},
  clipSidebar(){sidebar.style.height='240px';sidebar.style.bottom='auto';this.sidebarTarget.style.height='620px';manager.layout()},
  restoreSidebar(){sidebar.style.height='';sidebar.style.bottom='24px';this.sidebarTarget.style.height='';manager.layout()},
  standalone(){
    const source=document.createElement('section');
    source.style.cssText='position:fixed;left:24px;top:80px;width:480px;bottom:30px;z-index:60;background:white;overflow:auto';
    const standaloneClient={...client,request:async(method,params)=>{
      if(method!=='canvas.document.view'||params.docId!=='standalone-widget')throw new Error('Unexpected standalone read');
      source.reads++;return {html:config.html,sandboxPort:config.sandboxPort,sandboxUrl:'/mcp-app-sandbox'};
    }};
    source.reads=0;
    const standaloneContext={client:standaloneClient,generation:1,sessionKey:'standalone-session',sessionId:'standalone-incarnation',
      presentationOwner:source,isCurrent:()=>source.isConnected,canDraft:()=>false};
    const anchor=new NativeWidgetAnchor();
    anchor.preview=decodeNativeCanvasResult(JSON.stringify({kind:'canvas',
      presentation:{target:'assistant_message',sandbox:'scripts',title:'Standalone history'},
      view:{id:'standalone-widget'}}),'show_widget','standalone-call');
    anchor.context=standaloneContext;source.append(anchor);document.body.append(source);
    const fixture={source,anchor,context:standaloneContext,get view(){return anchor.shadowRoot.querySelector('justdo-native-widget')}};
    this.standaloneFixture=fixture;return fixture;
  },
};
`,
  );
  require('esbuild').buildSync({
    entryPoints: [entry],
    outfile: path.join(fixture, 'entry.js.bundle'),
    bundle: true,
    tsconfig: path.join(root, 'tsconfig.json'),
    platform: 'browser',
    format: 'esm',
    target: 'esnext',
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(
    require('electron'),
    [__filename, fixture],
    { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 55000 },
  );
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, session } = require('electron');
  const fixture = process.argv[2];
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(1), 45000);
  const pause = () => new Promise(resolve => setTimeout(resolve, 40));
  const until = async (read, description) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await read();
      if (value) return value;
      await pause();
    }
    throw new Error(`Widget sidebar did not settle: ${description}`);
  };
  const listen = server =>
    new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  let owner, server, sandbox;
  app
    .whenReady()
    .then(async () => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        callback({
          cancel: ['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1',
        });
      });
      sandbox = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><style>html,body{height:100%;margin:0}iframe{width:100%;height:100%;border:0;display:block}</style><body><script>
let inner;addEventListener('message',event=>{
if(event.source===parent&&event.data.method==='ui/notifications/sandbox-resource-ready'){
  inner=document.createElement('iframe');inner.sandbox='allow-scripts allow-forms';inner.srcdoc=event.data.params.html;
  inner.onload=()=>parent.postMessage({method:'ui/notifications/sandbox-resource-loaded',params:{renderId:event.data.params.renderId}},event.origin);
  document.body.replaceChildren(inner);
}else if(inner&&event.source===parent)inner.contentWindow.postMessage(event.data,'*');
else if(inner&&event.source===inner.contentWindow)parent.postMessage(event.data,'*');});
parent.postMessage({method:'ui/notifications/sandbox-proxy-ready',params:{sandboxUrl:location.href}},'*');
</script></body>`);
      });
      const sandboxPort = await listen(sandbox);
      server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/fixture') {
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              html: widgetDocument,
              sandboxPort,
              gatewayUrl: `ws://127.0.0.1:${server.address().port}`,
            }),
          );
        } else if (url.pathname === '/entry.js.bundle') {
          response.setHeader('Content-Type', 'application/javascript');
          response.end(fs.readFileSync(path.join(fixture, 'entry.js.bundle')));
        } else {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<html style="font:14px system-ui;--justdo-background:#fff"><style>.absolute{position:absolute}.inset-0{inset:0}.bg-background{background:#fff}</style><body style="margin:0;background:#f4f6f8"><script type="module" src="/entry.js.bundle"></script></body></html>',
          );
        }
      });
      const port = await listen(server);
      owner = new BrowserWindow({
        show: false,
        width: 1100,
        height: 900,
        webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
      });
      owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const run = code => owner.webContents.executeJavaScript(code);
      await owner.loadURL(`http://127.0.0.1:${port}/index.html`);
      const leaf = () =>
        owner.webContents.mainFrame.frames.find(frame => frame.url.includes('/mcp-app-sandbox'))
          ?.frames[0];
      await until(
        async () =>
          (await run(
            `Boolean(window.fixture?.entry?.view.shadowRoot.querySelector('iframe')&&!fixture.entry.view.shadowRoot.querySelector('.loading'))`,
          )) && leaf(),
        'initial document',
      );
      const original = leaf();
      await original.executeJavaScript(`document.querySelector('input').value='Keep this input'`);
      const identity = await original.executeJavaScript('window.documentIdentity');
      const assertRetained = async () => {
        assert.equal(leaf(), original, 'The native inner frame must remain mounted');
        assert.equal(await original.executeJavaScript('window.documentIdentity'), identity);
        assert.equal(
          await original.executeJavaScript(`document.querySelector('input').value`),
          'Keep this input',
        );
        assert.equal(
          await run('fixture.reads()'),
          1,
          'Presentation changes must not read HTML again',
        );
      };
      const metricCode = `(()=>{if(!fixture.sidebarTarget)return {display:'none'};
        const e=fixture.entry,v=e.view,r=v.shadowRoot;
        const f=r.querySelector('iframe').getBoundingClientRect(),d=r.querySelector('dialog').getBoundingClientRect();
        const t=fixture.sidebarTarget.getBoundingClientRect(),l=e.layer.getBoundingClientRect();
        const suggestionHeight=r.querySelector('.suggestion')?.getBoundingClientRect().height??0;
        return {frameHeight:f.height,frameWidth:f.width,dialogHeight:d.height,targetHeight:t.height,targetWidth:t.width,
          layerHeight:l.height,suggestionHeight,bottomGap:d.bottom-f.bottom-suggestionHeight,clip:e.layer.style.clipPath,display:getComputedStyle(e.layer).display,
          inert:e.layer.inert||v.inert};})()`;
      const assertFill = async () =>
        until(async () => {
          const metrics = await run(metricCode);
          const size = await original.executeJavaScript(
            `({height:innerHeight,canvas:document.querySelector('canvas').height})`,
          );
          return metrics.display !== 'none' &&
            metrics.frameHeight > 200 &&
            metrics.bottomGap <= 2 &&
            Math.abs(metrics.dialogHeight - metrics.targetHeight) <= 2 &&
            Math.abs(metrics.frameWidth - metrics.targetWidth) <= 2 &&
            Math.abs(size.height - metrics.frameHeight) <= 1 &&
            size.canvas === size.height
            ? metrics
            : false;
        }, 'sidebar viewport fill');
      await run(`fixture.entry.view.shadowRoot.querySelector('[data-action="pin"]').click()`);
      const pinned = await assertFill();
      await assertRetained();
      fs.writeFileSync(
        path.join(fixture, 'pinned.png'),
        (await owner.webContents.capturePage()).toPNG(),
      );
      await run(
        `fixture.entry.view.suggestion='Reviewed selection';fixture.entry.view.requestUpdate()`,
      );
      const withSuggestion = await until(async () => {
        const value = await assertFill();
        return value.suggestionHeight > 40 ? value : false;
      }, 'suggestion leaves a filled content viewport');
      assert.ok(withSuggestion.frameHeight < pinned.frameHeight - 40);
      await run('fixture.sidebarActive(false)');
      await until(
        async () => await run(`getComputedStyle(fixture.entry.layer).display==='none'`),
        'inactive sidebar hidden',
      );
      await until(
        async () => await run(`!fixture.entry.view.shadowRoot.querySelector('.suggestion')`),
        'hidden suggestion revoked',
      );
      await assertRetained();
      await run('fixture.sidebarActive(true)');
      await assertFill();
      await run('fixture.clipSidebar()');
      const clipped = await until(async () => {
        const value = await run(metricCode);
        return value.clip && /[1-9]\d*(?:\.\d+)?px/.test(value.clip) ? value : false;
      }, 'sidebar ancestor clipping');
      await assertRetained();
      await run('fixture.restoreSidebar();fixture.unpin()');
      await until(
        async () =>
          await run(
            `!fixture.entry.pinned&&fixture.entry.layer.getBoundingClientRect().left<fixture.sidebar.getBoundingClientRect().left`,
          ),
        'return to message',
      );
      await assertRetained();
      await until(
        async () =>
          await run(`(()=>{const entry=fixture.entry;
            const button=entry.view.shadowRoot.querySelector('[data-action="pin"]');
            return entry.visible&&entry.view.canPin&&button&&!button.disabled&&button.getClientRects().length>0;})()`),
        'inline pin action becomes available after returning from sidebar',
      );
      await run('fixture.pin()');
      await assertFill();
      await run('fixture.removeAnchor()');
      await until(
        async () => await run('fixture.entry.anchors.size===0&&fixture.entry.pinned'),
        'history anchor removal while pinned',
      );
      await assertRetained();
      await run('fixture.unpin()');
      await until(
        async () =>
          await run(
            `fixture.entry.returnPending&&getComputedStyle(fixture.entry.layer).display==='none'`,
          ),
        'pending return to unloaded history',
      );
      await assertRetained();
      await run('fixture.reacquire()');
      await until(
        async () =>
          await run(
            `!fixture.entry.returnPending&&fixture.entry.primary===fixture.anchor&&getComputedStyle(fixture.entry.layer).display!=='none'`,
          ),
        'history reacquire',
      );
      await assertRetained();
      await run('fixture.pin()');
      const repinned = await assertFill();
      await run(
        `fixture.entry.view.shadowRoot.querySelector('.view-actions button').click();fixture.manager.layout()`,
      );
      await until(
        async () =>
          await run(
            `fixture.entry.view.shadowRoot.querySelector('dialog').matches(':modal')&&getComputedStyle(fixture.entry.layer).display!=='none'`,
          ),
        'pinned widget expands over its own overlay',
      );
      await assertRetained();
      await run('fixture.entry.view.collapsePresentation();fixture.manager.layout()');
      await assertFill();
      const expand = async () => {
        await run(
          `fixture.entry.view.shadowRoot.querySelector('.view-actions button').click();fixture.manager.layout()`,
        );
        await until(
          async () =>
            await run(`fixture.entry.view.expanded&&fixture.entry.visible&&
            fixture.entry.view.shadowRoot.querySelector('dialog').matches(':modal')`),
          'expanded widget respects its own overlay marker',
        );
        await assertRetained();
      };
      const assertSuppressed = async description => {
        await until(
          async () =>
            await run(`!fixture.entry.visible&&!fixture.entry.view.expanded&&
            getComputedStyle(fixture.entry.layer).display==='none'&&
            !fixture.entry.view.shadowRoot.querySelector('dialog').matches(':modal')&&
            !fixture.entry.view.shadowRoot.querySelector('.suggestion')`),
          description,
        );
        await assertRetained();
      };
      await expand();
      await run(`fixture.entry.view.suggestion='Revoke when hidden';fixture.entry.view.requestUpdate();
        fixture.sidebarTarget.hidden=true;fixture.manager.layout()`);
      await assertSuppressed('hiding an expanded sidebar target closes and revokes its viewer');
      await run('fixture.sidebarTarget.hidden=false;fixture.manager.layout()');
      await assertFill();
      await expand();
      await run(`fixture.entry.view.suggestion='Revoke when inert';fixture.entry.view.requestUpdate();
        fixture.sidebar.inert=true;fixture.manager.layout()`);
      await assertSuppressed('an inert sidebar ancestor closes and revokes the expanded viewer');
      await run('fixture.sidebar.inert=false;fixture.manager.layout()');
      await assertFill();
      await expand();
      await run(`fixture.entry.view.suggestion='Revoke under another overlay';fixture.entry.view.requestUpdate();
        fixture.otherOverlay=document.createElement('div');fixture.otherOverlay.dataset.workspaceOverlay='true';
        fixture.otherOverlay.style.cssText='position:fixed;inset:0;z-index:100;background:#fff';
        document.body.append(fixture.otherOverlay);fixture.manager.layout()`);
      await assertSuppressed('a separate workspace overlay suppresses the expanded viewer');
      await run('fixture.otherOverlay.remove();fixture.manager.layout()');
      await assertFill();
      owner.setSize(1040, 760);
      const resized = await assertFill();
      assert.ok(resized.frameHeight < repinned.frameHeight - 100);
      await assertRetained();
      fs.writeFileSync(
        path.join(fixture, 'repinned.png'),
        (await owner.webContents.capturePage()).toPNG(),
      );
      await run('void fixture.standalone()');
      await until(
        async () =>
          await run(`Boolean(fixture.standaloneFixture.view?.shadowRoot.querySelector('iframe')&&
          !fixture.standaloneFixture.view.shadowRoot.querySelector('.loading'))`),
        'standalone history loads its in-tree viewer',
      );
      const standaloneInner = owner.webContents.mainFrame.frames.find(
        frame => frame.url.includes('/mcp-app-sandbox') && frame.frames[0] !== original,
      )?.frames[0];
      assert.ok(standaloneInner, 'Standalone history must retain its own native document');
      const standaloneIdentity = await standaloneInner.executeJavaScript('window.documentIdentity');
      await standaloneInner.executeJavaScript(
        `document.querySelector('input').value='Standalone input'`,
      );
      const standaloneState = () =>
        run(`(()=>{const f=fixture.standaloneFixture,v=f.view,b=v.shadowRoot.querySelector('.view-actions button');
        const r=v.getBoundingClientRect(),hit=document.elementFromPoint(r.left+10,r.top+10);
        b.focus();return {entries:fixture.manager.entries.length,inline:v.parentNode===f.anchor.shadowRoot,
        context:v.context===f.anchor.context,current:v.context.isCurrent(),visible:v.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),
        sourceHit:f.source.contains(hit),focused:document.activeElement===f.anchor,reads:f.source.reads,
        hasPin:Boolean(v.shadowRoot.querySelector('[data-action="pin"]'))};})()`);
      let standalone = await standaloneState();
      assert.deepEqual(standalone, {
        entries: 1,
        inline: true,
        context: true,
        current: true,
        visible: true,
        sourceHit: true,
        focused: true,
        reads: 1,
        hasPin: false,
      });
      await run(`fixture.standaloneFixture.source.style.visibility='hidden';fixture.standaloneFixture.source.inert=true;
        document.activeElement.blur()`);
      standalone = await standaloneState();
      assert.equal(standalone.visible, false);
      assert.equal(standalone.sourceHit, false);
      assert.equal(standalone.focused, false);
      assert.equal(standalone.entries, 1);
      await run(`fixture.standaloneFixture.source.style.visibility='';fixture.standaloneFixture.source.inert=false;
        fixture.standaloneFixture.anchor.context={...fixture.standaloneFixture.context,canDraft:()=>false};void 0`);
      await until(
        async () => (await standaloneState()).context,
        'standalone context refresh reaches its nested viewer',
      );
      standalone = await standaloneState();
      assert.equal(standalone.visible, true);
      assert.equal(standalone.sourceHit, true);
      assert.equal(standalone.focused, true);
      assert.equal(standalone.reads, 1);
      assert.equal(
        await standaloneInner.executeJavaScript('window.documentIdentity'),
        standaloneIdentity,
      );
      assert.equal(
        await standaloneInner.executeJavaScript(`document.querySelector('input').value`),
        'Standalone input',
      );
      await run('fixture.standaloneFixture.source.remove()');
      await run('fixture.invalidate()');
      await until(
        async () =>
          await run(`!document.querySelector('[data-native-widget-presentation] iframe')&&
        (!fixture.entry||!fixture.entry.view.shadowRoot.querySelector('iframe'))`),
        'invalidated document cleared',
      );
      assert.equal(await run('fixture.reads()'), 1);
      const result = {
        pinned,
        withSuggestion,
        clipped,
        repinned,
        resized,
        sameDocument: true,
        inputPreserved: true,
        reads: 1,
        inactiveHidden: true,
        historyReacquired: true,
        invalidationCleared: true,
        expandedTargetHidden: true,
        expandedAncestorInert: true,
        expandedExternalOverlay: true,
        standaloneInline: true,
        standaloneVisibilityPreserved: true,
        standaloneInputPreserved: true,
      };
      fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2));
      console.log(`Widget sidebar checks passed: ${JSON.stringify(result)}`);
      console.log(`Widget sidebar screenshots: ${fixture}`);
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      clearTimeout(deadline);
      owner?.destroy();
      server?.close();
      sandbox?.close();
      app.exit(process.exitCode ?? 0);
    });
}
