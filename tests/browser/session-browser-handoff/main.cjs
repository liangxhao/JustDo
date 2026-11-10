const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const output = process.argv[2];
const expectFlicker = process.argv.includes('--expect-flicker');
const { WorkspaceWindowManager, registerWorkspaceWindowHandlers } = require(path.join(output, 'manager.cjs'));
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Browser handoff probe timed out'); app.exit(1); }, 45000);
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if (await predicate()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Browser handoff probe condition timed out');
};

app.whenReady().then(async () => {
  const startup = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  startup.show(); startup.hide(); startup.destroy();
  let pageRequests = 0;
  const server = http.createServer((request, response) => {
    const name = request.url.slice(1).split('?')[0] || 'owner.html';
    if (name === 'guest.html') pageRequests++;
    const file = path.join(output, path.basename(name));
    response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    try { response.end(fs.readFileSync(file)); } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  fs.writeFileSync(path.join(output, 'owner.html'), '<!doctype html><link rel="stylesheet" href="layout.css"><link rel="stylesheet" href="bundle.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div>');
  fs.writeFileSync(path.join(output, 'workspace.html'), '<!doctype html><style>html,body,#workspace-root{height:100%;margin:0;overflow:hidden}</style><div id="workspace-root"></div>');
  fs.writeFileSync(path.join(output, 'guest.html'), '<!doctype html><input id="draft" value="initial"><script>window.documentInstance=crypto.randomUUID();window.pageState={revision:1}</script>');

  registerWorkspaceWindowHandlers();
  const owner = new BrowserWindow({
    width: 1100, height: 800, show: false, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  const errors = [];
  owner.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  const updates = [], visibility = [], registrations = [];
  let workspace, guest, manager;
  let attachments = 0, navigations = 0;
  manager = new WorkspaceWindowManager(owner, {
    url: `${origin}workspace.html`, mediaPlaybackPreloadPath: path.join(output, 'empty-preload.cjs'),
    getBackgroundColor: () => '#ffffff', getTitleBarOverlay: () => ({ color: '#ffffff', symbolColor: '#111111', height: 48 }),
    isMac: process.platform === 'darwin', isWindows: process.platform === 'win32',
    showSystemMenu: () => {}, isQuitting: () => false, openExternal: () => {}, readBounds: () => undefined, saveBounds: () => {},
    configureHost: contents => {
      workspace = contents;
      contents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
      contents.on('did-attach-webview', (_, child) => {
        guest = child; attachments++;
        child.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) navigations++; });
      });
    },
  });
  const originalLayout = manager.updateLayout.bind(manager);
  manager.updateLayout = value => {
    updates.push({ ...value });
    originalLayout(value);
  };
  owner.webContents.setWindowOpenHandler(details => manager.handleOpen(details) ?? { action: 'deny' });
  ipcMain.on('probe:browser:register', (_event, value) => registrations.push(value));
  ipcMain.on('probe:browser:unregister', () => {});
  const canonical = {
    id: 'canonical-handoff-probe', title: 'Synthetic', status: 'running', pinned: false,
    cwd: '', executionMode: 'local', permissionMode: 'ask', activeSkillIds: [], agentId: 'main',
    createdAt: 1, updatedAt: 1, nativeSessionKey: 'agent:main:handoff-probe',
  };
  let finish;
  ipcMain.handle('probe:handoff:getSession', () => ({ success: true, session: canonical }));
  ipcMain.handle('probe:handoff:start', (event, options) => new Promise(resolve => {
    finish = resolve;
    setTimeout(() => event.sender.send('probe:handoff:dispatch', {
      requestId: 'handoff-probe-request', clientTurnId: options.clientTurnId,
      sessionId: canonical.id, sessionKey: canonical.nativeSessionKey,
      params: { sessionKey: canonical.nativeSessionKey, idempotencyKey: options.clientTurnId, message: options.prompt },
    }), 40);
  }));
  ipcMain.handle('probe:handoff:respond', (_event, response) => {
    finish(response.success ? { success: true, session: canonical } : { success: false, error: response.error });
    return { success: true };
  });

  try {
    await owner.loadURL(`${origin}owner.html`);
    owner.showInactive();
    await owner.webContents.executeJavaScript(`void import('./bundle.js')`);
    await waitFor(() => guest && !guest.isLoading() && guest.getURL() === `${origin}guest.html`);
    await waitFor(() => registrations.length > 0 && updates.some(value => value.visible));
    const root = owner.contentView.children[0];
    const originalSetVisible = root.setVisible.bind(root);
    root.setVisible = value => { visibility.push(value); originalSetVisible(value); };
    const before = await guest.executeJavaScript('document.querySelector("#draft").value="Unsaved native page input";window.pageState.revision=42;({instance:window.documentInstance,input:document.querySelector("#draft").value,state:window.pageState.revision})');
    const guestId = guest.id;
    const beforeRequests = pageRequests, beforeNavigations = navigations;
    const initialVisible = updates.at(-1)?.visible === true && !updates.at(-1)?.occluded;
    assert.equal(initialVisible, true);
    updates.length = 0; visibility.length = 0;
    const commitStart = await owner.webContents.executeJavaScript('handoffProbe.commits.length');
    await owner.webContents.executeJavaScript('handoffProbe.start()');
    await waitFor(() => owner.webContents.executeJavaScript('handoffProbe.finished'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const state = await owner.webContents.executeJavaScript(`({error:handoffProbe.error,commits:handoffProbe.commits.slice(${commitStart})})`);
    const after = await guest.executeJavaScript('({instance:window.documentInstance,input:document.querySelector("#draft").value,state:window.pageState.revision})');
    assert.equal(state.error, '');
    assert.equal(guest.id, guestId);
    assert.equal(attachments, 1);
    assert.deepEqual(after, before);
    assert.equal(pageRequests, beforeRequests);
    assert.equal(navigations, beforeNavigations);
    assert.equal(registrations.at(-1).sessionId, canonical.id);
    assert.equal(registrations.at(-1).webContentsId, guestId);
    const hiddenUpdates = updates.filter(value => !value.visible || value.occluded);
    const hiddenCommits = state.commits.filter(value => !value.open);
    assert.equal(hiddenUpdates.length > 0, expectFlicker);
    assert.equal(hiddenCommits.length > 0, expectFlicker);
    assert.equal(visibility.includes(false), expectFlicker);
    assert.equal(visibility.at(-1) ?? initialVisible, true);
    assert.deepEqual(errors, []);
    const report = {
      result: expectFlicker ? 'baseline-flicker-without-reload' : 'continuous-visible-handoff',
      guestId, attachments, documentRequests: pageRequests,
      additionalDocumentNavigations: navigations - beforeNavigations,
      pageInstancePreserved: before.instance === after.instance, unsavedInputPreserved: before.input === after.input,
      initialVisible, nativeVisibilityChanges: visibility, hiddenUpdates: hiddenUpdates.length, commits: state.commits,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`[BrowserSessionHandoffProbe] ${JSON.stringify(report)}`);
    console.log(`Artifacts: ${output}`);
  } finally {
    manager.dispose(); owner.destroy(); server.close(); clearTimeout(deadline);
  }
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
