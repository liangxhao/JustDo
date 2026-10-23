'use strict';
// Real App SDK, locked native sandbox, production workspace manager, isolated profile.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.agent-tasks/mcp-apps/reference-smoke');
fs.mkdirSync(output, { recursive: true });
if (!process.versions.electron) {
  const { buildSync } = require('esbuild');
  const browser = {
    bundle: true,
    platform: 'browser',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'silent',
    alias: { '@': path.join(root, 'src/renderer'), '@shared': path.join(root, 'src/shared') },
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.png': 'file', '.webp': 'file' },
  };
  buildSync({
    ...browser,
    entryPoints: [path.join(__dirname, 'reference-smoke-host.tsx')],
    outfile: path.join(output, 'host.js'),
  });
  buildSync({
    ...browser,
    stdin: {
      contents:
        "import { installMcpAppFrameMessaging } from './src/renderer/libs/openclaw-chat/components/mcp-app/transport';import {installNativeWidgetMessaging} from './src/renderer/libs/openclaw-chat/components/native-widget/messaging';installMcpAppFrameMessaging();installNativeWidgetMessaging();const root=document.createElement('div');root.id='workspace-root';document.body.append(root);",
      resolveDir: root,
    },
    outfile: path.join(output, 'workspace.js'),
  });
  buildSync({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    stdin: {
      contents:
        "export * from './src/main/core/window/workspaceWindowManager';export * from './src/main/ipc/app/workspaceWindow';export * from './src/main/core/window/widgetViewerGuest';",
      resolveDir: root,
    },
    outfile: path.join(output, 'manager.cjs'),
  });
  buildSync({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    entryPoints: [path.join(root, 'src/main/widgetViewerPreload.ts')],
    outfile: path.join(output, 'widget-preload.cjs'),
  });
  buildSync({
    ...browser,
    entryPoints: [
      path.join(root, 'src/renderer/libs/openclaw-chat/components/native-widget/viewer.ts'),
    ],
    outfile: path.join(output, 'widget-viewer.js'),
  });
  const app = buildSync({
    ...browser,
    write: false,
    outfile: path.join(output, 'app.js'),
    stdin: {
      resolveDir: root,
      contents: `
    import { App } from '@modelcontextprotocol/ext-apps';
    const app = new App({name:'Reference fixture',version:'1'}, {}, {autoResize:false});
    app.ontoolresult = result => {document.body.dataset.viewId=result.structuredContent.id};
    app.onteardown = async () => {document.body.dataset.closed='true';return {}};
    document.querySelector('button').onclick=async()=>{try{await app.callServerTool({name:'echo',arguments:{}});document.body.dataset.called='true'}catch{document.body.dataset.denied='true'}};
    await app.connect();document.body.dataset.ready='true';window.documentInstance=Math.random();window.fixtureApp=app;
  `,
    },
  });
  fs.writeFileSync(
    path.join(output, 'app.html'),
    '<input id="draft"><button>Tool</button><script type="module">' +
      app.outputFiles[0].text.replaceAll('</script', '<\\/script') +
      '</script>',
  );
  fs.copyFileSync(
    path.join(root, 'tests/electron/workspace-window/preload.cjs'),
    path.join(output, 'preload.cjs'),
  );
  require('postcss')([require('tailwindcss')({ config: path.join(root, 'tailwind.config.js') })])
    .process('@tailwind base;@tailwind utilities;', {
      from: path.join(root, 'src/renderer/index.css'),
    })
    .then(css => {
      fs.writeFileSync(path.join(output, 'layout.css'), css.css);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
        cwd: root,
        env,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 120000,
      });
      if (result.error) console.error(result.error);
      process.exitCode = result.status ?? 1;
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
} else {
  const { app, BrowserWindow, webContents } = require('electron');
  app.setPath('userData', path.join(output, 'profile'));
  app.on('window-all-closed', () => {});
  app
    .whenReady()
    .then(async () => {
      // windowsHide sets the process's first ShowWindow flag. Consume it on a
      // throwaway probe so the detached test shell can actually receive input.
      if (process.platform === 'win32') {
        const startup = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        startup.show();
        startup.hide();
        startup.destroy();
      }
      let stage = 'bootstrap';
      const checkpoint = value => {
        stage = value;
      };
      const deadline = setTimeout(() => {
        console.error(`Reference smoke exceeded 60s at ${stage}`);
        app.exit(1);
      }, 60000);
      const dist = path.join(root, 'vendor/openclaw-runtime/current/dist');
      const native = await import(
        pathToFileURL(
          path.join(
            dist,
            fs.readdirSync(dist).find(file => /^sandbox-host-.*\.mjs$/.test(file)),
          ),
        ).href
      );
      const shell = native.n();
      const sandbox = http.createServer((_req, res) => {
        res.writeHead(200, shell.headers);
        res.end(shell.html);
      });
      await new Promise(resolve => sandbox.listen(0, '127.0.0.1', resolve));
      const payload = {
        html: fs.readFileSync(path.join(output, 'app.html'), 'utf8'),
        sandboxPort: sandbox.address().port,
        sandboxUrl: native.r(),
      };
      const wrapperFile = fs.readdirSync(dist).find(file => /^wrap-.*\.mjs$/.test(file));
      const wrapperSource = fs.readFileSync(path.join(dist, wrapperFile), 'utf8');
      const wrapperAlias = wrapperSource.match(/buildWidgetDocument as (\w+)/)[1];
      const wrap = (await import(pathToFileURL(path.join(dist, wrapperFile)).href))[wrapperAlias];
      const widgetPayload = {
        ...payload,
        html: wrap(
          'Composite widget',
          '<input id="widget-input" value="Original widget"><script>document.body.dataset.widgetReady="true";window.widgetDocumentInstance=Math.random()</script>',
        ),
      };
      const server = http.createServer((req, res) => {
        const file = req.url.split('?')[0].slice(1);
        if (file === 'workspace') {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<html><style>html,body,#workspace-root{margin:0;height:100%;overflow:hidden}</style><body><script type="module" src="/workspace.js"></script></body></html>',
          );
        } else if (file === 'widget-viewer.html') {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<!doctype html><html><body><script type="module" src="/widget-viewer.js"></script></body></html>',
          );
        } else if (
          ['host.js', 'workspace.js', 'widget-viewer.js', 'host.css', 'layout.css'].includes(file)
        ) {
          res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
          res.end(fs.readFileSync(path.join(output, file)));
        } else {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<html lang="en"><head><style>.cowork-workspace-header{height:38px;min-height:38px}</style><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/host.css"></head><body><div id="root"></div><script>window.fixturePayload=' +
              JSON.stringify(payload).replaceAll('<', '\\u003c') +
              ';window.widgetPayload=' +
              JSON.stringify(widgetPayload).replaceAll('<', '\\u003c') +
              '</script><script type="module" src="/host.js"></script></body></html>',
          );
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const {
        WorkspaceWindowManager,
        registerWorkspaceWindowHandlers,
        createWidgetViewerGuests,
      } = require(path.join(output, 'manager.cjs'));
      registerWorkspaceWindowHandlers();
      const viewers = createWidgetViewerGuests(path.join(output, 'widget-preload.cjs'), () => null);
      const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 850,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
          webviewTag: true,
          preload: path.join(output, 'preload.cjs'),
        },
      });
      const configureWidgetHost = contents => {
        contents.on('will-attach-webview', (event, prefs, params) => {
          if (!viewers.prepare(event, prefs, params, contents)) event.preventDefault();
        });
        contents.on('did-attach-webview', (_event, guest) => viewers.attach(guest, contents));
      };
      configureWidgetHost(win.webContents);
      let workspace;
      const manager = new WorkspaceWindowManager(win, {
        url: `${base}/workspace`,
        getBackgroundColor: () => '#ffffff',
        getTitleBarOverlay: () => ({ color: '#ffffff', symbolColor: '#111111', height: 38 }),
        readBounds: () => undefined,
        saveBounds: () => {},
        isMac: false,
        isWindows: true,
        isQuitting: () => false,
        showSystemMenu: () => {},
        openExternal: () => {},
        configureHost: contents => {
          workspace = contents;
          configureWidgetHost(contents);
        },
        configureSurfaceHost: configureWidgetHost,
      });
      win.webContents.setWindowOpenHandler(
        details => manager.handleOpen(details) ?? { action: 'deny' },
      );
      const errors = [];
      win.webContents.on('console-message', event => {
        if (
          event.level === 'error' &&
          event.message !== "Unrecognized Content-Security-Policy directive 'webrtc'."
        )
          errors.push(event.message);
      });
      await win.loadURL(base);
      const evaluate = async script => {
        try {
          return await win.webContents.executeJavaScript(script);
        } catch (error) {
          throw new Error(
            `Reference evaluation failed: ${script.slice(0, 160)}; ${error.message}; ${JSON.stringify(errors)}`,
          );
        }
      };
      const until = async (operation, description = '') => {
        for (let i = 0; i < 200; i++) {
          const value = await operation();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(
          'Reference probe timed out: ' +
            description +
            ' ' +
            JSON.stringify(errors) +
            ' ' +
            (await evaluate(
              'JSON.stringify({selected:currentSelected,counts:compositeCounts,entries:window.manager?.entries.map(e=>({id:e.id,error:e.view.error,loading:e.view.loading})),panels:[...document.querySelectorAll("aside")].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),hidden:e.getAttribute("aria-hidden")})),focus:document.activeElement?.outerHTML?.slice(0,180)})',
            )) +
            ' workspace=' +
            (workspace && !workspace.isDestroyed()
              ? await workspace.executeJavaScript(
                  'JSON.stringify({focus:document.activeElement?.outerHTML?.slice(0,180),inert:document.getElementById("workspace-root")?.inert,tabs:[...document.querySelectorAll("[role=tab]")].map(e=>({selected:e.getAttribute("aria-selected"),text:e.textContent}))})',
                )
              : 'unavailable'),
        );
      };
      const findFrame = async (contents, id) => {
        if (!contents) return;
        const hosts =
          contents === win.webContents
            ? webContents.getAllWebContents().filter(host => host.getURL().startsWith(base))
            : [contents];
        for (const frame of hosts.flatMap(host => host.mainFrame.framesInSubtree)) {
          try {
            if (
              await frame.executeJavaScript(
                `document.body?.dataset.viewId===${JSON.stringify(id)} && document.body.dataset.ready==='true'`,
              )
            )
              return frame;
          } catch {}
        }
      };
      const assertSurfaceParent = async (id, target, carrier) => {
        const entry = await until(() => {
          const value = manager.surfaces.entries.get(id);
          const parent = target === 'workspace' ? manager.root : win.contentView;
          return value?.parent === parent &&
            parent.children.includes(value.group) &&
            value.group.getVisible()
            ? value
            : false;
        });
        assert.equal(entry.update.target, target);
        assert.equal(entry.view.webContents, carrier);
        assert.ok(entry.group.children.includes(entry.view));
        return entry;
      };
      const inline = await until(() => findFrame(win.webContents, 'mcp-app-inline'));
      checkpoint('initial App carrier');
      const appSurface = await until(async () => {
        const state = await evaluate('surfaceStates().app');
        return state?.ready && state.update?.visible ? state : false;
      });
      const appSurfaceId = new URL(appSurface.documentUrl).searchParams.get('surface');
      assert.ok(appSurfaceId, 'The first MCP frame must load directly in its stable carrier');
      const appCarrier = webContents
        .getAllWebContents()
        .find(contents => contents.getURL() === appSurface.documentUrl);
      assert.ok(appCarrier);
      assert.equal(await appCarrier.executeJavaScript('typeof window.electron'), 'undefined');
      assert.equal(appSurface.update.target, 'main');
      await assertSurfaceParent(appSurfaceId, 'main', appCarrier);
      await evaluate('captureNativeIdentity("app")');
      await until(
        async () =>
          !!workspace &&
          (await workspace.executeJavaScript('!!window.registerMcpAppFrameTransport')),
      );
      const normal = await until(() => findFrame(workspace, 'mcp-app-ordinary'));
      const iconLight = await evaluate('iconLight');
      await until(() =>
        workspace.executeJavaScript(
          'document.querySelector("[role=tab][aria-selected=true] img")?.complete',
        ),
      );
      assert.equal(
        await workspace.executeJavaScript(
          'document.querySelector("[role=tab][aria-selected=true] img").getAttribute("src")',
        ),
        iconLight,
        'manual App Tab uses the plugin catalog icon',
      );
      await evaluate('openFileTab()');
      await until(() => findFrame(workspace, 'mcp-app-file'));
      assert.equal(
        await workspace.executeJavaScript(
          'document.querySelector("[role=tab][aria-selected=true] img").getAttribute("src")',
        ),
        iconLight,
        'file App Tab uses the actual plugin rather than its extension',
      );
      await evaluate('closeFileTab()');
      await until(() =>
        workspace.executeJavaScript(
          '[...document.querySelectorAll("[role=tab]")].every(tab=>!tab.textContent.includes("Example.file"))',
        ),
      );
      const instance = await inline.executeJavaScript(
        'document.querySelector("input").value="unsaved main App";document.querySelector("input").setSelectionRange(2,7);window.documentInstance',
      );
      const normalInstance = await normal.executeJavaScript(
        'document.querySelector("input").value="unsaved workspace App";window.documentInstance',
      );
      const calls = await evaluate('calls.length');
      const reads = await evaluate('calls.filter(c=>c.method==="mcp.app.view").length');
      const generation = manager.prepare().generation;
      // Independent equivalent captures must not cause Lit's context/update loop.
      await evaluate('addDuplicate()');
      await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
      assert.equal(await evaluate('manager.entries.length'), 1);
      await evaluate('pin()');
      await until(() =>
        workspace.executeJavaScript(
          '!!document.querySelector("[role=tab][aria-selected=true] img")',
        ),
      );
      assert.equal(
        await workspace.executeJavaScript(
          'document.querySelector("[role=tab][aria-selected=true] img").getAttribute("src")',
        ),
        iconLight,
        'reference Tab uses the same declared plugin icon',
      );
      await until(async () => {
        const state = await evaluate('surfaceStates().app');
        return state.update?.target === 'workspace' && state.update.visible;
      });
      assert.equal(
        await evaluate('manager.entries[0].sidebar.ownerDocument.URL'),
        workspace.getURL(),
      );
      assert.equal(await evaluate('surfaceStates().app.documentUrl'), appSurface.documentUrl);
      await assertSurfaceParent(appSurfaceId, 'workspace', appCarrier);
      assert.deepEqual(await evaluate('verifyNativeIdentity("app")'), {
        objects: true,
        authority: true,
        descriptor: true,
      });
      for (const language of ['en', 'zh']) {
        for (const width of [400, 320]) {
          for (const dark of [false, true]) {
            await evaluate(`cardLayout(${width},${JSON.stringify(language)},true,${dark})`);
            const row = await until(() =>
              evaluate(`(() => {
              const root=document.querySelector('mcp-app-anchor').shadowRoot;
              const row=root.querySelector('.reference'); if(!row) return;
              const title=root.querySelector('.title'),status=root.querySelector('.status'),button=root.querySelector('button');
              const rect=row.getBoundingClientRect();
              const parts=[root.querySelector('.app-icon'),title,status,button].map(e=>e.getBoundingClientRect());
              const image=[...root.querySelectorAll('img')].find(e=>e.checkVisibility());
              return {height:rect.height, singleRow:parts.every(r=>Math.abs((r.top+r.height/2)-(rect.top+rect.height/2))<1),
                clipped:title.scrollWidth>title.clientWidth,titleWidth:title.clientWidth,
                fits:parts.every(r=>r.left>=rect.left&&r.right<=rect.right),
                src:image?.getAttribute('src'),loaded:image?.complete&&image.naturalWidth>0};
            })()`),
            );
            assert.equal(row.height, 52, 'compact reference height');
            assert.ok(
              row.singleRow && row.fits && row.clipped && row.titleWidth > 10,
              JSON.stringify(row),
            );
            assert.equal(row.src, await evaluate(dark ? 'iconDark' : 'iconLight'));
            await until(() =>
              evaluate(
                `(() => {const images=[...document.querySelector('mcp-app-anchor').shadowRoot.querySelectorAll('img')];return images.some(e=>e.checkVisibility()&&e.complete&&e.naturalWidth>0)})()`,
              ),
            );
          }
        }
      }
      // A confirmed update has a longer status than the ordinary pin state.
      await evaluate('cardLayout(320,"en",true)');
      assert.ok(
        await evaluate(`(() => {
        const root=document.querySelector('mcp-app-anchor').shadowRoot;
        const text=[...root.querySelector('.status span').childNodes].find(node=>node.nodeType===Node.TEXT_NODE);
        const previous=text.data;
        text.data='Updated · In sidebar';
        const row=root.querySelector('.reference').getBoundingClientRect();
        const title=root.querySelector('.title'),button=root.querySelector('button').getBoundingClientRect();
        const fits=title.clientWidth>10&&button.right<=row.right&&row.height===52;
        text.data=previous;
        return fits;
      })()`),
        'long confirmed-update status keeps the title and action visible at 320px',
      );
      await evaluate('cardLayout()');
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      fs.writeFileSync(
        path.join(output, 'compact-reference.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      await evaluate('pin()');
      await until(() =>
        workspace.executeJavaScript(
          '!!document.querySelector("[role=tab][aria-selected=true]")?.textContent.includes("Example dashboard")',
        ),
      );
      assert.equal(await evaluate('manager.entries.length'), 1);
      // The App still uses standard SDK requests from the same frame.
      await until(() =>
        evaluate(
          'manager.entries[0].view.fillContainer && !!manager.entries[0].sidebar?.getClientRects().length',
        ),
      );
      assert.equal(
        (await inline.executeJavaScript('fixtureApp.requestDisplayMode({mode:"fullscreen"})')).mode,
        'fullscreen',
      );
      await until(() =>
        workspace.executeJavaScript(
          'document.querySelector("#cowork-display-panel")?.dataset.workspaceFullscreen==="true"',
        ),
      );
      assert.equal(
        (await inline.executeJavaScript('fixtureApp.requestDisplayMode({mode:"inline"})')).mode,
        'inline',
      );
      await until(() =>
        workspace.executeJavaScript(
          'document.querySelector("#cowork-display-panel")?.dataset.workspaceFullscreen==="false"',
        ),
      );
      // Modal/menu occlusion blocks standard tool RPC as well as pointer input.
      checkpoint('MCP occlusion and keyboard');
      for (const kind of ['modal', 'menu', 'listbox']) {
        await evaluate(`overlay(${JSON.stringify(kind)})`);
        await until(
          () => evaluate('manager.entries[0].layer.style.display==="none"'),
          `source ${kind} blocks carrier`,
        );
        const result = await inline.executeJavaScript(
          'fixtureApp.callServerTool({name:"echo",arguments:{}}).then(()=>"allowed",()=>"denied")',
        );
        assert.equal(result, 'denied', kind);
        await evaluate('overlay()');
        await until(() => evaluate('manager.entries[0].layer.style.display!=="none"'));
      }
      // Reference and ordinary tabs share the same real workspace document.
      await evaluate('selectNormal()');
      await until(() => manager.view.getVisible());
      await workspace.executeJavaScript(
        'document.querySelector("[role=tab][aria-selected=true]").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))',
      );
      await until(() =>
        workspace.executeJavaScript(
          'document.activeElement?.getAttribute("role")==="tab" && document.activeElement.getAttribute("aria-selected")==="true" && document.activeElement.textContent.includes("Example dashboard")',
        ),
      );
      await workspace.executeJavaScript(
        'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))',
      );
      await until(() =>
        workspace.executeJavaScript(
          'document.activeElement?.getAttribute("role")==="tab" && document.activeElement.getAttribute("aria-selected")==="true" && document.activeElement.textContent.includes("Ordinary App")',
        ),
      );
      await evaluate('selectReference()');
      checkpoint('MCP history preservation');
      await evaluate('pin();pin();replaceHistory(true)');
      assert.equal(await evaluate('manager.entries.length'), 1);
      for (let i = 0; i < 3; i++) {
        await evaluate('selectNormal()');
        await new Promise(resolve => setTimeout(resolve, 100));
        await evaluate('selectReference()');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(await inline.executeJavaScript('window.documentInstance'), instance);
      assert.equal(
        await inline.executeJavaScript('document.querySelector("input").value'),
        'unsaved main App',
      );
      assert.deepEqual(
        await inline.executeJavaScript(
          '[document.querySelector("input").selectionStart,document.querySelector("input").selectionEnd]',
        ),
        [2, 7],
      );
      assert.equal(await normal.executeJavaScript('window.documentInstance'), normalInstance);
      assert.equal(
        await normal.executeJavaScript('document.querySelector("input").value'),
        'unsaved workspace App',
      );
      assert.equal(await evaluate('calls.length'), calls);
      assert.equal(manager.prepare().generation, generation);
      // Host reference close only unpins, including while its message is absent.
      await workspace.executeJavaScript(
        `document.querySelector('button[title="Move back to message"]').click()`,
      );
      await until(() => evaluate('!manager.entries[0].pinned'));
      await until(() =>
        workspace.executeJavaScript(
          'document.activeElement?.getAttribute("role")==="tab" && document.activeElement.textContent.includes("Ordinary App")',
        ),
      );
      assert.equal(await inline.executeJavaScript('document.body.dataset.closed ?? null'), null);
      await evaluate('replaceHistory()');
      await until(() =>
        evaluate('manager.entries[0].primary?.isConnected && !manager.entries[0].returnPending'),
      );
      await assertSurfaceParent(appSurfaceId, 'main', appCarrier);
      assert.deepEqual(await evaluate('verifyNativeIdentity("app")'), {
        objects: true,
        authority: true,
        descriptor: true,
      });
      assert.equal(await inline.executeJavaScript('window.documentInstance'), instance);
      await evaluate('pin();switchSession(false)');
      await new Promise(resolve => setTimeout(resolve, 100));
      await inline.executeJavaScript('document.querySelector("button").click()');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate('calls.filter(c=>c.method==="mcp.app.callTool").length'), 0);
      await evaluate('switchSession(true)');
      await until(() => evaluate('manager.entries[0].view.context.isCurrent()'));
      await until(() =>
        workspace.executeJavaScript(
          '!!document.querySelector("[role=tab][aria-selected=true]")?.textContent.includes("Example dashboard")',
        ),
      );
      await until(() => manager.view.getVisible());
      await until(() =>
        inline.executeJavaScript(
          'document.querySelector("input").getBoundingClientRect().width > 100 && document.querySelector("input").checkVisibility()',
        ),
      );
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      assert.equal(await inline.executeJavaScript('window.documentInstance'), instance);
      assert.equal(await evaluate('calls.filter(c=>c.method==="mcp.app.view").length'), reads);
      await evaluate('discoverIcons()');
      await until(() =>
        evaluate(`(() => {
        const image=document.querySelector('mcp-app-anchor').shadowRoot.querySelector('.icon-light img');
        return image?.complete&&image.naturalWidth>0;
      })()`),
      );
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      // Exercise the production React/Lit/widget subscription cycle alongside
      // the real MCP App and native workspace, including idle layout observers.
      await evaluate('openWidget()');
      checkpoint('composite widget boot');
      const widgetGuest = await until(() =>
        webContents
          .getAllWebContents()
          .find(contents => contents.getURL().includes('/widget-viewer.html?')),
      );
      const widget = await until(async () => {
        for (const frame of widgetGuest.mainFrame.framesInSubtree) {
          try {
            if (await frame.executeJavaScript('document.body?.dataset.widgetReady==="true"'))
              return frame;
          } catch {}
        }
      });
      await until(() =>
        evaluate('widgetManager.entries[0]?.view.ready&&widgetManager.entries[0].visible'),
      );
      const widgetIdentity = await widget.executeJavaScript(
        'document.querySelector("input").value="unsaved widget";window.widgetDocumentInstance',
      );
      const widgetSurface = await until(async () => {
        const state = await evaluate('surfaceStates().widget');
        return state?.ready && state.update?.visible ? state : false;
      });
      const widgetSurfaceId = new URL(widgetSurface.documentUrl).searchParams.get('surface');
      assert.ok(widgetSurfaceId, 'The first widget guest must load directly in its stable carrier');
      const widgetCarrier = webContents
        .getAllWebContents()
        .find(contents => contents.getURL() === widgetSurface.documentUrl);
      assert.ok(widgetCarrier);
      assert.equal(await widgetCarrier.executeJavaScript('typeof window.electron'), 'undefined');
      const assertWidgetCardStyle = async pinned => {
        const style = await widgetCarrier.executeJavaScript(`(async()=>{
          const view=document.querySelector('justdo-native-widget');await view.updateComplete;
          const dialog=view.shadowRoot.querySelector('dialog'),style=getComputedStyle(dialog);
          return {border:style.borderTopWidth,radius:style.borderTopLeftRadius,overflow:style.overflow,
            width:dialog.getBoundingClientRect().width,hostWidth:view.getBoundingClientRect().width};
        })()`);
        assert.equal(
          style.border,
          pinned ? '0px' : '1px',
          'Page resets must not erase the message card border',
        );
        assert.equal(style.radius, pinned ? '0px' : '14px');
        assert.equal(style.overflow, 'hidden');
        assert.ok(
          Math.abs(style.width - style.hostWidth) <= 1,
          'The card boundary must fit its measured host',
        );
      };
      await assertWidgetCardStyle(false);
      fs.writeFileSync(
        path.join(output, 'widget-inline-card.png'),
        (await widgetCarrier.capturePage()).toPNG(),
      );
      let appValue = 'unsaved main App';
      let widgetValue = 'unsaved widget';
      await evaluate('captureNativeIdentity("widget")');
      const assertCompositeRetained = async () => {
        assert.equal(await inline.executeJavaScript('window.documentInstance'), instance);
        assert.equal(
          await inline.executeJavaScript('document.querySelector("input").value'),
          appValue,
        );
        assert.equal(
          await widget.executeJavaScript('window.widgetDocumentInstance'),
          widgetIdentity,
        );
        assert.equal(
          await widget.executeJavaScript('document.querySelector("input").value'),
          widgetValue,
        );
        assert.equal(
          await evaluate('calls.filter(c=>c.method==="canvas.document.view").length'),
          1,
        );
        assert.equal(await evaluate('calls.filter(c=>c.method==="mcp.app.view").length'), reads);
        assert.equal(webContents.fromId(widgetGuest.id), widgetGuest);
        assert.equal(webContents.fromId(appCarrier.id), appCarrier);
        assert.equal(webContents.fromId(widgetCarrier.id), widgetCarrier);
        assert.equal(await evaluate('surfaceStates().app.documentUrl'), appSurface.documentUrl);
        assert.equal(
          await evaluate('surfaceStates().widget.documentUrl'),
          widgetSurface.documentUrl,
        );
        for (const kind of ['app', 'widget'])
          assert.deepEqual(await evaluate(`verifyNativeIdentity(${JSON.stringify(kind)})`), {
            objects: true,
            authority: true,
            descriptor: true,
          });
      };
      const assertCompositeIdle = async () => {
        let quiet = 0;
        let previous = await evaluate('({...compositeCounts})');
        for (let attempt = 0; attempt < 20 && quiet < 4; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          const current = await evaluate('({...compositeCounts})');
          quiet = Object.keys(previous).every(key => previous[key] === current[key])
            ? quiet + 1
            : 0;
          previous = current;
        }
        assert.equal(quiet, 4, 'Composite native surfaces must reach a bounded idle state');
        const before = await evaluate('({...compositeCounts})');
        await new Promise(resolve => setTimeout(resolve, 400));
        const after = await evaluate('({...compositeCounts})');
        assert.equal(after.renders, before.renders, 'The React/Lit capture cycle must settle');
        for (const key of ['appLayouts', 'widgetLayouts'])
          assert.ok(
            after[key] - before[key] <= 1,
            `Stable ${key} must stop scheduling: ${JSON.stringify({ before, after })}`,
          );
      };
      await assertCompositeIdle();
      checkpoint('composite widget pin cycles');
      for (let index = 0; index < 3; index++) {
        await evaluate('pinWidget()');
        await until(() =>
          evaluate(
            'widgetManager.entries[0].pinned&&widgetManager.entries[0].visible&&widgetManager.entries[0].view.fillContainer',
          ),
        );
        await assertCompositeRetained();
        await assertSurfaceParent(widgetSurfaceId, 'workspace', widgetCarrier);
        await assertWidgetCardStyle(true);
        await assertCompositeIdle();
        await evaluate('unpinWidget();selectReference()');
        await until(() =>
          evaluate(
            '!widgetManager.entries[0].pinned&&widgetManager.entries[0].visible&&!widgetManager.entries[0].view.fillContainer',
          ),
        );
        await assertCompositeRetained();
        await assertSurfaceParent(widgetSurfaceId, 'main', widgetCarrier);
        await assertWidgetCardStyle(false);
      }
      // Click the actual reference toolbar rather than the fixture/native API.
      checkpoint('composite detach toolbar');
      await evaluate('pinWidget()');
      await until(() =>
        workspace.executeJavaScript(
          `!!document.querySelector('button[title="Open sidebar in a separate window"]')`,
        ),
      );
      await workspace.executeJavaScript(
        `document.querySelector('button[title="Open sidebar in a separate window"]').click()`,
      );
      await until(() => manager.prepare().detached);
      assert.ok(manager.shell.contentView.children.includes(manager.root));
      await until(() =>
        workspace.executeJavaScript(
          `!!document.querySelector('button[title="Return to main window"]')`,
        ),
      );
      await assertCompositeRetained();
      await assertSurfaceParent(widgetSurfaceId, 'workspace', widgetCarrier);
      await until(async () => {
        const state = await evaluate('surfaceStates().widget');
        return state.update?.target === 'workspace' && state.update.visible;
      });
      assert.equal(
        await evaluate('widgetManager.entries[0].sidebar.ownerDocument.URL'),
        workspace.getURL(),
      );
      checkpoint('detached widget typing');
      manager.shell.focus();
      await until(() => manager.shell.isFocused(), 'detached native window focused for keyboard');
      await widgetCarrier.executeJavaScript(
        'document.querySelector("justdo-native-widget").shadowRoot.querySelector("webview").focus()',
      );
      checkpoint('detached widget host focused');
      await widget.executeJavaScript(
        'document.querySelector("input").focus();document.querySelector("input").setSelectionRange(14,14)',
      );
      checkpoint('detached widget input focused');
      assert.ok(await widget.executeJavaScript('document.hasFocus()'));
      // Chromium input targets the focused document directly. Electron's guest
      // injection APIs additionally consult its original owner BrowserWindow.
      widgetGuest.debugger.attach('1.3');
      try {
        await widgetGuest.debugger.sendCommand('Input.insertText', { text: ' + detached' });
      } finally {
        widgetGuest.debugger.detach();
      }
      checkpoint('detached widget text inserted');
      widgetValue += ' + detached';
      await until(
        async () =>
          (await widget.executeJavaScript('document.querySelector("input").value')) === widgetValue,
        'native widget text input in detached window',
      );
      await assertCompositeRetained();
      checkpoint('detached App tab');
      await evaluate('selectReference()');
      await until(async () => {
        const states = await evaluate('surfaceStates()');
        return states.app.update?.visible && !states.widget.update?.visible;
      });
      await assertSurfaceParent(appSurfaceId, 'workspace', appCarrier);
      checkpoint('detached App typing');
      appCarrier.focus();
      await until(() => appCarrier.isFocused(), 'selected App carrier receives native focus');
      await appCarrier.executeJavaScript(
        'document.querySelector("mcp-app-view").shadowRoot.querySelector("iframe").focus()',
      );
      await inline.executeJavaScript(
        'document.querySelector("input").focus();document.querySelector("input").setSelectionRange(16,16)',
      );
      assert.ok(await inline.executeJavaScript('document.hasFocus()'));
      appCarrier.debugger.attach('1.3');
      try {
        await appCarrier.debugger.sendCommand('Input.insertText', { text: ' + detached' });
      } finally {
        appCarrier.debugger.detach();
      }
      appValue += ' + detached';
      await until(
        async () =>
          (await inline.executeJavaScript('document.querySelector("input").value')) === appValue,
        'native App text input in detached window',
      );
      await assertCompositeRetained();
      await evaluate('selectWidget()');
      checkpoint('composite dock toolbar');
      await until(async () => (await evaluate('surfaceStates().widget')).update?.visible);
      await workspace.executeJavaScript(
        `document.querySelector('button[title="Return to main window"]').click()`,
      );
      await until(() => !manager.prepare().detached);
      assert.ok(win.contentView.children.includes(manager.root));
      assert.equal(manager.prepare().generation, generation);
      await until(() => evaluate('widgetManager.entries[0].visible'));
      await assertCompositeRetained();
      await assertCompositeIdle();
      const nativeReads = await evaluate(
        '({ app: calls.filter(c=>c.method==="mcp.app.view"&&c.params.viewId==="mcp-app-inline"), widget: calls.filter(c=>c.method==="canvas.document.view") })',
      );
      assert.deepEqual(
        nativeReads.app.map(call => call.params),
        [{ sessionKey: 'agent:a:reference', agentId: 'a', viewId: 'mcp-app-inline' }],
      );
      assert.deepEqual(
        nativeReads.widget.map(call => call.params),
        [{ docId: 'composite-widget' }],
      );
      fs.writeFileSync(
        path.join(output, 'composite-result.json'),
        JSON.stringify(
          {
            counts: await evaluate('({...compositeCounts})'),
            widgetReads: 1,
            appReads: 1,
            nativeIdentityPreserved: true,
            sameWidgetDocument: true,
            sameMcpDocument: true,
            inputsPreserved: true,
            toolbarDetachedAndDocked: true,
            carrierIds: { app: appSurfaceId, widget: widgetSurfaceId },
            detachedTypedInput: true,
            detachedTabSwitchPreserved: true,
            idleSettled: true,
          },
          null,
          2,
        ),
      );
      assert.equal(errors.length, 0, errors.join('\n'));
      clearTimeout(deadline);
      fs.writeFileSync(
        path.join(output, 'reference.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      console.log(
        'MCP_APP_REFERENCE_SMOKE_PASSED: single-row 52px cards at 320px in en/zh/light/dark, plugin icons in cards and all three Tab types, same App/document/selection, real native workspace retention, multi-anchor contexts, SDK fullscreen, overlay RPC blocking, cross-document keyboard/close focus, history removal, idempotent pin, unpin, exact session pause/resume, no business replay; composite production ChatMessageDisplay/widget/MCP references settle idle with one widget read, preserve both inputs/documents and detach/dock through actual toolbar',
      );
      manager.dispose?.();
      win.destroy();
      server.close();
      sandbox.close();
      app.exit(0);
    })
    .catch(error => {
      console.error(error);
      app.exit(1);
    });
}
