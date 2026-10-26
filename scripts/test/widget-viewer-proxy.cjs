// Isolated Electron integration check. Uses the locked native sandbox/wrapper,
// a local fake proxy and temporary userData; never starts a personal Gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  (async () => {
    const root = path.resolve(__dirname, '../..');
    const { resolveNativeSmokeTarget } = await import('../../tests/openclaw/runtime/native-smoke-target.mjs');
    const { runtimeRoot: runtime } = resolveNativeSmokeTarget();
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'))).version,
      '2026.10.7',
    );
    const sidebarMode = process.argv.includes('--sidebar');
    const fixtureRoot = sidebarMode ? path.join(root, '.agent-tasks/browser') : os.tmpdir();
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const fixture = fs.mkdtempSync(
      path.join(fixtureRoot, sidebarMode ? 'widget-viewer-sidebar-' : 'widget-viewer-proxy-'),
    );
    try {
      const dist = path.join(fixture, 'dist');
      fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
      const build = (source, outfile, platform) =>
        require('esbuild').buildSync({
          stdin: { contents: source, resolveDir: root, loader: 'ts' },
          outfile: path.join(fixture, outfile),
          bundle: true,
          platform,
          format: platform === 'node' ? 'cjs' : 'esm',
          target: 'esnext',
          external: platform === 'node' ? ['electron'] : [],
          tsconfig: path.join(root, 'tsconfig.json'),
        });
      build(
        `export * from './src/main/core/window/widgetViewerGuest';export * from './src/main/core/network/systemProxyPreference';export * from './src/main/core/window/renderer/applicationRendererHost';`,
        'main.cjs',
        'node',
      );
      build(`import './src/main/widgetViewerPreload';`, 'preload.cjs', 'node');
      build(
        `import './src/renderer/libs/openclaw-chat/components/native-widget/viewer';`,
        'dist/assets/viewer.js',
        'browser',
      );
      build(
        `import {NativeWidgetView} from './src/renderer/libs/openclaw-chat/components/native-widget/view';
import {NativeWidgetAnchor} from './src/renderer/libs/openclaw-chat/components/native-widget/anchor';
import {getNativeWidgetPresentations} from './src/renderer/libs/openclaw-chat/components/native-widget/presentations';
import {decodeNativeCanvasResult} from './src/renderer/libs/openclaw-chat/pipeline/native-canvas';
const data=window.fixtureData;let reads=0;const errors=[];
const recordRejection=event=>errors.push(String(event.reason));addEventListener('unhandledrejection',recordRejection);
const client={generation:1,gatewayUrl:data.gatewayUrl,request:async()=>{reads++;return data.view}};
const preview=id=>decodeNativeCanvasResult(JSON.stringify({kind:'canvas',presentation:{target:'assistant_message',sandbox:'scripts',title:'Proxy fixture'},view:{id}}),'show_widget','fixture-call');
let current=true,canDraft=true;const links=[];
const context={client,generation:1,sessionKey:'fixture-session',sessionId:'fixture-incarnation',presentationOwner:{},presentationScope:data.sidebar?'fixture-scope':undefined,isCurrent:()=>current,canDraft:()=>canDraft,openLink:url=>links.push(url)};
let destination=document;
if(data.workspace){const child=window.open('/workspace.html?generation=2e4ec192-521e-4b76-b132-e34598e41bb2','widget-proxy-workspace');for(let n=0;n<200;n++){try{if(child.document.body?.dataset.ready==='true'){destination=child.document;break}}catch{}await new Promise(resolve=>setTimeout(resolve,25))}if(destination===document)throw new Error('Workspace did not load')}
if(destination!==document)destination.defaultView.addEventListener('unhandledrejection',recordRejection);
let view,manager,entry,sidebar,sidebarTarget;
if(data.sidebar){
  manager=getNativeWidgetPresentations(destination);manager.retainWorkspace();
  const history=destination.createElement('section');history.style.cssText='padding:16px;box-sizing:border-box;width:calc(100% - 360px)';
  const anchor=new NativeWidgetAnchor();anchor.preview=preview('fixture-doc');anchor.context=context;history.append(anchor);
  sidebar=destination.createElement('section');sidebar.style.cssText='position:absolute;top:24px;bottom:24px;right:16px;width:300px;overflow:hidden;box-sizing:border-box';
  sidebarTarget=destination.createElement('div');sidebarTarget.style.cssText='width:100%;height:100%';sidebar.append(sidebarTarget);
  destination.body.append(history,sidebar);await anchor.updateComplete;
  entry=manager.entries[0];view=entry.view;manager.layout();
}else{view=new NativeWidgetView();view.preview=preview('fixture-doc');view.context=context;destination.body.append(view)}
window.fixture={view,links,errors,sidebar,sidebarTarget,entry,manager,
pin:()=>{manager.pin(entry);manager.setSidebar(entry,sidebarTarget);manager.layout()},
unpin:()=>{manager.unpin(entry);manager.layout()},
replace:id=>{view.preview=preview(id)},reads:()=>reads,setCurrent:value=>{current=value;view.requestUpdate()},setDraft:value=>{canDraft=value;view.requestUpdate()}};
window.fixture.socket=new WebSocket(data.socketUrl);window.fixture.socket.onclose=()=>window.fixture.socketClosed=true;`,
        'dist/assets/parent.js',
        'browser',
      );
      const filenames = fs.readdirSync(path.join(runtime, 'dist'));
      const loadNative = async (prefix, symbol) => {
        const filename = filenames.find(name => name.startsWith(prefix) && name.endsWith('.mjs'));
        const source = fs.readFileSync(path.join(runtime, 'dist', filename), 'utf8');
        const alias = source.match(new RegExp(`${symbol} as (\\w+)`))[1];
        return (
          await import(require('node:url').pathToFileURL(path.join(runtime, 'dist', filename)).href)
        )[alias];
      };
      const document = await loadNative('sandbox-host-', 'buildSandboxHostDocument');
      const sandboxPath = await loadNative('sandbox-host-', 'buildSandboxHostPath');
      const wrap = await loadNative('wrap-', 'buildWidgetDocument');
      const policy = {
        blockDescendantFrames: true,
        resourceDomains: ['http://widget.fixture.invalid'],
      };
      const viewportContent = process.argv.includes('--viewport-content');
      const partialViewportContent = process.argv.includes('--partial-viewport-content');
      const content = partialViewportContent
        ? `<style>
html,body{width:100%;height:100%;overflow:hidden;background:#000}
#scene{width:100vw;height:70vh;min-height:480px;position:relative}canvas{display:block}
#input{position:absolute;top:12px;left:12px}#send{position:absolute;bottom:12px;left:12px}
</style><div id="scene"><canvas></canvas><input id="input" value="Original">
<button id="send" onclick="openclaw.prompt.send('Analyze fixture')">Continue</button></div><script>
const canvas=document.querySelector('canvas'),scene=document.getElementById('scene');
function draw(){canvas.width=scene.clientWidth;canvas.height=scene.clientHeight;
canvas.style.width=canvas.width+'px';canvas.style.height=canvas.height+'px';
const context=canvas.getContext('2d');context.fillStyle='#287d68';context.fillRect(0,0,canvas.width,canvas.height)}
new ResizeObserver(draw).observe(scene);draw()</script>`
        : viewportContent
          ? `<style>
html,body{height:100%;overflow:hidden;background:#000}
#scene{height:100vh;position:relative}canvas{display:block;width:100%;height:100%}
#input{position:fixed;top:12px;left:12px}#send{position:fixed;bottom:12px;left:12px}
</style><div id="scene"><canvas></canvas></div><input id="input" value="Original">
<button id="send" onclick="openclaw.prompt.send('Analyze fixture')">Continue</button><script>
const canvas=document.querySelector('canvas');
function draw(){canvas.width=innerWidth;canvas.height=innerHeight;
const context=canvas.getContext('2d');context.fillStyle='#287d68';context.fillRect(0,0,canvas.width,canvas.height)}
addEventListener('resize',draw);draw()</script>`
          : `<div id="scene" style="height:420px;background:linear-gradient(#061825,#287d68)"></div><input id="input" value="Original"><button id="send" onclick="openclaw.prompt.send('Analyze fixture')">Continue</button>`;
      fs.writeFileSync(
        path.join(fixture, 'native.json'),
        JSON.stringify({
          shell: document(policy),
          sandboxPath: sandboxPath(policy),
          html: wrap(
            'Proxy fixture',
            `${content}${process.argv.includes('--links') ? '<a id="link" href="https://example.com/report" target="_blank"><span>Report</span></a><a id="local-link" href="#scene">Local</a>' : ''}<script src="http://widget.fixture.invalid/asset.js"></script><script>window.documentIdentity=Math.random();window.blocked=false;fetch('http://widget.fixture.invalid/blocked').catch(()=>window.blocked=true)</script>`,
            { scriptOrigins: ['http://widget.fixture.invalid'] },
          ),
        }),
      );
      fs.writeFileSync(
        path.join(dist, 'widget-viewer.html'),
        '<!doctype html><body><script type="module" src="/assets/viewer.js"></script>',
      );
      if (process.argv.includes('--built-viewer')) {
        const built = fs.readFileSync(path.join(root, 'dist/widget-viewer.html'), 'utf8');
        fs.writeFileSync(path.join(dist, 'widget-viewer.html'), built);
        fs.copyFileSync(
          path.join(root, 'dist-electron/widgetViewerPreload.js'),
          path.join(fixture, 'preload.cjs'),
        );
        const copied = new Set();
        const copyAsset = relative => {
          assert.match(relative, /^assets\/[A-Za-z0-9_.-]+\.js$/u);
          if (copied.has(relative)) return;
          copied.add(relative);
          const source = fs.readFileSync(path.join(root, 'dist', relative), 'utf8');
          fs.writeFileSync(path.join(dist, relative), source);
          for (const match of source.matchAll(/["'](\.\/[^"'?#]+\.js)["']/gu))
            copyAsset(path.posix.join(path.posix.dirname(relative), match[1]));
        };
        for (const match of built.matchAll(/(?:src|href)="\.\/(assets\/[^"?#]+\.js)"/gu))
          copyAsset(match[1]);
        assert.ok(copied.size, 'Build the application before checking compiled viewer assets');
      }
      fs.writeFileSync(
        path.join(fixture, 'owner-preload.cjs'),
        `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('electron',{});`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = require('node:child_process').spawnSync(
        require('electron'),
        [__filename, fixture, ...process.argv.slice(3).filter(value => value.startsWith('--'))],
        { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 60000 },
      );
      if (result.error) throw result.error;
      assert.equal(result.status, 0, 'Electron proxy check failed');
    } finally {
      if (sidebarMode) {
        console.log(`Widget sidebar guest artifacts: ${fixture}`);
      } else {
        assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
        assert.ok(path.basename(fixture).startsWith('widget-viewer-proxy-'));
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    }
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow, session, webContents, WebContentsView } = require('electron');
  const fixture = process.argv[2];
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(1), 45000);
  const until = async (read, label) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const listen = server =>
    new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  let owner, host, sandbox, proxy, sockets, workspace;
  app
    .whenReady()
    .then(async () => {
      const api = require(path.join(fixture, 'main.cjs'));
      const native = JSON.parse(fs.readFileSync(path.join(fixture, 'native.json')));
      let proxyRequests = [];
      proxy = http.createServer((request, response) => {
        proxyRequests.push(request.url);
        response.setHeader('Content-Type', 'application/javascript');
        response.end('window.proxyAssetLoaded=true');
      });
      const proxyPort = await listen(proxy);
      await session.defaultSession.setProxy({ mode: 'direct' });
      await api.applyBrowserProxyPreference({
        browserProxy: {
          mode: 'custom',
          custom: { protocol: 'http', host: '127.0.0.1', port: String(proxyPort) },
        },
      });
      const viewers = api.createWidgetViewerGuests(
        path.join(fixture, 'preload.cjs'),
        api.getBrowserProxyCredentials,
      );
      sandbox = http.createServer((_request, response) => {
        response.writeHead(200, native.shell.headers);
        response.end(native.shell.html);
      });
      const sandboxPort = await listen(sandbox);
      const { WebSocketServer } = require(path.join(process.cwd(), 'node_modules/ws'));
      sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise(resolve => sockets.once('listening', resolve));
      const data = {
        workspace: process.argv.includes('--workspace'),
        sidebar: process.argv.includes('--sidebar'),
        gatewayUrl: 'ws://127.0.0.1:18789',
        socketUrl: `ws://127.0.0.1:${sockets.address().port}`,
        view: { html: native.html, sandboxPort, sandboxUrl: native.sandboxPath },
      };
      fs.writeFileSync(
        path.join(fixture, 'dist/workspace.html'),
        '<!doctype html><body data-ready="true" style="margin:0">',
      );
      fs.writeFileSync(
        path.join(fixture, 'dist/index.html'),
        `<!doctype html><style>body{margin:0}</style><script>window.fixtureData=${JSON.stringify(data).replaceAll('<', '\\u003c')}</script><script type="module" src="/assets/parent.js"></script>`,
      );
      host = await api.startApplicationRendererHost(path.join(fixture, 'dist'));
      owner = new BrowserWindow({
        show: false,
        width: 900,
        height: 700,
        webPreferences: {
          preload: path.join(fixture, 'owner-preload.cjs'),
          webviewTag: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      const configure = contents => {
        contents.on('will-attach-webview', (event, prefs, params) => {
          if (!viewers.prepare(event, prefs, params, contents)) event.preventDefault();
        });
        contents.on('did-attach-webview', (_event, guest) => viewers.attach(guest, contents));
      };
      configure(owner.webContents);
      owner.webContents.setWindowOpenHandler(() => ({
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            preload: undefined,
            webviewTag: true,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        },
        createWindow: options => {
          workspace = new WebContentsView(options);
          owner.contentView.addChildView(workspace);
          workspace.setBounds({ x: 0, y: 0, width: 900, height: 700 });
          workspace.webContents.setBackgroundThrottling(false);
          configure(workspace.webContents);
          return workspace.webContents;
        },
      }));
      await owner.loadURL(host.url);
      const read = code => owner.webContents.executeJavaScript(code);
      await until(
        () =>
          read(
            'window.fixture?.view.shadowRoot.querySelector("webview") && window.fixture.view.ready',
          ),
        'proxied native card ready',
      );
      const guest = webContents
        .getAllWebContents()
        .find(contents => contents.getURL().includes('/widget-viewer.html?'));
      assert.ok(guest);
      const outer = await until(
        () => guest.mainFrame.frames.find(frame => frame.url.includes('/mcp-app-sandbox')),
        'native outer sandbox',
      );
      const inner = await until(
        () => outer.frames.find(frame => frame.url.startsWith('about:')),
        'opaque inner frame',
      );
      await until(
        () => inner.executeJavaScript('window.proxyAssetLoaded && window.blocked'),
        'allowed script through proxy and blocked connect',
      );
      const partialViewportContent = process.argv.includes('--partial-viewport-content');
      const canvasContent = partialViewportContent || process.argv.includes('--viewport-content');
      const assertViewport = async label => {
        let dimensions;
        await until(async () => {
          const tag = await read(
            '(()=>{const f=window.fixture.view.shadowRoot.querySelector("webview");return {width:f.clientWidth,height:f.clientHeight}})()',
          );
          const container = await read(
            '(()=>{const f=window.fixture.view.shadowRoot.querySelector(".frame");return {width:f.clientWidth,height:f.clientHeight}})()',
          );
          const viewer = await guest.executeJavaScript('({width:innerWidth,height:innerHeight})');
          const shell = await outer.executeJavaScript('({width:innerWidth,height:innerHeight})');
          const document = await inner.executeJavaScript('({width:innerWidth,height:innerHeight})');
          const canvas = canvasContent
            ? await inner.executeJavaScript(
                '(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {width:r.width,height:r.height}})()',
              )
            : tag;
          dimensions = { tag, container, viewer, shell, document, canvas };
          return [container, viewer, shell, document, canvas].every(
            size =>
              Math.abs(tag.height - size.height) <= 1 && Math.abs(tag.width - size.width) <= 1,
          );
        }, label).catch(error => {
          throw new Error(`${error.message}: ${JSON.stringify(dimensions)}`);
        });
        return dimensions.tag;
      };
      if (partialViewportContent)
        await until(() => read('window.fixture.view.height===480'), 'initial scene minimum height');
      else if (!canvasContent)
        await until(() => read('window.fixture.view.height>420'), 'initial content measurement');
      const inlineViewport = await assertViewport('all native guest frames fill the inline card');
      assert.ok(
        canvasContent
          ? inlineViewport.height === (partialViewportContent ? 480 : 420)
          : inlineViewport.height > 420,
        'The full scene and controls determine the inline height',
      );
      assert.ok(
        await inner.executeJavaScript(
          'document.getElementById("send").getBoundingClientRect().bottom<=innerHeight',
        ),
        'Bottom controls must be inside the visible inline viewport',
      );
      await read('window.fixture.view.style.width="280px"');
      const narrowViewport = await assertViewport('all native guest frames follow a narrow card');
      assert.equal(narrowViewport.width, await read('window.fixture.view.clientWidth'));
      assert.ok(narrowViewport.width < 300);
      await read('window.fixture.view.style.removeProperty("width")');
      await assertViewport('all native guest frames return from a narrow card');
      assert.ok(proxyRequests.some(url => url === 'http://widget.fixture.invalid/asset.js'));
      assert.ok(!proxyRequests.some(url => url.includes('/blocked')));
      assert.equal(
        await session.defaultSession.resolveProxy('http://widget.fixture.invalid'),
        'DIRECT',
      );
      assert.match(await guest.session.resolveProxy('http://widget.fixture.invalid'), /PROXY/);
      assert.equal(await guest.session.resolveProxy(host.url), 'DIRECT');
      assert.equal(await guest.executeJavaScript('typeof window.electron'), 'undefined');
      assert.equal(await inner.executeJavaScript('typeof window.widgetViewer'), 'undefined');
      assert.equal(await inner.executeJavaScript('openclaw.prompt.send("programmatic")'), false);
      // Real Chromium input inside the guest must still reach the parent's human
      // confirmation UI; a cross-WebContents transient activation is not invented.
      const presentation = workspace?.webContents ?? owner.webContents;
      presentation.debugger.attach('1.3');
      await presentation.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
      guest.debugger.attach('1.3');
      await guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await read('window.fixture.view.shadowRoot.querySelector("webview").focus()');
      await read(
        'window.fixture.events=[];window.fixture.view.shadowRoot.querySelector("webview").addEventListener("ipc-message",e=>window.fixture.events.push(e.args))',
      );
      await inner.executeJavaScript(
        'window.fixtureClicks=[];document.addEventListener("click",e=>fixtureClicks.push({trusted:e.isTrusted,active:navigator.userActivation.isActive,target:e.target.id}),true)',
      );
      const button = await inner.executeJavaScript(
        '(()=>{const r=document.getElementById("send").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
      );
      const outerOffset = await guest.executeJavaScript(
        '(()=>{const r=document.querySelector("justdo-native-widget").shadowRoot.querySelector("iframe").getBoundingClientRect();return {x:r.x,y:r.y}})()',
      );
      const innerOffset = await outer.executeJavaScript(
        '(()=>{const r=document.querySelector("iframe").getBoundingClientRect();return {x:r.x,y:r.y}})()',
      );
      const { targetInfos } = await guest.debugger.sendCommand('Target.getTargets');
      const target =
        targetInfos.find(target => target.type === 'iframe' && target.url.startsWith('about:')) ??
        targetInfos.find(
          target => target.type === 'iframe' && target.url.includes('/mcp-app-sandbox'),
        );
      const targetSession = target
        ? (
            await guest.debugger.sendCommand('Target.attachToTarget', {
              targetId: target.targetId,
              flatten: true,
            })
          ).sessionId
        : undefined;
      for (const type of ['mousePressed', 'mouseReleased'])
        await guest.debugger.sendCommand(
          'Input.dispatchMouseEvent',
          {
            type,
            button: 'left',
            clickCount: 1,
            x: button.x + outerOffset.x + innerOffset.x,
            y: button.y + outerOffset.y + innerOffset.y,
          },
          targetSession,
        );
      try {
        await until(
          () =>
            read(
              'window.fixture.view.shadowRoot.querySelector(".suggestion p")?.textContent.includes("Analyze fixture")',
            ),
          'trusted guest draft suggestion',
        );
      } catch (error) {
        console.error(
          'draft diagnostic',
          await inner.executeJavaScript('window.fixtureClicks'),
          await guest.executeJavaScript(
            '({focus:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.localName,inner:document.querySelector("justdo-native-widget").shadowRoot.activeElement?.localName})',
          ),
          await read(
            '({focus:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.localName,inner:fixture.view.shadowRoot.activeElement?.localName,events:fixture.events})',
          ),
        );
        throw error;
      }
      assert.equal(
        await read('window.fixture.view.shadowRoot.querySelectorAll(".suggestion button").length'),
        2,
      );
      await read('window.fixture.setDraft(false)');
      await until(
        () => read('!window.fixture.view.shadowRoot.querySelector(".suggestion")'),
        'draft capability revocation',
      );
      if (process.argv.includes('--links')) {
        // Neither programmatic clicks nor public postMessage may open a URL.
        await inner.executeJavaScript(
          'document.getElementById("link").click();parent.postMessage({type:"widget-view:open-link",url:"https://example.com/forged"},"*")',
        );
        assert.deepEqual(await read('window.fixture.links'), []);
        const documentIdentity = await inner.executeJavaScript('window.documentIdentity');
        const linkRect = await inner.executeJavaScript(
          '(()=>{const r=document.getElementById("link").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
        );
        const clickLink = async () => {
          await read('window.fixture.view.shadowRoot.querySelector("webview").focus()');
          for (const type of ['mousePressed', 'mouseReleased'])
            await guest.debugger.sendCommand(
              'Input.dispatchMouseEvent',
              {
                type,
                button: 'left',
                clickCount: 1,
                x: linkRect.x + outerOffset.x + innerOffset.x,
                y: linkRect.y + outerOffset.y + innerOffset.y,
              },
              targetSession,
            );
        };
        await clickLink();
        await until(
          async () => (await read('window.fixture.links.length')) === 1,
          'trusted URL activation while drafts are disabled',
        );
        assert.deepEqual(await read('window.fixture.links'), ['https://example.com/report']);
        assert.equal(await inner.executeJavaScript('window.documentIdentity'), documentIdentity);
        assert.equal(await inner.executeJavaScript('typeof window.widgetViewer'), 'undefined');
        assert.equal(guest.getURL().startsWith(host.origin), true);
      }
      await guest.session.cookies.set({ url: host.origin, name: 'widget-only', value: '1' });
      assert.equal((await session.defaultSession.cookies.get({ name: 'widget-only' })).length, 0);
      const identity = await inner.executeJavaScript('window.documentIdentity');
      await inner.executeJavaScript('document.getElementById("input").value="Preserved"');
      if (process.argv.includes('--sidebar')) {
        const assertRetained = async () => {
          assert.equal(
            webContents
              .getAllWebContents()
              .find(contents => contents.getURL().includes('/widget-viewer.html?'))?.id,
            guest.id,
            'Pinning must preserve the isolated guest',
          );
          assert.equal(await inner.executeJavaScript('window.documentIdentity'), identity);
          assert.equal(
            await inner.executeJavaScript('document.getElementById("input").value'),
            'Preserved',
          );
          assert.equal(await read('window.fixture.reads()'), 1);
        };
        const pin = async () => {
          await read('window.fixture.pin()');
          await until(
            () =>
              read(
                `(()=>{const v=fixture.view,r=v.shadowRoot,t=fixture.sidebarTarget.getBoundingClientRect(),d=r.querySelector('dialog').getBoundingClientRect(),f=r.querySelector('webview').getBoundingClientRect();return fixture.entry.pinned&&v.fillContainer&&Math.abs(d.height-t.height)<=1&&Math.abs(f.bottom-d.bottom)<=1})()`,
              ),
            'native widget fills sidebar',
          );
          const viewport = await assertViewport('native guest, sandbox and canvas fill sidebar');
          await assertRetained();
          return viewport;
        };
        const unpin = async () => {
          await read('window.fixture.unpin()');
          await until(
            () => read(`!fixture.entry.pinned&&!fixture.view.fillContainer`),
            'native widget returns to message',
          );
          const viewport = await assertViewport('native guest returns to its inline viewport');
          assert.equal(viewport.height, inlineViewport.height);
          await assertRetained();
          return viewport;
        };
        const pinnedViewport = await pin();
        assert.ok(pinnedViewport.height > inlineViewport.height);
        const painted =
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))';
        await inner.executeJavaScript(painted);
        await guest.executeJavaScript(painted);
        await owner.webContents.executeJavaScript(painted);
        await new Promise(resolve => setTimeout(resolve, 150));
        const inputValue = await inner.executeJavaScript('document.getElementById("input").value');
        assert.equal(inputValue, 'Preserved');
        fs.writeFileSync(
          path.join(fixture, 'sidebar-pinned.png'),
          (await owner.webContents.capturePage()).toPNG(),
        );
        await read('fixture.sidebarTarget.style.display="none";fixture.manager.layout()');
        await until(
          () => read('getComputedStyle(fixture.entry.layer).display==="none"'),
          'inactive native widget sidebar hidden',
        );
        await assertRetained();
        await read('fixture.sidebarTarget.style.display="block";fixture.manager.layout()');
        await assertViewport('native guest returns after hiding sidebar target');
        await unpin();
        const repinnedViewport = await pin();
        await unpin();
        fs.writeFileSync(
          path.join(fixture, 'sidebar-result.json'),
          JSON.stringify(
            {
              inlineViewport,
              pinnedViewport,
              repinnedViewport,
              sameGuest: true,
              sameDocument: true,
              inputPreserved: true,
              inputValue,
              authenticatedReads: 1,
              inactiveHidden: true,
            },
            null,
            2,
          ),
        );
      }
      await read(
        'window.fixture.view.shadowRoot.querySelector(".view-actions button:not([data-action=pin])").click()',
      );
      const expandedViewport = await assertViewport(
        'all native guest frames fill the expanded card',
      );
      assert.ok(expandedViewport.height > inlineViewport.height);
      const expandedReport = canvasContent
        ? await until(
            () =>
              read(
                'window.fixture.events.map(args=>args[0]).findLast(value=>value.type==="height"&&value.height===window.fixture.view.shadowRoot.querySelector("webview").getBoundingClientRect().height)',
              ),
            'height report measured in the expanded viewport',
          )
        : undefined;
      assert.equal(await inner.executeJavaScript('window.documentIdentity'), identity);
      owner.setSize(760, 650);
      if (workspace) {
        const size = owner.getContentBounds();
        workspace.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
      }
      const resizedViewport = await assertViewport(
        'all native guest frames follow a window resize',
      );
      assert.ok(resizedViewport.width < expandedViewport.width);
      assert.ok(resizedViewport.height < expandedViewport.height);
      if (partialViewportContent) {
        owner.setSize(1100, 1050);
        workspace?.setBounds({ x: 0, y: 0, width: 1100, height: 1050 });
        await assertViewport('70vh canvas fills a tall expanded viewport');
        const presentation = workspace?.webContents ?? owner.webContents;
        for (const zoom of [0.8, 1.25, 1.5]) {
          presentation.setZoomFactor(zoom);
          await assertViewport('canvas follows expanded window zoom');
        }
        presentation.setZoomFactor(1);
      }
      owner.setSize(900, 700);
      workspace?.setBounds({ x: 0, y: 0, width: 900, height: 700 });
      await assertViewport('all native guest frames return after the window resize');
      await read(
        'window.fixture.view.shadowRoot.querySelector(".view-actions button:not([data-action=pin])").click()',
      );
      const collapsedViewport = await assertViewport(
        'all native guest frames return to inline height',
      );
      assert.equal(collapsedViewport.height, inlineViewport.height);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(
        (await assertViewport('inline height stays restored after queued size reports')).height,
        inlineViewport.height,
      );
      if (expandedReport) {
        // Delay real captured guest events well beyond any animation-frame wait.
        // Replaying the old layout must never resize the restored viewport.
        for (const delay of [0, 200, 1200]) {
          await new Promise(resolve => setTimeout(resolve, delay));
          await guest.executeJavaScript(
            `window.widgetViewer.emit(${JSON.stringify(expandedReport)})`,
          );
          await new Promise(resolve => setTimeout(resolve, 150));
          assert.equal(
            (await assertViewport('late expanded reports cannot grow the inline card')).height,
            inlineViewport.height,
          );
        }
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        await read(
          'window.fixture.view.shadowRoot.querySelector(".view-actions button:not([data-action=pin])").click()',
        );
        owner.setSize(900, 1050);
        workspace?.setBounds({ x: 0, y: 0, width: 900, height: 1050 });
        await read(
          'window.fixture.view.shadowRoot.querySelector(".view-actions button:not([data-action=pin])").click()',
        );
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(
          (await assertViewport('inline height survives a resize during collapse')).height,
          inlineViewport.height,
        );
        owner.setSize(900, 700);
        workspace?.setBounds({ x: 0, y: 0, width: 900, height: 700 });
      }
      if (!canvasContent) {
        await inner.executeJavaScript('document.getElementById("scene").style.height="520px"');
        await until(
          async () =>
            (await assertViewport('content can grow after collapse')).height >=
            inlineViewport.height + 100,
          'updated content height',
        );
      }
      assert.equal(
        await inner.executeJavaScript('document.getElementById("input").value'),
        'Preserved',
      );
      await until(() => read('window.fixture.socket.readyState===1'), 'default-session socket');
      await api.applyBrowserProxyPreference({ browserProxy: { mode: 'direct' } });
      assert.equal(await guest.session.resolveProxy('http://widget.fixture.invalid'), 'DIRECT');
      assert.equal(
        await read('window.fixture.socket.readyState'),
        1,
        'Browser proxy changes must not disconnect chat transport',
      );
      assert.equal(await read('window.fixture.reads()'), 1);
      guest.forcefullyCrashRenderer();
      await until(
        () => read('Boolean(window.fixture.view.shadowRoot.querySelector("[role=alert]"))'),
        'guest crash recovery UI',
      );
      assert.equal(await read('window.fixture.socket.readyState'), 1);
      assert.equal(
        await read('Boolean(window.fixture.view.shadowRoot.querySelector("iframe"))'),
        false,
      );
      await api.applyBrowserProxyPreference({
        browserProxy: {
          mode: 'custom',
          custom: { protocol: 'http', host: '127.0.0.1', port: String(proxyPort) },
        },
      });
      await read('window.fixture.view.shadowRoot.querySelector("[role=alert] button").click()');
      await until(
        () => read('window.fixture.view.ready && !window.fixture.view.failure'),
        'explicit retry after guest crash',
      );
      const replacement = webContents
        .getAllWebContents()
        .find(contents => contents.getURL().includes('/widget-viewer.html?'));
      assert.ok(replacement);
      assert.notEqual(replacement.id, guest.id);
      assert.equal(await read('window.fixture.reads()'), 2);
      // Churn live state and mounts while guest-manager calls may still be in
      // flight. A stale asynchronous rejection must never escape into Renderer.
      for (let index = 0; index < 8; index++) {
        await read(
          `(async()=>{window.fixture.setDraft(${index % 2 === 0});await window.fixture.view.updateComplete;window.fixture.replace('churn-${index}');await window.fixture.view.updateComplete})()`,
        );
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await until(
        () => read('window.fixture.view.ready && !window.fixture.view.failure'),
        'last rapid replacement loaded',
      );
      const latest = webContents
        .getAllWebContents()
        .find(contents => contents.getURL().includes('/widget-viewer.html?'));
      assert.ok(latest);
      assert.equal(await read('window.fixture.reads()'), 10);
      await read('window.fixture.setCurrent(false)');
      await until(() => latest.isDestroyed(), 'disposed guest revoked');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(
        await read('window.fixture.errors'),
        [],
        'No unhandled guest-manager rejection during crash, replacement or disposal',
      );
      console.log(
        'Widget proxy integration passed: native viewport sizing through expand/resize/collapse, isolated storage, proxied script, CSP, preserved input, default-session socket, crash/retry, rapid replacements and disposal without unhandled rejections.',
      );
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      clearTimeout(deadline);
      workspace?.webContents.close();
      owner?.destroy();
      for (const socket of sockets?.clients ?? []) socket.terminate();
      sockets?.close();
      sandbox?.close();
      proxy?.close();
      await host?.close();
      app.exit(process.exitCode || 0);
    });
}
