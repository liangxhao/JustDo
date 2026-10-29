const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { app, BrowserWindow, ipcMain } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-recording-smoke-')));
const events = [];
ipcMain.on('recording-smoke:event', (_event, payload) => events.push(payload));
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for guest recording event');
};
const deadline = setTimeout(() => {
  console.error('Recording smoke timed out');
  app.exit(1);
}, 30_000);
app
  .whenReady()
  .then(async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<title>Recording smoke</title><label>Order<input id="order"></label><button id="query">Query</button>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/`;
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
        preload: path.join(__dirname, 'host.cjs'),
        backgroundThrottling: false,
      },
    });
    const guests = [];
    window.webContents.on('preload-error', (_event, _file, error) =>
      console.error('Host preload:', error.message),
    );
    window.webContents.on('console-message', (_event, _level, message) =>
      console.log('Host:', message),
    );
    const readyGuests = new Set();
    window.webContents.on('will-attach-webview', (_event, preferences) => {
      preferences.preload = path.resolve(__dirname, '../../dist-electron/browserGuestPreload.js');
      preferences.sandbox = true;
      preferences.contextIsolation = true;
      preferences.nodeIntegration = false;
    });
    window.webContents.on('did-attach-webview', (_event, guest) => {
      guests.push(guest);
      guest.on('dom-ready', () => readyGuests.add(guest.id));
      guest.on('preload-error', (_event, _file, error) =>
        console.error('Guest preload:', error.message),
      );
      guest.on('console-message', (_event, _level, message) => console.log('Guest:', message));
    });
    await window.loadURL(
      `data:text/html,${encodeURIComponent(`<style>webview { display: inline-flex; width: 450px; height: 500px; }</style><webview id="a" src="${url}"></webview><webview id="b" src="${url}two"></webview>`)}`,
    );
    await window.webContents
      .executeJavaScript(`for (const guest of document.querySelectorAll('webview')) {
    guest.addEventListener('ipc-message', event => window.recordingSmoke.report({ tab: guest.id, channel: event.channel, value: event.args[0] }));
  }`);
    await waitFor(() => guests.length === 2 && readyGuests.size === 2);
    console.log('Smoke: both sandboxed pages ready');
    for (let index = 0; index < guests.length; index++) {
      const guest = guests[index];
      const readyCount = events.filter(e => e.channel === 'browser:recording:ready').length;
      guest.send('browser:recording:control', { recordingId: 'smoke', active: true });
      await waitFor(
        () => events.filter(e => e.channel === 'browser:recording:ready').length > readyCount,
      );
      console.log(`Smoke: tab ${index + 1} recording acknowledged`);
      await guest.executeJavaScript('document.querySelector("#order").focus()');
      await guest.insertText(`order-${index}`);
      const point = await guest.executeJavaScript(
        '(() => { const r = document.querySelector("#query").getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()',
      );
      guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await waitFor(() =>
        events.some(
          e =>
            e.channel === 'browser:recording:event' &&
            e.value.action === 'click' &&
            e.tab === (index === 0 ? 'a' : 'b'),
        ),
      );
      guest.send('browser:recording:control', { recordingId: 'smoke', active: false });
      await waitFor(() =>
        events.some(
          e => e.channel === 'browser:recording:event' && e.value.value === `order-${index}`,
        ),
      );
      console.log(`Smoke: tab ${index + 1} trusted input captured`);
    }
    const firstDoc = events.find(e => e.channel === 'browser:recording:ready' && e.tab === 'a')
      .value.documentId;
    await guests[0].loadURL(`${url}next`);
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: true });
    await waitFor(() =>
      events.some(
        e =>
          e.tab === 'a' &&
          e.channel === 'browser:recording:ready' &&
          e.value.documentId !== firstDoc,
      ),
    );
    guests[0].send('browser:recording:capture', 'safe');
    await waitFor(() => events.some(e => e.value?.requestId === 'safe' && e.value.safe === true));
    assert.equal((await guests[0].capturePage()).isEmpty(), false);
    await guests[0].executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.id = 'fixture-frame';
      frame.srcdoc = '<label>Frame order<input id="frame-order"></label>';
      frame.addEventListener('load', () => {
        frame.contentDocument.querySelector('input').focus();
        resolve();
      });
      document.body.append(frame);
    })`);
    await guests[0].insertText('iframe-order');
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: false });
    await waitFor(() =>
      events.some(e => e.channel === 'browser:recording:event' && e.value.value === 'iframe-order'),
    );
    await guests[0].executeJavaScript('document.querySelector("#fixture-frame").remove()');
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: true });
    for (const tag of ['video', 'object', 'embed', 'fixture-closed-component']) {
      await guests[0].executeJavaScript(`(() => {
        const element = document.createElement(${JSON.stringify(tag)});
        element.id = 'fixture-media';
        if (${JSON.stringify(tag)} === 'fixture-closed-component') {
          element.attachShadow({ mode: 'closed' }).innerHTML = '<input name="otp" value="123456">';
        }
        document.body.append(element);
      })()`);
      guests[0].send('browser:recording:capture', `media-${tag}`);
      await waitFor(() =>
        events.some(e => e.value?.requestId === `media-${tag}` && e.value.safe === true),
      );
      await guests[0].executeJavaScript('document.querySelector("#fixture-media").remove()');
    }
    await guests[0].executeJavaScript(`(() => {
      const input = document.createElement('input');
      input.id = 'fixture-cvv';
      input.name = 'cvv';
      document.body.append(input);
      input.focus();
    })()`);
    await guests[0].insertText('987');
    guests[0].send('browser:recording:capture', 'ordinary-cvv');
    await waitFor(() =>
      events.some(e => e.value?.requestId === 'ordinary-cvv' && e.value.safe === true),
    );
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: false });
    await waitFor(() =>
      events.some(e => e.channel === 'browser:recording:event' && e.value.value === '987'),
    );
    assert.equal(
      events.some(
        e =>
          e.channel === 'browser:recording:event' &&
          e.value.value === '987' &&
          e.value.sensitive === true,
      ),
      false,
    );
    await guests[0].executeJavaScript('document.querySelector("#fixture-cvv").remove()');
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: true });
    await guests[0].executeJavaScript(
      'const p = document.createElement("input"); p.type = "password"; document.body.append(p); p.focus()',
    );
    await guests[0].insertText('fixture-sensitive-value');
    guests[0].send('browser:recording:capture', 'unsafe');
    await waitFor(() =>
      events.some(e => e.value?.requestId === 'unsafe' && e.value.safe === false),
    );
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: false });
    await waitFor(
      () =>
        events.filter(e => e.channel === 'browser:recording:event' && e.value.sensitive === true)
          .length >= 1,
    );
    assert.equal(JSON.stringify(events).includes('fixture-sensitive-value'), false);
    assert.equal(
      new Set(events.filter(e => e.channel === 'browser:recording:event').map(e => e.tab)).size,
      2,
    );
    await guests[0].loadURL('data:text/html,<label>File demo<input id="order"></label><button>Upload</button>');
    assert.equal(await guests[0].executeJavaScript('typeof crypto.randomUUID'), 'undefined');
    const readyCount = events.filter(e => e.channel === 'browser:recording:ready').length;
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: true });
    await waitFor(() => events.filter(e => e.channel === 'browser:recording:ready').length > readyCount);
    await guests[0].executeJavaScript('document.querySelector("#order").focus()');
    await guests[0].insertText('insecure-origin-input');
    guests[0].send('browser:recording:control', { recordingId: 'smoke', active: false });
    await waitFor(() => events.some(e => e.channel === 'browser:recording:event' && e.value.value === 'insecure-origin-input'));
    console.log(
      'PASS: sandboxed trusted input/clicks, two tabs, same-origin iframe input, navigation, media capture, password-only filtering and an origin without randomUUID',
    );
    clearTimeout(deadline);
    window.destroy();
    server.close();
    app.exit(0);
  })
  .catch(error => {
    console.error(error.message);
    clearTimeout(deadline);
    app.exit(1);
  });
