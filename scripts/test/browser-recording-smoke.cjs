// Run with: node scripts/test/browser-recording-smoke.cjs
// Isolated Electron fixture: no application profile, Gateway or user tabs are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-recording-smoke-'));
  require('esbuild').buildSync({
    stdin: {
      contents:
        'import { installBrowserRecordingGuest } from "./src/main/browser/browserRecordingGuest"; installBrowserRecordingGuest();',
      resolveDir: path.resolve(__dirname, '../..'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    external: ['electron'],
    outfile: path.join(fixtureDir, 'guest.cjs'),
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, fixtureDir], {
    env,
    stdio: 'inherit',
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { pathToFileURL } = require('node:url');
  const http = require('node:http');
  const fixtureDir = process.argv[2];
  app.setPath('userData', path.join(fixtureDir, 'profile'));
  const messages = [];
  ipcMain.on('smoke-message', (_event, channel, value) => messages.push({ channel, value }));
  const waitFor = async predicate => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for fixture event');
  };
  let host;
  let server;
  app
    .whenReady()
    .then(async () => {
      server = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<html><body><input name="q" placeholder="Trending news"><button>Next</button>
        <input id="login" type="password" style="display:none"><input name="otp">
        <canvas></canvas><video></video><iframe srcdoc="<button>Frame</button>"></iframe>
        <script>setInterval(() => document.body.dataset.tick = Date.now(), 30)</script></body></html>`);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      host = new BrowserWindow({
        show: false,
        width: 1000,
        height: 700,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false,
          sandbox: false,
        },
      });
      const attached = new Promise(resolve =>
        host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)),
      );
      await host.loadURL('data:text/html,<body style="margin:0"></body>');
      await host.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview');
      view.style.cssText = 'width:1000px;height:650px';
      view.setAttribute('preload', ${JSON.stringify(pathToFileURL(path.join(fixtureDir, 'guest.cjs')).href)});
      view.setAttribute('webpreferences', 'sandbox=yes,contextIsolation=yes');
      view.addEventListener('ipc-message', event => require('electron').ipcRenderer.send('smoke-message', event.channel, event.args[0]));
      view.addEventListener('dom-ready', () => require('electron').ipcRenderer.send('smoke-message', 'dom-ready', true));
      view.src = ${JSON.stringify(`http://127.0.0.1:${server.address().port}/?q=hello&token=demo`)};
      document.body.append(view);
    })()`);
      const guest = await attached;
      await waitFor(() => messages.find(m => m.channel === 'dom-ready'));
      guest.send('browser:recording:control', { recordingId: 'smoke', active: true });
      await waitFor(() => messages.find(m => m.channel === 'browser:recording:ready'));
      const check = async id => {
        guest.send('browser:recording:capture', id);
        return (
          await waitFor(() =>
            messages.find(
              m => m.channel === 'browser:recording:capture' && m.value.requestId === id,
            ),
          )
        ).value;
      };
      const initial = await check('media');
      assert.equal(initial.safe, true, 'media/iframe/OTP/hidden passwords allow capture');
      const image = await guest.capturePage();
      assert.equal(image.isEmpty(), false);
      assert.ok(image.getSize().width > 100);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await check('animation')).revision, initial.revision);
      const point = await guest.executeJavaScript(
        `(() => { const r = document.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+5),y:Math.round(r.y+5)}; })()`,
      );
      await guest.executeJavaScript(`document.querySelector('button').addEventListener('click', () => {
        const notice = document.createElement('div'); notice.setAttribute('role', 'status');
        notice.textContent = 'Saved successfully'; document.body.append(notice);
      });`);
      guest.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      const click = (
        await waitFor(() =>
          messages.find(m => m.channel === 'browser:recording:event' && m.value.action === 'click'),
        )
      ).value;
      assert.equal(click.target.html, '<button>Next</button>');
      assert.ok(click.target.locators.some(l => l.kind === 'css' && l.matches === 1 && l.verified));
      assert.equal(click.target.role, 'button');
      assert.ok(click.target.bounds.width > 0);
      assert.equal(click.interaction.pointer.x, point.x);
      const observation = (
        await waitFor(() =>
          messages.find(
            m =>
              m.channel === 'browser:recording:event' &&
              m.value.action === 'observe' &&
              m.value.relatedSequence === click.sequence,
          ),
        )
      ).value;
      assert.ok(observation.interaction.observed.messages.includes('Saved successfully'));
      await guest.executeJavaScript(`(() => {
        const host = document.createElement('div'); host.id = 'shadow-host';
        host.attachShadow({mode:'open'}).innerHTML = '<button data-testid="shadow-button"><span>Shadow action</span></button>';
        document.body.prepend(host);
      })()`);
      const shadowPoint = await guest.executeJavaScript(
        `(() => { const r = document.querySelector('#shadow-host').shadowRoot.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+5), y:Math.round(r.y+5)}; })()`,
      );
      guest.sendInputEvent({ type: 'mouseDown', ...shadowPoint, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', ...shadowPoint, button: 'left', clickCount: 1 });
      const shadowClick = (
        await waitFor(() =>
          messages.find(
            m =>
              m.channel === 'browser:recording:event' && m.value.target?.name === 'Shadow action',
          ),
        )
      ).value;
      assert.equal(shadowClick.target.scopes[0].kind, 'shadow');
      assert.ok(shadowClick.target.html.includes('<span>Shadow action</span>'));
      assert.ok(click.url.includes('q=hello&token=demo'));
      await guest.executeJavaScript(`document.querySelector('#login').style.display = 'block'`);
      assert.equal((await check('password')).safe, false);
      await guest.executeJavaScript(`document.querySelector('#login').type = 'text'`);
      assert.equal((await check('revealed')).safe, false);
      console.log(
        '[BrowserRecordingSmoke] PASS: native screenshot, trusted click/HTML, media, animation, URL preservation and password visibility guards',
      );
      host.destroy();
      server.close();
      app.exit(0);
    })
    .catch(error => {
      console.error('[BrowserRecordingSmoke]', error.message);
      host?.destroy();
      server?.close();
      app.exit(1);
    });
}
