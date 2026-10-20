'use strict';

// Real Chromium + the locked native sandbox shell + the standard App SDK.
// Uses an isolated profile and an in-memory Gateway facade; never starts the user's Gateway.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.agent-tasks/mcp-apps/ui-smoke');
fs.mkdirSync(output, { recursive: true });

if (!process.versions.electron) {
  const esbuild = require('esbuild');
  const options = {
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
    minify: true,
    logLevel: 'silent',
  };
  esbuild.buildSync({
    ...options,
    entryPoints: [path.join(__dirname, 'ui-smoke-host.ts')],
    outfile: path.join(output, 'host.js'),
    alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') },
  });
  esbuild.buildSync({
    ...options,
    outfile: path.join(output, 'workspace.js'),
    stdin: {
      resolveDir: root,
      contents: `import {installMcpAppFrameMessaging} from './src/renderer/libs/openclaw-chat/components/mcp-app/transport';installMcpAppFrameMessaging();`,
    },
  });
  const app = esbuild.buildSync({
    ...options,
    write: false,
    stdin: {
      resolveDir: root,
      contents: `
    import { App } from '@modelcontextprotocol/ext-apps';
    const app = new App({name:'Fixture',version:'1'}, {}, {autoResize:false});
    const contextChanged = () => { const context = app.getHostContext(); document.body.dataset.theme = context.theme; document.body.dataset.background = context.styles?.variables?.['--color-background-primary']; };
    app.onhostcontextchanged = contextChanged;
    app.onteardown = async () => { document.body.dataset.tornDown = 'true'; await new Promise(resolve => setTimeout(resolve, 250)); return {}; };
    app.ontoolresult = () => document.body.dataset.seed = 'received';
    document.querySelector('#call').onclick = async () => {
      const result = await app.callServerTool({name:'echo',arguments:{value:'clicked'}});
      document.querySelector('#result').textContent = result.content[0].text;
    };
    document.querySelector('#message').onclick = async () => {
      const result = await app.sendMessage({role:'user',content:[{type:'text',text:'Suggested follow-up'}]});
      document.body.dataset.messageResult = result.isError ? 'declined' : 'accepted';
    };
    await app.connect();
    contextChanged();
    document.body.dataset.initialized = 'true';
  `,
    },
  });
  fs.writeFileSync(
    path.join(output, 'app.html'),
    '<input id="draft" aria-label="Draft"><button id="call">Call tool</button><button id="message">Suggest follow-up</button><output id="result"></output><script type="module">' +
      app.outputFiles[0].text.replaceAll('</script', '<\\/script') +
      '</script>',
  );
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    timeout: 180000,
    windowsHide: true,
  });
  if (result.error || result.signal)
    console.error('Electron fixture launch failed:', {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    });
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(output, 'profile'));
  const servers = [];
  let win;
  const finish = code => {
    win?.destroy();
    for (const server of servers) server.close();
    app.exit(code);
  };
  app
    .whenReady()
    .then(async () => {
      const candidates = [
        path.join(root, 'vendor/openclaw-runtime/current/dist'),
        path.join(root, '.agent-tasks/mcp-apps/native/package/dist'),
      ];
      const dist = candidates.find(
        dir =>
          fs.existsSync(dir) &&
          fs.readdirSync(dir).some(file => /^sandbox-host-.*\.mjs$/.test(file)),
      );
      if (!dist) throw new Error('Build the locked OpenClaw runtime first');
      const moduleFile = fs.readdirSync(dist).find(file => /^sandbox-host-.*\.mjs$/.test(file));
      const native = await import(pathToFileURL(path.join(dist, moduleFile)).href);
      const document = native.n();
      const sandboxPath = native.r();
      const sandbox = http.createServer((_req, res) => {
        res.writeHead(200, document.headers);
        res.end(document.html);
      });
      servers.push(sandbox);
      await new Promise(resolve => sandbox.listen(0, '127.0.0.1', resolve));
      const payload = {
        html: fs.readFileSync(path.join(output, 'app.html'), 'utf8'),
        sandboxPort: sandbox.address().port,
        sandboxUrl: sandboxPath,
      };
      const host = http.createServer((req, res) => {
        if (req.url === '/host.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(fs.readFileSync(path.join(output, 'host.js')));
          return;
        }
        if (req.url === '/workspace.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(fs.readFileSync(path.join(output, 'workspace.js')));
          return;
        }
        if (req.url === '/workspace') {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<html class="dark" style="--justdo-background:#123456;--justdo-text-primary:#fafafa"><body><script type="module" src="/workspace.js"></script></body></html>',
          );
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<html lang="en" class="dark" style="--justdo-background:#123456;--justdo-text-primary:#fafafa"><head><style>body{font:14px system-ui;margin:20px}mcp-app-view{display:block}</style></head><body><script>window.fixturePayload=' +
            JSON.stringify(payload).replaceAll('<', '\\u003c') +
            '</script><script type="module" src="/host.js"></script></body></html>',
        );
      });
      servers.push(host);
      await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
      win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      const errors = [];
      win.webContents.on('console-message', event => {
        if (event.level === 'error' || event.level === 'warning') errors.push(event.message);
      });
      await win.loadURL(
        'http://127.0.0.1:' +
          host.address().port +
          (process.argv.includes('--workspace') ? '/?workspace=1' : '/'),
      );
      const until = async operation => {
        for (let attempt = 0; attempt < 150; attempt++) {
          const value = await operation();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const state = await win.webContents.executeJavaScript(
          'JSON.stringify({error:window.fixtureView?.error,loading:window.fixtureView?.loading,visibility:document.visibilityState})',
        );
        throw new Error('UI probe timed out: ' + state + ': ' + JSON.stringify(errors));
      };
      await until(() => win.webContents.executeJavaScript('Boolean(window.fixtureReady)'));
      const inner = await until(async () => {
        for (const frame of win.webContents.mainFrame.framesInSubtree) {
          try {
            if (
              await frame.executeJavaScript(
                'Boolean(document.querySelector("#draft") && document.body.dataset.initialized)',
              )
            )
              return frame;
          } catch {}
        }
      });
      await until(() => inner.executeJavaScript('document.body.dataset.seed === "received"'));
      await until(() =>
        inner.executeJavaScript(
          'document.body.dataset.theme === "dark" && document.body.dataset.background === "#123456"',
        ),
      );
      await win.webContents.executeJavaScript(
        'window.fixtureView.ownerDocument.documentElement.classList.remove("dark");window.fixtureView.ownerDocument.documentElement.style.setProperty("--justdo-background", "#abcdef");true',
      );
      await until(() =>
        inner.executeJavaScript(
          'document.body.dataset.theme === "light" && document.body.dataset.background === "#abcdef"',
        ),
      );
      await win.webContents.executeJavaScript(
        'window.postMessage({jsonrpc:"2.0",id:"forged",method:"tools/call",params:{name:"echo"}},location.origin);true',
      );
      await inner.executeJavaScript(
        'document.querySelector("#draft").value="unsaved selection";document.querySelector("#call").click();true',
      );
      await until(() =>
        inner.executeJavaScript('document.querySelector("#result").textContent === "echo:clicked"'),
      );
      await win.webContents.executeJavaScript(
        'window.fixtureView.shadowRoot.querySelector("header button").click();true',
      );
      await until(() => win.webContents.executeJavaScript('window.fixtureView.expanded === true'));
      await win.webContents.executeJavaScript(
        '(async()=>{await window.fixtureView.updateComplete;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true})()',
      );
      const retained = await inner.executeJavaScript(
        'document.querySelector("#draft").value === "unsaved selection"',
      );
      if (!retained) throw new Error('Expanded App lost its draft');
      await win.webContents.executeJavaScript(
        'window.fixtureView.shadowRoot.querySelector("header button").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,composed:true}));true',
      );
      await until(() => win.webContents.executeJavaScript('!window.fixtureView.expanded'));
      await win.webContents.executeJavaScript(
        'window.fixtureView.shadowRoot.querySelector("header button").click();true',
      );
      await until(() => win.webContents.executeJavaScript('window.fixtureView.expanded === true'));
      fs.writeFileSync(
        path.join(output, 'expanded.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      const viewReadsBeforeReturn = await win.webContents.executeJavaScript(
        'window.fixtureCalls.filter(call => call.method === "mcp.app.view").length',
      );
      await win.webContents.executeJavaScript(
        'window.fixtureOriginalFrame=window.fixtureView.shadowRoot.querySelector("iframe");window.fixtureView.shadowRoot.querySelector("header button:last-of-type").click();true',
      );
      await until(() => win.webContents.executeJavaScript('!window.fixtureView.expanded'));
      const returned = await win.webContents.executeJavaScript(
        '!window.fixtureView.closed && window.fixtureView.shadowRoot.querySelector("iframe") === window.fixtureOriginalFrame && window.fixtureOriginalFrame.isConnected',
      );
      if (!returned) throw new Error('Closing the expanded presentation destroyed the inline App');
      if (
        !(await inner.executeJavaScript(
          'document.querySelector("#draft").value === "unsaved selection" && document.body.dataset.tornDown !== "true"',
        ))
      )
        throw new Error('Returning from expansion lost the draft or tore down its App');
      if (
        (await win.webContents.executeJavaScript(
          'window.fixtureCalls.filter(call => call.method === "mcp.app.view").length',
        )) !== viewReadsBeforeReturn
      )
        throw new Error('Returning from expansion reloaded the native App');
      await win.webContents.executeJavaScript(
        'window.fixtureView.shadowRoot.querySelector("header button").click();true',
      );
      await until(() => win.webContents.executeJavaScript('window.fixtureView.expanded === true'));
      await inner.executeJavaScript('document.querySelector("#message").click();true');
      await until(() =>
        win.webContents.executeJavaScript('Boolean(window.fixtureView.confirmation)'),
      );
      await win.webContents.executeJavaScript(
        'window.fixtureClosing=window.fixtureView.closeApp();true',
      );
      await until(() => inner.executeJavaScript('document.body.dataset.tornDown === "true"'));
      await win.webContents.executeJavaScript('window.fixtureClosing');
      const collapsed = await win.webContents.executeJavaScript(
        '!window.fixtureView.expanded && !window.fixtureView.hasAttribute("expanded") && window.fixtureView.ownerDocument.defaultView.getComputedStyle(window.fixtureView).position !== "fixed"',
      );
      if (!collapsed) throw new Error('Closing an expanded App left a blocking overlay');
      if (await win.webContents.executeJavaScript('Boolean(window.fixtureView.confirmation)'))
        throw new Error('Closing an App retained a pending draft confirmation');
      await win.webContents.executeJavaScript(
        'window.fixtureView.shadowRoot.querySelector("[data-action=reopen]").click();true',
      );
      await until(() =>
        win.webContents.executeJavaScript(
          '!window.fixtureView.closed && !window.fixtureView.loading && !window.fixtureView.error && Boolean(window.fixtureView.shadowRoot.querySelector("iframe"))',
        ),
      );
      const reopened = await until(async () => {
        for (const frame of win.webContents.mainFrame.framesInSubtree) {
          try {
            if (
              await frame.executeJavaScript(
                'document.body.dataset.initialized === "true" && document.body.dataset.seed === "received"',
              )
            )
              return frame;
          } catch {
            /* Await the reopened native sandbox. */
          }
        }
      });
      if (!reopened) throw new Error('Reopening a closed App did not restore its native interface');
      if (
        (await win.webContents.executeJavaScript(
          'window.fixtureCalls.filter(call => call.method === "mcp.app.view").length',
        )) !==
        viewReadsBeforeReturn + 1
      )
        throw new Error('Reopening must read the native view exactly once');
      await win.webContents.executeJavaScript(
        'window.fixtureOriginalFrame=window.fixtureView.shadowRoot.querySelector("iframe");window.fixtureView.fillContainer=true;true',
      );
      await until(() =>
        win.webContents.executeJavaScript(
          'getComputedStyle(window.fixtureView.shadowRoot.querySelector("header")).display === "none" && window.fixtureView.shadowRoot.querySelector("iframe") === window.fixtureOriginalFrame',
        ),
      );
      const readsBeforeSwitch = await win.webContents.executeJavaScript(
        'window.fixtureCalls.filter(call => call.method === "mcp.app.view").length',
      );
      await reopened.executeJavaScript(
        'document.querySelector("#draft").value="edited before switching";true',
      );
      await win.webContents.executeJavaScript('window.fixtureSwitchSession(false);true');
      await until(() =>
        win.webContents.executeJavaScript(
          '!window.fixtureView.context.isCurrent() && window.fixtureView.shadowRoot.querySelector("iframe") === window.fixtureOriginalFrame',
        ),
      );
      await win.webContents.executeJavaScript('window.fixtureView.resume();true');
      if (
        (await win.webContents.executeJavaScript(
          'window.fixtureCalls.filter(call => call.method === "mcp.app.view").length',
        )) !== readsBeforeSwitch
      )
        throw new Error('A background App read its view before its session was ready');
      await win.webContents.executeJavaScript('window.fixtureSwitchSession(true);true');
      await until(() =>
        win.webContents.executeJavaScript(
          '!window.fixtureView.loading && !window.fixtureView.error && Boolean(window.fixtureView.shadowRoot.querySelector("iframe"))',
        ),
      );
      await until(async () => {
        for (const frame of win.webContents.mainFrame.framesInSubtree) {
          try {
            if (
              await frame.executeJavaScript(
                'document.body.dataset.initialized === "true" && document.body.dataset.seed === "received"',
              )
            )
              return true;
          } catch {}
        }
      });
      if (
        (await win.webContents.executeJavaScript(
          'window.fixtureCalls.filter(call => call.method === "mcp.app.view").length',
        )) !== readsBeforeSwitch
      )
        throw new Error(
          'Returning to the App must retain its original iframe without reading the view',
        );
      if (
        !(await reopened.executeJavaScript(
          'document.querySelector("#draft").value === "edited before switching"',
        ))
      )
        throw new Error('Switching sessions lost the editor input');
      await win.webContents.executeJavaScript('window.fixtureView.closeApp();true');
      await until(() =>
        win.webContents.executeJavaScript(
          'window.fixtureView.closed && !window.fixtureView.shadowRoot.querySelector("iframe") && Boolean(window.fixtureView.shadowRoot.querySelector("[data-action=reopen]")) && getComputedStyle(window.fixtureView.shadowRoot.querySelector("header")).display !== "none"',
        ),
      );
      const receipts = await win.webContents.executeJavaScript('window.fixtureCalls');
      if (
        receipts.filter(item => item.method === 'mcp.app.callTool').length !== 1 ||
        receipts.some(
          item => item.method === 'mcp.app.release' || item.method === 'mcp.app.cancel',
        ) ||
        receipts.some(item => item.method === 'draft')
      )
        throw new Error('Unexpected operation receipts');
      fs.writeFileSync(
        path.join(output, 'result.json'),
        JSON.stringify(
          {
            sdkHandshake: true,
            initialResult: true,
            toolCalls: 1,
            sameDocumentExpansionRetainedDraft: retained,
            keyboardCollapse: true,
            expandedCloseReturnsInline: returned,
            teardown: true,
            closeRemovesOverlay: collapsed,
            closeDeclinesPendingDraft: true,
            closedAppCanReopen: true,
            reopenedAppCanClose: true,
            workspaceHidesDuplicateHeader: true,
            workspaceClosedAppRetainsReopen: true,
            sessionReturnRetainsEditorAndInput: true,
            themeUpdates: true,
            nativeLifecycle: true,
          },
          null,
          2,
        ),
      );
      console.log(
        'MCP Apps Chromium smoke passed: handshake, initial result, tool call, retained draft, native lifecycle',
      );
      finish(0);
    })
    .catch(error => {
      console.error(error);
      finish(1);
    });
}
