// Verify widget viewport resizing in real Chromium, using only local test documents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const widgetDocument = `<!doctype html><style>
html,body{height:100%;margin:0}canvas{display:block;width:100%;height:100%;background:#061825}
input{position:fixed;top:16px;left:16px;padding:8px}
</style><canvas></canvas><input value="Original input"><script>
window.documentIdentity=Math.random();window.resizes=0;
function draw(){const canvas=document.querySelector('canvas');canvas.width=innerWidth;canvas.height=innerHeight;
const context=canvas.getContext('2d');context.fillStyle='#061825';context.fillRect(0,0,canvas.width,canvas.height);
context.strokeStyle='#60d6ea';context.lineWidth=12;context.beginPath();context.arc(innerWidth/2,innerHeight/2,Math.min(innerWidth,innerHeight)*.3,0,Math.PI*2);context.stroke();
resizes++;parent.postMessage({type:'openclaw:widget-size',height:innerHeight},'*');}
addEventListener('resize',draw);draw();
</script>`;

if (!process.versions.electron) {
  const root = path.resolve(__dirname, '../..');
  const outputRoot = path.join(root, '.agent-tasks/browser');
  fs.mkdirSync(outputRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(outputRoot, 'widget-viewport-'));
  const entry = path.join(fixture, 'entry.js');
  const source = relative => JSON.stringify(path.join(root, relative));
  fs.writeFileSync(
    entry,
    `
import {NativeWidgetView} from ${source('src/renderer/libs/openclaw-chat/components/native-widget/view.ts')};
import {decodeNativeCanvasResult} from ${source('src/renderer/libs/openclaw-chat/pipeline/native-canvas.ts')};
import {readWorkspaceOcclusion} from ${source('src/renderer/features/cowork/components/display/workspaceOcclusion.ts')};
const config=await fetch('/fixture').then(response=>response.json());
let reads=0;
const client={generation:1,gatewayUrl:config.gatewayUrl,request:async(method,params)=>{
if(method!=='canvas.document.view'||params.docId!=='viewport-widget')throw new Error('Unexpected read');
reads++;return {html:config.html,sandboxPort:config.sandboxPort,sandboxUrl:'/mcp-app-sandbox'};}};
const view=new NativeWidgetView();
view.preview=decodeNativeCanvasResult(JSON.stringify({kind:'canvas',presentation:{target:'assistant_message',sandbox:'scripts',title:'Viewport test'},view:{id:'viewport-widget'}}),'show_widget','viewport-call');
view.context={client,generation:1,sessionKey:'viewport-session',isCurrent:()=>true,canDraft:()=>true};
const chat=document.createElement('justdo-chat');chat.style.cssText='display:block;width:calc(100% - 320px)';
document.body.append(chat);chat.attachShadow({mode:'open'}).append(view);window.fixture={view,reads:()=>reads};
const report=()=>window.viewportTest.update(readWorkspaceOcclusion(new DOMRect(innerWidth-320,0,320,innerHeight)).blocked);
new MutationObserver(report).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','data-workspace-overlay']});
addEventListener('resize',report);report();
`,
  );
  fs.writeFileSync(
    path.join(fixture, 'preload.cjs'),
    `
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('viewportTest',{update:blocked=>ipcRenderer.invoke('fixture:occlusion',blocked)});
`,
  );
  const build = (entryPoints, outfile, options = {}) =>
    require('esbuild').buildSync({
      entryPoints,
      outfile: path.join(fixture, outfile),
      bundle: true,
      tsconfig: path.join(root, 'tsconfig.json'),
      ...options,
    });
  build([entry], 'entry.js.bundle', { platform: 'browser', format: 'esm', target: 'esnext' });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(
    require('electron'),
    [__filename, fixture],
    {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
      timeout: 55000,
    },
  );
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
  const fixture = process.argv[2];
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(1), 45000);
  const pause = () => new Promise(resolve => setTimeout(resolve, 40));
  const until = async read => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await read();
      if (value) return value;
      await pause();
    }
    throw new Error('Widget viewport did not settle');
  };
  const listen = server =>
    new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  let owner, server, sandbox, sidebar;
  app
    .whenReady()
    .then(async () => {
      // External resources are blocked so the check also works without public network access.
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
}else if(inner&&event.source===inner.contentWindow)parent.postMessage(event.data,'*');});
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
          response.end(fs.readFileSync(path.join(fixture, path.basename(url.pathname))));
        } else if (url.pathname === '/sidebar.html') {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<html style="height:100%;background:#fd6600"><body>Native sidebar<script>window.documentIdentity=Math.random()</script></body></html>',
          );
        } else {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<html style="font:14px system-ui;--justdo-background:#fff"><body style="margin:0"><script type="module" src="/entry.js.bundle"></script></body></html>',
          );
        }
      });
      const port = await listen(server);
      owner = new BrowserWindow({
        show: false,
        width: 1100,
        height: 1000,
        webPreferences: {
          preload: path.join(fixture, 'preload.cjs'),
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      sidebar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
      owner.contentView.addChildView(sidebar);
      const positionSidebar = () => {
        const [width, height] = owner.getContentSize();
        sidebar.setBounds({ x: width - 320, y: 0, width: 320, height });
      };
      positionSidebar();
      owner.on('resize', positionSidebar);
      await sidebar.webContents.loadURL(`http://127.0.0.1:${port}/sidebar.html`);
      const sidebarIdentity =
        await sidebar.webContents.executeJavaScript('window.documentIdentity');
      ipcMain.handle('fixture:occlusion', (event, blocked) => {
        assert.equal(event.sender, owner.webContents);
        assert.equal(typeof blocked, 'boolean');
        sidebar.setVisible(!blocked);
      });
      owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const run = code => owner.webContents.executeJavaScript(code);
      await owner.loadURL(`http://127.0.0.1:${port}/index.html`);
      const leaf = contents =>
        contents.mainFrame.frames.find(frame => frame.url.includes('/mcp-app-sandbox'))?.frames[0];
      await until(
        async () =>
          (await run(
            `Boolean(window.fixture?.view.shadowRoot.querySelector('iframe')&&!fixture.view.shadowRoot.querySelector('.loading'))`,
          )) && leaf(owner.webContents),
      );
      const original = leaf(owner.webContents);
      await original.executeJavaScript(`document.querySelector('input').value='Keep this input'`);
      const identity = await original.executeJavaScript('window.documentIdentity');
      const metricCode = `(()=>{const v=fixture.view;const r=v.shadowRoot;const f=r.querySelector('iframe').getBoundingClientRect();const d=r.querySelector('dialog').getBoundingClientRect();const suggestion=r.querySelector('.suggestion')?.getBoundingClientRect().height??0;return {frameHeight:f.height,bottomGap:d.bottom-f.bottom-suggestion,width:f.width,viewport:innerHeight}})()`;
      const assertFill = async contents =>
        until(async () => {
          const metrics = await contents.executeJavaScript(metricCode);
          const inner = leaf(contents);
          if (!inner) return false;
          const size = await inner.executeJavaScript(
            `({height:innerHeight,canvas:document.querySelector('canvas')?.height})`,
          );
          return metrics.bottomGap <= 2 &&
            metrics.frameHeight > 200 &&
            Math.abs(size.height - metrics.frameHeight) <= 1 &&
            size.canvas === size.height
            ? metrics
            : false;
        });
      const inline = await owner.webContents.executeJavaScript(metricCode);
      assert.equal(sidebar.getVisible(), true);
      assert.equal(
        await run(`fixture.view.shadowRoot.querySelectorAll('.view-actions button').length`),
        1,
      );
      await run('fixture.view.toggleExpanded()');
      await until(() => !sidebar.getVisible());
      const expanded = await assertFill(owner.webContents);
      assert.ok(expanded.frameHeight > inline.frameHeight + 200);
      owner.setSize(1000, 760);
      const resized = await assertFill(owner.webContents);
      assert.ok(resized.frameHeight < expanded.frameHeight - 150);
      await run(`fixture.view.suggestion='Reviewed selection';fixture.view.requestUpdate()`);
      const withSuggestion = await until(
        async () =>
          (await run(`Boolean(fixture.view.shadowRoot.querySelector('.suggestion'))`)) &&
          assertFill(owner.webContents),
      );
      assert.ok(withSuggestion.frameHeight < resized.frameHeight - 40);
      await run(`fixture.view.suggestion='';fixture.view.collapse()`);
      await until(
        async () =>
          Math.abs(
            (await owner.webContents.executeJavaScript(metricCode)).frameHeight -
              inline.frameHeight,
          ) <= 1,
      );
      assert.equal(await original.executeJavaScript('window.documentIdentity'), identity);
      assert.equal(
        await original.executeJavaScript(`document.querySelector('input').value`),
        'Keep this input',
      );
      assert.equal(await run('fixture.reads()'), 1);
      await until(() => sidebar.getVisible());
      assert.equal(
        await sidebar.webContents.executeJavaScript('window.documentIdentity'),
        sidebarIdentity,
      );
      await run(`(async()=>{for(let index=0;index<20;index++){
        fixture.view.toggleExpanded();await new Promise(resolve=>setTimeout(resolve,20));
        fixture.view.collapse();await new Promise(resolve=>setTimeout(resolve,20));
      }})()`);
      await until(
        async () =>
          Math.abs(
            (await owner.webContents.executeJavaScript(metricCode)).frameHeight -
              inline.frameHeight,
          ) <= 1,
      );
      await until(() => sidebar.getVisible());
      assert.equal(await original.executeJavaScript('window.documentIdentity'), identity);
      assert.equal(
        await original.executeJavaScript(`document.querySelector('input').value`),
        'Keep this input',
      );
      await run('fixture.view.toggleExpanded()');
      await until(() => !sidebar.getVisible());
      await original.executeJavaScript(
        `const content=document.createElement('div');content.style.height='3000px';document.body.append(content);document.scrollingElement.scrollTop=1200`,
      );
      assert.ok(await original.executeJavaScript('document.scrollingElement.scrollTop>1000'));
      assert.equal(await run(`fixture.view.shadowRoot.querySelector('dialog').scrollTop`), 0);
      await run('fixture.view.remove()');
      await until(() => sidebar.getVisible());
      assert.equal(
        await sidebar.webContents.executeJavaScript('window.documentIdentity'),
        sidebarIdentity,
      );
      assert.equal(await run('fixture.reads()'), 1);
      const result = {
        inline,
        expanded,
        resized,
        withSuggestion,
        sidebarRestored: true,
        sameSidebarDocument: true,
      };
      fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2));
      console.log(`Widget viewport checks passed: ${JSON.stringify(result)}`);
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      clearTimeout(deadline);
      sidebar?.webContents.close();
      owner?.destroy();
      server?.close();
      sandbox?.close();
      app.exit(process.exitCode ?? 0);
    });
}
