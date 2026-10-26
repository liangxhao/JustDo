'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, session } = require('electron');

// These are synthetic website authentication operations, executed in the real
// page. No cookies or storage are copied between Electron sessions.
const database = `const db=await new Promise((resolve,reject)=>{
  const request=indexedDB.open('synthetic-auth',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('state');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});`;
exports.loginExpression = token => `(async()=>{
  await fetch('/auth/login?token='+encodeURIComponent(${JSON.stringify(token)}),{method:'POST'});
  localStorage.setItem('synthetic-login',${JSON.stringify(token)});
  ${database}
  await new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');
    tx.objectStore('state').put(${JSON.stringify(token)},'login');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return true;
})()`;
exports.logoutExpression = `(async()=>{
  await fetch('/auth/logout',{method:'POST'});localStorage.removeItem('synthetic-login');
  ${database}
  await new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');
    tx.objectStore('state').delete('login');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  db.close();return true;
})()`;
exports.stateExpression = `(async()=>{
  const network=await fetch('/auth/state',{cache:'no-store'}).then(response=>response.json());
  ${database}
  const indexedDBValue=await new Promise((resolve,reject)=>{const request=db.transaction('state').objectStore('state').get('login');
    request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(request.error);});
  db.close();return {network:network.token,localStorage:localStorage.getItem('synthetic-login'),indexedDB:indexedDBValue,
    sessionStorage:sessionStorage.getItem('synthetic-page-session'),pageMemory:globalThis.syntheticPageMemory??null};
})()`;
exports.assertLogin = (value, token) => {
  assert.equal(value.network, token);
  assert.equal(value.localStorage, token);
  assert.equal(value.indexedDB, token);
};

exports.createRoutes = report => {
  let streamSequence = 0;
  const streams = new Set();
  report.sharedSite = {
    streamOpened: [],
    streamClosed: [],
    streamClosedDuringCleanup: [],
    foregroundCleanupStarted: false,
    authRequests: [],
  };
  return {
    close() {
      for (const response of streams) response.end();
      streams.clear();
    },
    route(request, response) {
      const url = new URL(request.url, 'http://fixture.invalid');
      if (url.pathname === '/auth/login' || url.pathname === '/auth/logout') {
        assert.equal(request.method, 'POST');
        const token = url.pathname === '/auth/logout' ? '' : url.searchParams.get('token');
        assert.ok(token === '' || /^[a-z0-9-]+$/u.test(token));
        response.setHeader(
          'Set-Cookie',
          `synthetic-auth=${token}; HttpOnly; SameSite=Lax; Path=/${token ? '' : '; Max-Age=0'}`,
        );
        response.setHeader('Cache-Control', 'no-store');
        response.end('synthetic authentication');
        return true;
      }
      if (url.pathname === '/auth/state') {
        const token =
          /(?:^|;\s*)synthetic-auth=([^;]*)/u.exec(request.headers.cookie ?? '')?.[1] ?? null;
        report.sharedSite.authRequests.push({ token });
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ token }));
        return true;
      }
      if (url.pathname === '/profile-sw.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.setHeader('Cache-Control', 'no-cache');
        response.end(`self.addEventListener('install',()=>self.skipWaiting());
          self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
          self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/profile-worker-value')
            event.respondWith(Promise.resolve(new Response('synthetic-sidebar-worker')));});
          self.addEventListener('message',event=>{event.ports[0]?.postMessage('synthetic-profile-worker-alive');});`);
        return true;
      }
      if (url.pathname === '/profile-stream') {
        const id = ++streamSequence;
        report.sharedSite.streamOpened.push(id);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        streams.add(response);
        let ticks = 0;
        const tick = () => response.write(`data: ${++ticks}\n\n`);
        tick();
        const timer = setInterval(tick, 50);
        response.once('close', () => {
          clearInterval(timer);
          streams.delete(response);
          const destination = report.sharedSite.foregroundCleanupStarted
            ? report.sharedSite.streamClosedDuringCleanup
            : report.sharedSite.streamClosed;
          destination.push(id);
        });
        return true;
      }
      return false;
    },
  };
};

