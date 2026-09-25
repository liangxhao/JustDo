// Isolated native guest + actual BrowserAgentBridge IPC. No Gateway/model or user profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (!process.versions.electron) {
  (async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-intervention-'));
    await require('esbuild').build({
      entryPoints: [path.resolve(__dirname, '../../src/main/browser/browserAgentBridge.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      external: ['electron'],
      outfile: path.join(fixture, 'bridge.cjs'),
      plugins: [
        {
          name: 'absolute-fixture-dependencies',
          setup(build) {
            build.onResolve({ filter: /^[^./]/ }, args => {
              if (path.isAbsolute(args.path)) return;
              if (args.path === 'electron' || require('node:module').isBuiltin(args.path))
                return { path: args.path, external: true };
              return {
                path: require.resolve(args.path, { paths: [args.resolveDir || process.cwd()] }),
                external: true,
              };
            });
          },
        },
      ],
    });
    const env = { ...process.env, NODE_PATH: path.resolve(__dirname, '../../node_modules') };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, fixture],
      {
        env,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 45000,
      },
    );
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  })().catch(error => {
    console.error(error);
    process.exit(1);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.argv[2];
  app.setPath('userData', path.join(fixture, 'profile'));
  let host, bridge, server;
  app
    .whenReady()
    .then(async () => {
      const { BrowserAgentBridge } = require(path.join(fixture, 'bridge.cjs'));
      server = require('node:http').createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><body><input id="name"><button>Save</button></body></html>');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      host = new BrowserWindow({
        show: false,
        width: 900,
        height: 650,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          sandbox: false,
          webviewTag: true,
        },
      });
      bridge = new BrowserAgentBridge(
        () => {},
        id => id === host.webContents.id,
        () => fixture,
      );
      bridge.registerIpc();
      const attached = new Promise(resolve =>
        host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)),
      );
      await host.loadURL('data:text/html,<body></body>');
      const url = `http://127.0.0.1:${server.address().port}/`;
      await host.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview');
      view.style.cssText = 'width:850px;height:600px';
      view.setAttribute('partition', 'persist:justdo-browser');
      view.src = ${JSON.stringify(url)};
      document.body.append(view);
    })()`);
      const guest = await attached;
      if (guest.isLoading()) await new Promise(resolve => guest.once('did-finish-load', resolve));
      await host.webContents.executeJavaScript(
        `require('electron').ipcRenderer.send('browser:agentRegisterTab', ${JSON.stringify({ sessionId: 'smoke', targetId: 'page', profile: 'embedded', webContentsId: guest.id })})`,
      );
      const invoke = async (action, token) =>
        host.webContents.executeJavaScript(
          `require('electron').ipcRenderer.invoke('browser:intervention', ${JSON.stringify({ sessionId: 'smoke', targetId: 'page', profile: 'embedded', action, token })})`,
        );
      // An invoke on the same renderer follows the registration event.
      assert.equal((await invoke('read')).success, true);
      const controller = new AbortController();
      const waiting = bridge.executeCommand(
        'justdo:smoke',
        { action: 'act', request: { kind: 'wait', timeMs: 10000 } },
        controller.signal,
      );
      const cancelled = assert.rejects(waiting, /cancelled/);
      await new Promise(resolve => setTimeout(resolve, 100));
      const hold = await invoke('begin');
      assert.equal(hold.success, true);
      await cancelled;
      await invoke('confirmStop', hold.value.token);
      const deadline = Date.now() + 5000;
      let state;
      do {
        state = await invoke('read');
        if (state.value?.phase === 'manual') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.equal(state.value.phase, 'manual');
      await assert.rejects(
        bridge.executeCommand('justdo:smoke', { action: 'navigate', url }),
        /manually operating/,
      );
      await guest.executeJavaScript("document.querySelector('#name').focus()");
      await guest.insertText('manual-input-preserved');
      const guestId = guest.id;
      assert.equal((await invoke('resume', hold.value.token)).value.phase, 'resuming');
      const tabs = await bridge.executeCommand('justdo:smoke', { action: 'tabs' });
      assert.ok(tabs);
      assert.equal(guest.id, guestId);
      assert.equal(
        await guest.executeJavaScript("document.querySelector('#name').value"),
        'manual-input-preserved',
      );
      assert.equal((await invoke('resume', hold.value.token)).success, false);
      assert.equal((await invoke('complete', hold.value.token)).value, null);
      // Closing the last native guest must not strand the session hold.
      const closingHold = await invoke('begin');
      await invoke('confirmStop', closingHold.value.token);
      const destroyed = new Promise(resolve => guest.once('destroyed', resolve));
      await host.webContents.executeJavaScript("document.querySelector('webview').remove()");
      await destroyed;
      assert.equal((await invoke('read')).value.phase, 'manual');
      assert.equal((await invoke('resume', closingHold.value.token)).value.phase, 'resuming');
      assert.equal((await invoke('complete', closingHold.value.token)).value, null);
      console.log(
        '[BrowserInterventionSmoke] PASS: actual IPC, cancellation drain, manual gate, native input preserved, explicit continuation, duplicate rejection and last-guest-close recovery',
      );
      await bridge.stop();
      host.destroy();
      server.close();
      app.exit(0);
    })
    .catch(async error => {
      console.error('[BrowserInterventionSmoke]', error.stack);
      await bridge?.stop();
      host?.destroy();
      server?.close();
      app.exit(1);
    });
}
