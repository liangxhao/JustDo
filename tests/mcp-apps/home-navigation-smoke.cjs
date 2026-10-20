'use strict';

// Isolated Chromium, real home rendering, MCP workspace/session/view classes,
// authenticated WebSocket framing and the locked native sandbox. No user Gateway.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const baseline = process.argv.includes('--baseline');
const output = path.join(
  root,
  '.agent-tasks/mcp-apps/home-navigation',
  baseline ? 'baseline' : 'current',
);
fs.mkdirSync(output, { recursive: true });

if (!process.versions.electron) {
  (async () => {
    const esbuild = require('esbuild');
    const peripheral = new Set([
      'CoworkPromptInput.tsx',
      'DisplayPanelLauncher.tsx',
      'NewDisplayTabButton.tsx',
      'FilePreviewDrawer.tsx',
      'UnsupportedFilePreview.tsx',
      'WorkspaceFilesPanel.tsx',
      'CoworkPet.tsx',
      'coworkService.ts',
      'WindowHeader.tsx',
      'FilePathBreadcrumbBar.tsx',
    ]);
    const plugins = [
      {
        name: 'isolate-unrelated-ui',
        setup(build) {
          build.onLoad({ filter: /\.[jt]sx?$/ }, args => {
            if (peripheral.has(path.basename(args.path)))
              return {
                contents:
                  'const Empty=()=>null;export default Empty;export const CoworkPet=Empty;export const coworkService={updateConfig:async()=>true};',
                loader: 'js',
              };
            if (
              baseline &&
              args.path.replaceAll('\\', '/').endsWith('/chat/CoworkHomeWorkspace.tsx')
            ) {
              const source = fs.readFileSync(args.path, 'utf8');
              const container =
                /^[ \t]*<div key="mcp-app-panels" className="contents">\r?\n[ \t]*\{mcpAppTabs\.panels\(activeDisplayTabId\)\}\r?\n[ \t]*<\/div>\r?\n/gm;
              const recording =
                /^[ \t]*\{recordingReviewTabs\.panels\(activeDisplayTabId\)\}\r?$/gm;
              const matches = [...source.matchAll(container)];
              if (matches.length !== 1 || [...source.matchAll(recording)].length !== 1)
                throw new Error('The home layout changed; update the negative control explicitly');
              // Reintroduce the prior sibling order in memory. Never rewrite the
              // checkout or rely on HEAD remaining at a particular historical commit.
              const contents = source
                .replace(container, '')
                .replace(recording, line => line + '\n' + matches[0][0].trimEnd());
              return { contents, loader: 'tsx', resolveDir: path.dirname(args.path) };
            }
          });
        },
      },
    ];
    const options = {
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'chrome140',
      minify: true,
      logLevel: 'silent',
    };
    await esbuild.build({
      ...options,
      entryPoints: [path.join(__dirname, 'home-navigation-host.tsx')],
      outfile: path.join(output, 'host.js'),
      alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') },
      loader: { '.png': 'dataurl' },
      plugins,
    });
    const editor = esbuild.buildSync({
      ...options,
      write: false,
      stdin: {
        resolveDir: root,
        contents: `import {App} from '@modelcontextprotocol/ext-apps';
      const app=new App({name:'Navigation fixture',version:'1'}, {}, {autoResize:false});
      const sentinel=crypto.randomUUID();window.runtimeSentinel=sentinel;
      app.ontoolresult=()=>document.body.dataset.seed='received';
      await app.connect();document.body.dataset.initialized='true';`,
      },
    });
    fs.writeFileSync(
      path.join(output, 'editor.html'),
      '<input id="draft" aria-label="Unsaved editor text"><script type="module">' +
        editor.outputFiles[0].text.replaceAll('</script', '<\\/script') +
        '</script>',
    );
    const child = spawnSync(
      require('electron'),
      [__filename, ...(baseline ? ['--baseline'] : [])],
      {
        cwd: root,
        stdio: 'inherit',
        timeout: 60000,
        windowsHide: true,
      },
    );
    if (child.error) console.error(child.error.message);
    process.exit(child.status ?? 1);
  })().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const { WebSocketServer } = require('ws');
  app.setPath('userData', path.join(output, 'profile'));
  const servers = [];
  let win;
  const finish = code => {
    win?.destroy();
    for (const server of servers) server.close();
    app.exit(code);
  };
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  app
    .whenReady()
    .then(async () => {
      const dist = path.join(root, 'vendor/openclaw-runtime/current/dist');
      const moduleFile = fs.readdirSync(dist).find(file => /^sandbox-host-.*\.mjs$/.test(file));
      if (!moduleFile) throw new Error('Build the locked OpenClaw runtime first');
      const native = await import(pathToFileURL(path.join(dist, moduleFile)).href);
      const shell = native.n();
      const sandbox = http.createServer((_req, res) => {
        res.writeHead(200, shell.headers);
        res.end(shell.html);
      });
      servers.push(sandbox);
      await listen(sandbox);
      const descriptor = {
        viewId: 'mcp-app-home-navigation',
        serverName: 'fixture',
        toolName: 'open_editor',
        uiResourceUri: 'ui://fixture/editor',
      };
      const gateway = http.createServer();
      servers.push(gateway);
      const sockets = new WebSocketServer({ server: gateway });
      const calls = [];
      sockets.on('connection', socket => {
        socket.send(
          JSON.stringify({
            type: 'event',
            event: 'connect.challenge',
            payload: { nonce: 'fixture-nonce', ts: Date.now() },
          }),
        );
        socket.on('message', bytes => {
          const request = JSON.parse(String(bytes));
          calls.push(request.method);
          let payload = {};
          if (request.method === 'connect')
            payload = { type: 'hello-ok', protocol: 4, policy: { tickIntervalMs: 30000 } };
          else if (request.method === 'sessions.describe')
            payload = { session: { sessionId: 'fixture-incarnation' } };
          else if (request.method === 'mcp.app.discover')
            payload = {
              servers: [
                {
                  serverName: 'fixture',
                  label: 'Fixture editor',
                  entrypoints: [
                    {
                      toolName: 'open_editor',
                      title: 'Editor',
                      resourceUri: descriptor.uiResourceUri,
                      entrypoint: { type: 'global' },
                    },
                  ],
                },
              ],
            };
          else if (request.method === 'mcp.app.launch')
            payload = {
              viewId: descriptor.viewId,
              preview: {
                kind: 'canvas',
                mcpApp: { ...descriptor, originSessionKey: request.params.sessionKey },
                view: { id: descriptor.viewId, title: 'Fixture editor' },
                presentation: { target: 'assistant_message', sandbox: 'scripts' },
              },
            };
          else if (request.method === 'mcp.app.view')
            payload = {
              html: fs.readFileSync(path.join(output, 'editor.html'), 'utf8'),
              sandboxPort: sandbox.address().port,
              sandboxUrl: native.r(),
              messageSupported: true,
              toolInput: {},
              toolResult: { content: [{ type: 'text', text: 'fixture' }] },
            };
          socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
        });
      });
      await listen(gateway);
      const host = http.createServer((req, res) => {
        if (req.url === '/host.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(fs.readFileSync(path.join(output, 'host.js')));
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<html><head><style>html,body,#root{height:100%;margin:0}body{font:14px system-ui}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.h-full{height:100%}.min-h-0{min-height:0}.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.contents{display:contents}.hidden{display:none!important}[hidden]{display:none!important}.overflow-hidden{overflow:hidden}mcp-app-view{display:block}</style></head><body><div id="root"></div><script>window.fixturePort=' +
            gateway.address().port +
            ';window.fixtureBaseline=' +
            baseline +
            '</script><script type="module" src="/host.js"></script></body></html>',
        );
      });
      servers.push(host);
      await listen(host);
      win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      const errors = [];
      win.webContents.on('console-message', event => {
        if (event.level === 'error') errors.push(event.message);
      });
      const run = code => win.webContents.executeJavaScript(code);
      const until = async operation => {
        for (let index = 0; index < 150; index++) {
          const result = await operation();
          if (result) return result;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Home navigation probe timed out: ' + JSON.stringify(errors));
      };
      await win.loadURL('http://127.0.0.1:' + host.address().port);
      await until(() => run('window.fixtureReady === true'));
      await run('window.fixtureOpen();true');
      const inner = await until(async () => {
        for (const frame of win.webContents.mainFrame.framesInSubtree) {
          try {
            if (
              await frame.executeJavaScript(
                'document.body.dataset.initialized === "true" && document.body.dataset.seed === "received"',
              )
            )
              return frame;
          } catch {
            // The sandbox's inner frame is still being initialized.
          }
        }
      });
      await until(() => run('window.fixtureView && !window.fixtureView.loading'));
      const sentinel = await inner.executeJavaScript('window.runtimeSentinel');
      await inner.executeJavaScript(
        'document.querySelector("#draft").value="unsaved home edit";true',
      );
      await run(
        'window.originalView=window.fixtureView;window.originalFrame=window.fixtureView.shadowRoot.querySelector("iframe");window.fixtureFrameLoads=0;window.originalFrame.addEventListener("load",()=>window.fixtureFrameLoads++);true',
      );
      const cycles = [];
      for (let cycle = 1; cycle <= 3; cycle++) {
        await run('window.fixtureNavigate(false);true');
        await new Promise(resolve => setTimeout(resolve, 100));
        await run('window.fixtureNavigate(true);true');
        await new Promise(resolve => setTimeout(resolve, 500));
        const hostState = await run(
          '({sameView:window.fixtureView===window.originalView,sameFrame:window.fixtureView.shadowRoot.querySelector("iframe")===window.originalFrame,connected:window.originalFrame.isConnected,frameLoads:window.fixtureFrameLoads,loading:window.fixtureView.loading,error:window.fixtureView.error,current:window.fixtureView.context.isCurrent()})',
        );
        let editorState;
        try {
          editorState = await inner.executeJavaScript(
            '({sentinel:window.runtimeSentinel,draft:document.querySelector("#draft")?.value,initialized:document.body.dataset.initialized})',
          );
        } catch (error) {
          editorState = { error: error.message };
        }
        cycles.push({
          cycle,
          hostState,
          editorState,
          sameRuntime: editorState.sentinel === sentinel,
        });
      }
      const currentFrames = [];
      for (const frame of win.webContents.mainFrame.framesInSubtree) {
        try {
          currentFrames.push(
            await frame.executeJavaScript(
              '({url:location.href,sentinel:window.runtimeSentinel,draft:document.querySelector("#draft")?.value,initialized:document.body?.dataset.initialized,bodyLength:document.body?.innerHTML.length})',
            ),
          );
        } catch {
          // A frame may retire while collecting the negative-control evidence.
        }
      }
      const result = {
        originalSentinel: sentinel,
        cycles,
        currentFrames,
        launchCalls: calls.filter(method => method === 'mcp.app.launch').length,
        viewReads: calls.filter(method => method === 'mcp.app.view').length,
      };
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      if (
        cycles.some(
          ({ hostState, editorState, sameRuntime }) =>
            !hostState.sameView ||
            !hostState.sameFrame ||
            !hostState.current ||
            hostState.frameLoads !== 0 ||
            !sameRuntime ||
            editorState.draft !== 'unsaved home edit',
        ) ||
        result.launchCalls !== 1 ||
        result.viewReads !== 1
      )
        throw new Error(
          'Returning home replaced the live editor document or lost its unsaved state',
        );
      finish(0);
    })
    .catch(error => {
      console.error(error.stack || error);
      finish(1);
    });
}
