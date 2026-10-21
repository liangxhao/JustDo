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
        "import { installMcpAppFrameMessaging } from './src/renderer/libs/openclaw-chat/components/mcp-app/transport';installMcpAppFrameMessaging();const root=document.createElement('div');root.id='workspace-root';document.body.append(root);",
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
        "export * from './src/main/core/window/workspaceWindowManager';export * from './src/main/ipc/app/workspaceWindow';",
      resolveDir: root,
    },
    outfile: path.join(output, 'manager.cjs'),
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
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(output, 'profile'));
  app
    .whenReady()
    .then(async () => {
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
      const server = http.createServer((req, res) => {
        const file = req.url.split('?')[0].slice(1);
        if (file === 'workspace') {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<html><style>html,body,#workspace-root{margin:0;height:100%;overflow:hidden}</style><body><script type="module" src="/workspace.js"></script></body></html>',
          );
        } else if (['host.js', 'workspace.js', 'host.css', 'layout.css'].includes(file)) {
          res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
          res.end(fs.readFileSync(path.join(output, file)));
        } else {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<html lang="en"><head><style>.cowork-workspace-header{height:38px;min-height:38px}</style><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/host.css"></head><body><div id="root"></div><script>window.fixturePayload=' +
              JSON.stringify(payload).replaceAll('<', '\\u003c') +
              '</script><script type="module" src="/host.js"></script></body></html>',
          );
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const { WorkspaceWindowManager, registerWorkspaceWindowHandlers } = require(
        path.join(output, 'manager.cjs'),
      );
      registerWorkspaceWindowHandlers();
      const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 850,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
          preload: path.join(output, 'preload.cjs'),
        },
      });
      let workspace;
      const manager = new WorkspaceWindowManager(win, {
        url: `${base}/workspace`,
        getBackgroundColor: () => '#ffffff',
        isMac: false,
        isWindows: true,
        isQuitting: () => false,
        showSystemMenu: () => {},
        openExternal: () => {},
        configureHost: contents => {
          workspace = contents;
        },
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
      const evaluate = script => win.webContents.executeJavaScript(script);
      const until = async operation => {
        for (let i = 0; i < 200; i++) {
          const value = await operation();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(
          'Reference probe timed out: ' +
            JSON.stringify(errors) +
            ' ' +
            (await evaluate(
              'JSON.stringify({selected:currentSelected,entries:window.manager?.entries.map(e=>({id:e.id,error:e.view.error,loading:e.view.loading})),panels:[...document.querySelectorAll("aside")].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),hidden:e.getAttribute("aria-hidden")})),focus:document.activeElement?.outerHTML?.slice(0,180)})',
            )),
        );
      };
      const findFrame = async (contents, id) => {
        if (!contents) return;
        for (const frame of contents.mainFrame.framesInSubtree) {
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
      const inline = await until(() => findFrame(win.webContents, 'mcp-app-inline'));
      await until(
        async () =>
          !!workspace &&
          (await workspace.executeJavaScript('!!window.registerMcpAppFrameTransport')),
      );
      const normal = await until(() => findFrame(workspace, 'mcp-app-ordinary'));
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
        evaluate(
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
        evaluate(
          'document.querySelector("#cowork-display-panel")?.dataset.workspaceFullscreen==="true"',
        ),
      );
      assert.equal(
        (await inline.executeJavaScript('fixtureApp.requestDisplayMode({mode:"inline"})')).mode,
        'inline',
      );
      await until(() =>
        evaluate(
          'document.querySelector("#cowork-display-panel")?.dataset.workspaceFullscreen==="false"',
        ),
      );
      // Modal/menu occlusion blocks standard tool RPC as well as pointer input.
      for (const kind of ['modal', 'menu', 'listbox']) {
        await evaluate(`overlay(${JSON.stringify(kind)})`);
        await until(() => evaluate('manager.entries[0].layer.style.display==="none"'));
        const result = await inline.executeJavaScript(
          'fixtureApp.callServerTool({name:"echo",arguments:{}}).then(()=>"allowed",()=>"denied")',
        );
        assert.equal(result, 'denied', kind);
        await evaluate('overlay()');
        await until(() => evaluate('manager.entries[0].layer.style.display!=="none"'));
      }
      // Arrow navigation transfers focus between the native workspace and main Document.
      await evaluate('selectNormal()');
      await until(() => manager.view.getVisible());
      await workspace.executeJavaScript(
        'document.querySelector("[role=tab][aria-selected=true]").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))',
      );
      await until(() =>
        evaluate(
          'document.activeElement?.getAttribute("role")==="tab" && document.activeElement.getAttribute("aria-selected")==="true" && document.activeElement.textContent.includes("Example dashboard")',
        ),
      );
      await evaluate(
        'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))',
      );
      await until(() =>
        workspace.executeJavaScript(
          'document.activeElement?.getAttribute("role")==="tab" && document.activeElement.getAttribute("aria-selected")==="true" && document.activeElement.textContent.includes("Ordinary App")',
        ),
      );
      await evaluate('selectReference()');
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
      await evaluate(`document.querySelector('button[title="Move back to message"]').click()`);
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
      assert.equal(await inline.executeJavaScript('window.documentInstance'), instance);
      await evaluate('pin();switchSession(false)');
      await new Promise(resolve => setTimeout(resolve, 100));
      await inline.executeJavaScript('document.querySelector("button").click()');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate('calls.filter(c=>c.method==="mcp.app.callTool").length'), 0);
      await evaluate('switchSession(true)');
      await until(() => evaluate('manager.entries[0].view.context.isCurrent()'));
      await until(() =>
        evaluate(
          '!!document.querySelector("[role=tab][aria-selected=true]")?.textContent.includes("Example dashboard") && getComputedStyle(manager.entries[0].layer).display!=="none" && manager.entries[0].layer.getBoundingClientRect().width>300',
        ),
      );
      await until(() => !manager.view.getVisible());
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
      assert.equal(errors.length, 0, errors.join('\n'));
      fs.writeFileSync(
        path.join(output, 'reference.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      console.log(
        'MCP_APP_REFERENCE_SMOKE_PASSED: same App/document/selection, real native workspace retention, multi-anchor contexts, SDK fullscreen, overlay RPC blocking, cross-document keyboard/close focus, history removal, idempotent pin, unpin, exact session pause/resume, no business replay',
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