exports.createForeground = async ({ implementation, runRoot, url, report, bounded, until }) => {
  const partition = implementation.browserPartitionForProfile('embedded');
  const browserSession = session.fromPartition(partition);
  await browserSession.setProxy({ mode: 'direct' });
  const observations = (report.foreground = {
    boundary: 'real webview; synthetic website and UI permission/download delegates',
    partition,
    permissions: [],
    downloads: [],
  });
  const owner = Symbol('synthetic-foreground-policy');
  let foregroundGuest;
  const downloads = new Map();
  const downloadDirectory = path.join(runRoot, 'synthetic-foreground-downloads');
  fs.mkdirSync(downloadDirectory);
  implementation.ensureBrowserSessionPolicy(browserSession);
  implementation.configureBrowserSessionUi(browserSession, owner, {
    ownsGuest: (guest, webContentsId) =>
      Boolean(
        foregroundGuest &&
        !foregroundGuest.isDestroyed() &&
        (guest || webContentsId) &&
        (!guest || guest === foregroundGuest) &&
        (!webContentsId || webContentsId === foregroundGuest.id),
      ),
    checkPermission: () => false,
    requestPermission: (guest, permission, callback) => {
      observations.permissions.push({ guestId: guest.id, permission });
      callback(false);
    },
    download: (_event, item, origin) => {
      const destination = path.join(
        downloadDirectory,
        `foreground-${observations.downloads.length + 1}.txt`,
      );
      const observation = { guestId: origin.id, path: destination, state: 'progressing' };
      observations.downloads.push(observation);
      item.setSavePath(destination);
      item.once('done', (_done, state) => {
        observation.state = state;
        downloads.get(destination)?.(state);
        downloads.delete(destination);
      });
    },
  });
  const carrier = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });
  carrier.webContents.on('will-attach-webview', (_event, preferences) => {
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    preferences.webviewTag = false;
  });
  const attached = new Promise(resolve =>
    carrier.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)),
  );
  await carrier.loadURL('data:text/html,<html><body style="margin:0"></body></html>');
  await carrier.webContents.executeJavaScript(`(()=>{
    const view=document.createElement('webview');view.setAttribute('partition',${JSON.stringify(partition)});
    view.style='width:1200px;height:750px';view.src=${JSON.stringify(url)};document.body.append(view);return true;
  })()`);
  const guest = await bounded(attached, 'foreground webview attachment');
  foregroundGuest = guest;
  guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  await until(() => guest.getURL() === url && !guest.isLoading(), 'foreground webview navigation');
  assert.equal(guest.getType(), 'webview');
  assert.equal(guest.hostWebContents, carrier.webContents);
  assert.equal(implementation.isSameBrowserSession(guest.session, browserSession), true);
  assert.equal(guest.session.storagePath, browserSession.storagePath);
  observations.guestId = guest.id;
  observations.storagePath = browserSession.storagePath;
  const read = expression =>
    bounded(guest.executeJavaScript(expression), 'foreground page operation');
  const permission = async () => {
    const before = observations.permissions.length;
    const result = await read(`new Promise(resolve=>navigator.geolocation.getCurrentPosition(
      ()=>resolve('unexpected-granted'),error=>resolve(error.code===1?'denied':String(error.code)),{timeout:3000}))`);
    assert.equal(result, 'denied');
    assert.ok(
      observations.permissions.length > before,
      'Foreground permission did not reach its UI delegate',
    );
    assert.equal(observations.permissions.at(-1).guestId, guest.id);
  };
  const download = async () => {
    const before = observations.downloads.length;
    guest.downloadURL(new URL('/download', url).href);
    await until(() => observations.downloads.length > before, 'foreground download delegation');
    const item = observations.downloads.at(-1);
    if (item.state === 'progressing') {
      await bounded(
        new Promise(resolve => downloads.set(item.path, resolve)),
        'foreground native download',
      );
    }
    assert.equal(item.state, 'completed');
    assert.equal(fs.readFileSync(item.path, 'utf8'), 'synthetic main-path download');
    assert.equal(item.guestId, guest.id);
  };
  await read(exports.loginExpression('sidebar-one'));
  await read(
    `sessionStorage.setItem('synthetic-page-session','sidebar-only');globalThis.syntheticPageMemory='sidebar-only';true`,
  );
  await read(`(async()=>{
    await navigator.serviceWorker.register('/profile-sw.js');await navigator.serviceWorker.ready;
    await (await caches.open('synthetic-sidebar-cache')).put('/profile-cache-value',new Response('synthetic-sidebar-cache'));
    globalThis.syntheticSidebarStream=new EventSource('/profile-stream');
    syntheticSidebarStream.onmessage=event=>document.documentElement.dataset.streamTicks=event.data;return true;
  })()`);
  await until(
    async () => Number(await read('document.documentElement.dataset.streamTicks||0')) > 0,
    'sidebar profile connection',
  );
  await until(
    async () => await read('Boolean(navigator.serviceWorker.controller)'),
    'sidebar worker control',
  );
  const profileAlive = async () => {
    assert.equal(guest.isDestroyed(), false);
    assert.equal(
      await read("fetch('/profile-worker-value').then(response=>response.text())"),
      'synthetic-sidebar-worker',
    );
    assert.equal(
      await read(
        "caches.open('synthetic-sidebar-cache').then(cache=>cache.match('/profile-cache-value')).then(response=>response.text())",
      ),
      'synthetic-sidebar-cache',
    );
    const ticks = Number(await read('document.documentElement.dataset.streamTicks'));
    await until(
      async () => Number(await read('document.documentElement.dataset.streamTicks')) > ticks,
      'existing sidebar connection survives task release',
    );
    assert.deepEqual(
      report.sharedSite.streamClosed,
      [],
      'A background release closed the sidebar connection',
    );
    return {
      workers: browserSession.serviceWorkers.getAllRunning(),
      registrations: await read(
        'navigator.serviceWorker.getRegistrations().then(registrations=>registrations.length)',
      ),
      streamTicks: Number(await read('document.documentElement.dataset.streamTicks')),
    };
  };
  await permission();
  await download();
  return {
    guest,
    carrier,
    browserSession,
    read,
    permission,
    download,
    profileAlive,
    async close() {
      report.sharedSite.foregroundCleanupStarted = true;
      implementation.releaseBrowserSessionUi(browserSession, owner);
      carrier.destroy();
      await until(() => guest.isDestroyed(), 'foreground carrier/webview destruction');
    },
  };
};
