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
    const runtime = path.resolve(
      process.argv[2] || path.join(root, 'vendor/openclaw-runtime/current'),
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'))).version,
      '2026.10.4',
    );
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-viewer-proxy-'));
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
import {decodeNativeCanvasResult} from './src/renderer/libs/openclaw-chat/pipeline/native-canvas';
const data=window.fixtureData;let reads=0;
const client={generation:1,gatewayUrl:data.gatewayUrl,request:async()=>{reads++;return data.view}};
const view=new NativeWidgetView();view.preview=decodeNativeCanvasResult(JSON.stringify({kind:'canvas',presentation:{target:'assistant_message',sandbox:'scripts',title:'Proxy fixture'},view:{id:'fixture-doc'}}),'show_widget','fixture-call');
let current=true,canDraft=true;
view.context={client,generation:1,sessionKey:'fixture-session',isCurrent:()=>current,canDraft:()=>canDraft};
let destination=document;
if(data.workspace){const child=window.open('/workspace.html?generation=2e4ec192-521e-4b76-b132-e34598e41bb2','widget-proxy-workspace');for(let n=0;n<200;n++){try{if(child.document.body?.dataset.ready==='true'){destination=child.document;break}}catch{}await new Promise(resolve=>setTimeout(resolve,25))}if(destination===document)throw new Error('Workspace did not load')}
destination.body.append(view);window.fixture={view,reads:()=>reads,setCurrent:value=>{current=value;view.requestUpdate()},setDraft:value=>{canDraft=value;view.requestUpdate()}};
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
      fs.writeFileSync(
        path.join(fixture, 'native.json'),
        JSON.stringify({
          shell: document(policy),
          sandboxPath: sandboxPath(policy),
          html: wrap(
            'Proxy fixture',
            `<input id="input" value="Original"><button id="send" onclick="openclaw.prompt.send('Analyze fixture')">Continue</button><script src="http://widget.fixture.invalid/asset.js"></script><script>window.documentIdentity=Math.random();window.blocked=false;fetch('http://widget.fixture.invalid/blocked').catch(()=>window.blocked=true)</script>`,
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
        [__filename, fixture, ...(process.argv.includes('--workspace') ? ['--workspace'] : [])],
        { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 60000 },
      );
      if (result.error) throw result.error;
      assert.equal(result.status, 0, 'Electron proxy check failed');
    } finally {
      assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
      assert.ok(path.basename(fixture).startsWith('widget-viewer-proxy-'));
      fs.rmSync(fixture, { recursive: true, force: true });
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
      await guest.session.cookies.set({ url: host.origin, name: 'widget-only', value: '1' });
      assert.equal((await session.defaultSession.cookies.get({ name: 'widget-only' })).length, 0);
      const identity = await inner.executeJavaScript('window.documentIdentity');
      await inner.executeJavaScript('document.getElementById("input").value="Preserved"');
      await read('window.fixture.view.shadowRoot.querySelector(".view-actions button").click()');
      assert.equal(await inner.executeJavaScript('window.documentIdentity'), identity);
      await read('window.fixture.view.shadowRoot.querySelector(".view-actions button").click()');
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
      await read('window.fixture.setCurrent(false)');
      await until(() => replacement.isDestroyed(), 'disposed guest revoked');
      console.log(
        'Widget proxy integration passed: native sandbox, isolated storage, proxied script, CSP, preserved input, default-session socket, crash/retry and disposal.',
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
