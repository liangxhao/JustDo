const { app, BrowserWindow, session, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const output = process.argv[2];
const { WorkspaceWindowManager, isWorkspaceBrowserHost, getWorkspaceWindowManager } = require(
  path.join(output, 'manager.cjs'),
);
const { registerWorkspaceWindowHandlers } = require(path.join(output, 'ipc.cjs'));

app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => {
  console.error('Workspace probe timed out');
  app.exit(1);
}, 60000);
const waitFor = async predicate => {
  for (let index = 0; index < 150; index++) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Workspace probe condition timed out');
};

app
  .whenReady()
  .then(async () => {
    // windowsHide suppresses this process's first native ShowWindow. Consume the
    // startup flag before testing the manager's actual first show for each shell.
    const startup = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    startup.show();
    startup.hide();
    startup.destroy();
    registerWorkspaceWindowHandlers();
    const terminalCalls = { create: [], close: [], resize: [] };
    ipcMain.handle('probe:terminal:create', (event, value) => {
      terminalCalls.create.push({ owner: event.sender.id, ...value });
      event.sender.send('probe:terminal:data', { id: value.id, data: 'retained panel output\r\n' });
      return { success: true };
    });
    ipcMain.handle('probe:terminal:close', (event, id) => {
      terminalCalls.close.push({ owner: event.sender.id, id });
      return { success: true };
    });
    ipcMain.handle('probe:terminal:resize', (event, value) => {
      terminalCalls.resize.push({ owner: event.sender.id, ...value });
      return { success: true };
    });
    ipcMain.handle('probe:terminal:write', () => ({ success: true }));
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(true),
    );
    const server = http.createServer((req, res) => {
      const name = req.url.slice(1).split('?')[0] || 'owner.html';
      const file = path.join(output, path.basename(name));
      res.setHeader(
        'Content-Type',
        file.endsWith('.js')
          ? 'application/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      );
      try {
        res.end(fs.readFileSync(file));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/`;
    fs.writeFileSync(
      path.join(output, 'guest.html'),
      '<input id="form" value="initial"><script>window.instance=Math.random()</script>',
    );
    fs.writeFileSync(
      path.join(output, 'workspace.html'),
      '<!doctype html><style>html,body,#workspace-root{height:100%;margin:0;overflow:hidden}</style><div id="workspace-root"></div>',
    );
    fs.writeFileSync(
      path.join(output, 'owner.html'),
      '<!doctype html><link rel="stylesheet" href="layout.css"><link rel="stylesheet" href="bundle.css"><div id="root"></div>',
    );
    for (const mode of ['http', 'file']) {
      const workspaceUrl =
        mode === 'http'
          ? `${base}workspace.html`
          : pathToFileURL(path.join(output, 'workspace.html')).href;
      const owner = new BrowserWindow({
        show: false,
        width: 1000,
        height: 850,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          webviewTag: true,
          backgroundThrottling: false,
          preload: path.join(output, 'preload.cjs'),
        },
      });
      let host, guest;
      let navigations = 0;
      let saved;
      let quitting = false;
      const externalLinks = [];
      const errors = [];
      owner.webContents.on('console-message', details => {
        // Monaco's automatic-layout observer may defer a notification to the next
        // paint during native resize. Preserve all other renderer errors as failures.
        if (
          details.level === 'error' &&
          details.message !== 'ResizeObserver loop completed with undelivered notifications.'
        ) {
          errors.push(details.message);
          console.error(details.message);
        }
      });
      const manager = new WorkspaceWindowManager(owner, {
        url: workspaceUrl,
        backgroundColor: '#ffffff',
        isQuitting: () => quitting,
        openExternal: url => externalLinks.push(url),
        readBounds: () => saved,
        saveBounds: bounds => {
          saved = bounds;
        },
        configureHost: contents => {
          host = contents;
          contents.on('did-navigate', () => {
            navigations++;
          });
          contents.on('did-attach-webview', (_, child) => {
            guest = child;
          });
        },
      });
      // Match the packaged Main close-to-tray path, including already-minimized Main.
      owner.on('close', event => {
        if (quitting) return;
        event.preventDefault();
        manager.hideWithOwner();
        owner.hide();
      });
      owner.webContents.setWindowOpenHandler(
        details => manager.handleOpen(details) ?? { action: 'deny' },
      );
      await owner.loadURL(
        mode === 'http' ? `${base}owner.html` : pathToFileURL(path.join(output, 'owner.html')).href,
      );
      // Open the workspace from a shown Main, matching the interactive app.
      owner.showInactive();
      await owner.webContents.executeJavaScript(
        `window.guestUrl=${JSON.stringify(`${base}guest.html`)};let script=document.createElement('script');script.src='bundle.js';document.head.append(script);`,
      );
      console.log(`${mode}: starting workspace`);
      await waitFor(() => owner.webContents.executeJavaScript('!!window.probe?.editor'));
      await waitFor(() => guest && !guest.isLoading() && guest.getURL() === `${base}guest.html`);
      await waitFor(() =>
        owner.webContents.executeJavaScript(
          'probe.chat.updateComplete.then(()=>!!probe.chat.shadowRoot?.textContent.includes("retained Lit"))',
        ),
      );
      await owner.webContents.executeJavaScript(
        'probe.click();probe.editor.setValue("unsaved edited draft 中文");probe.terminal.paste("pasted 中文");probe.document.querySelector("#draft").dispatchEvent(new probe.document.defaultView.CompositionEvent("compositionstart",{bubbles:true,data:"中文"}));',
      );
      await guest.executeJavaScript('document.querySelector("#form").value="unsaved browser form"');
      const before = await owner.webContents.executeJavaScript('probe.snapshot()');
      assert.equal(before.childHasApi, false);
      assert.equal(before.childMarker, false);
      assert.equal(before.hasAllTabs, true);
      assert.ok(before.litStyles > 0);
      await owner.webContents.executeJavaScript(
        'document.documentElement.dataset.theme="classic-dark"',
      );
      // The production theme is selected by a root data attribute, not just .dark.
      await waitFor(() =>
        owner.webContents.executeJavaScript(
          'getComputedStyle(document.documentElement).getPropertyValue("--background")===probe.document.defaultView.getComputedStyle(probe.document.documentElement).getPropertyValue("--background")',
        ),
      );
      await owner.webContents.executeJavaScript('document.documentElement.dataset.theme="ocean"');
      await waitFor(() =>
        owner.webContents.executeJavaScript(
          'probe.document.documentElement.dataset.theme==="ocean" && getComputedStyle(document.documentElement).getPropertyValue("--background")===probe.document.defaultView.getComputedStyle(probe.document.documentElement).getPropertyValue("--background")',
        ),
      );
      await owner.webContents.executeJavaScript('delete document.documentElement.dataset.theme');
      await waitFor(() =>
        owner.webContents.executeJavaScript(
          '!probe.document.documentElement.hasAttribute("data-theme")',
        ),
      );
      assert.equal(host.getLastWebPreferences().preload, undefined);
      assert.equal(host.getLastWebPreferences().sandbox, true);
      assert.equal(host.getBackgroundThrottling(), false);
      assert.equal(isWorkspaceBrowserHost(owner.webContents.id, host.id), true);
      assert.equal(isWorkspaceBrowserHost(owner.webContents.id, 999999), false);
      const hostId = host.id,
        guestId = guest.id;
      const instance = await guest.executeJavaScript('window.instance');
      await owner.webContents.executeJavaScript(
        `probe.chat.shadowRoot.querySelector('a[href="https://example.com/message-report"]').click()`,
      );
      assert.deepEqual(await owner.webContents.executeJavaScript('probe.webLinks'), [
        'https://example.com/message-report',
      ]);
      await owner.webContents.executeJavaScript(
        'probe.document.querySelector("#external-link").click()',
      );
      await waitFor(() => externalLinks.length === 1);
      assert.equal(externalLinks[0], 'https://example.com/workspace-link');
      await waitFor(() =>
        owner.webContents.executeJavaScript('!!probe.document.querySelector("#notice")'),
      );
      await owner.webContents.executeJavaScript(
        'let rect=document.querySelector(".cowork-display-panel").getBoundingClientRect();let menu=document.createElement("div");menu.id="main-menu";menu.role="menu";Object.assign(menu.style,{position:"fixed",left:rect.left+"px",top:rect.top+"px",width:"40px",height:"40px"});document.body.append(menu)',
      );
      await waitFor(() =>
        owner.webContents.executeJavaScript(
          '!!document.querySelector("#notice") && !probe.document.querySelector("#notice")',
        ),
      );
      await owner.webContents.executeJavaScript('document.querySelector("#main-menu").remove()');
      await waitFor(() =>
        owner.webContents.executeJavaScript('!!probe.document.querySelector("#notice")'),
      );
      for (let round = 0; round < 3; round++) {
        await owner.webContents.executeJavaScript('probe.move()');
        await waitFor(() => manager.prepare().detached);
        const shell = manager.presentationWindow();
        assert.notEqual(shell, owner);
        await waitFor(() => shell.isVisible());
        assert.equal(shell.getTitle(), '');
        await host.executeJavaScript('document.title="Changed conversation title"');
        assert.equal(shell.getTitle(), '');
        if (round === 0) shell.setSize(620, 700);
        const [contentWidth] = shell.getContentSize();
        // The upstream overflow control must stay in the workspace document and
        // preserve focus after selection and resizing on either presentation.
        await waitFor(() =>
          owner.webContents.executeJavaScript(
            `probe.document.defaultView.innerWidth===${contentWidth} && !!probe.document.querySelector(".cowork-display-tab-list-button")`,
          ),
        );
        await owner.webContents.executeJavaScript(
          'probe.document.querySelector(".cowork-display-tab-list-button").click()',
        );
        await waitFor(() =>
          owner.webContents.executeJavaScript(
            'probe.document.querySelectorAll("[role=menuitemradio]").length===8',
          ),
        );
        assert.equal(
          await owner.webContents.executeJavaScript('document.querySelector("[role=menu]")===null'),
          true,
        );
        assert.equal(
          await owner.webContents.executeJavaScript(
            'probe.document.activeElement.getAttribute("role")==="menuitemradio"',
          ),
          true,
        );
        if (round === 0) {
          shell.setSize(500, 600);
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              '(()=>{const menu=probe.document.querySelector("[role=menu]");if(!menu)return false;const bounds=menu.getBoundingClientRect();return probe.document.defaultView.innerWidth<510 && bounds.left>=0 && bounds.right<=probe.document.defaultView.innerWidth})()',
            ),
          );
          assert.equal(
            await owner.webContents.executeJavaScript(
              'probe.document.activeElement.getAttribute("role")==="menuitemradio"',
            ),
            true,
          );
        }
        await owner.webContents.executeJavaScript(
          'probe.document.querySelectorAll("[role=menuitemradio]")[3].click()',
        );
        await waitFor(() =>
          owner.webContents.executeJavaScript(
            'probe.document.querySelector("[role=tab][aria-selected=true]").textContent.includes("Swarm Workflow") && !probe.document.querySelector("[role=menu]") && probe.document.activeElement.getAttribute("aria-selected")==="true"',
          ),
        );
        await owner.webContents.executeJavaScript(
          `probe.chat.shadowRoot.querySelector('a[href="https://example.com/message-report"]').click()`,
        );
        assert.equal(await owner.webContents.executeJavaScript('probe.webLinks.length'), round + 2);
        assert.equal(
          await owner.webContents.executeJavaScript('probe.webLinks.at(-1)'),
          'https://example.com/message-report',
        );
        await owner.webContents.executeJavaScript(
          'probe.document.querySelector("#external-link").click()',
        );
        await waitFor(() => externalLinks.length === round + 2);
        assert.equal(externalLinks.at(-1), 'https://example.com/workspace-link');
        await owner.webContents.executeJavaScript(
          'probe.click();probe.editor.focus();probe.editor.trigger("probe","type",{text:"!"});probe.editor.trigger("probe","undo",{});probe.terminal.resize(48,10);probe.menu()',
        );
        await waitFor(() => owner.webContents.executeJavaScript('probe.snapshot().menuInChild'));
        await owner.webContents.executeJavaScript(
          'probe.document.querySelector("[role=menuitem]").click()',
        );
        await waitFor(() => owner.webContents.executeJavaScript('!probe.snapshot().menuInChild'));
        if (round === 0) {
          await owner.webContents.executeJavaScript(
            'probe.dialog=probe.document.createElement("dialog");probe.dialog.innerHTML="<input id=modal-input>";probe.chat.shadowRoot.append(probe.dialog);probe.dialog.showModal()',
          );
          await owner.webContents.executeJavaScript(
            'let blocker=document.createElement("div");blocker.dataset.workspaceOverlay="true";blocker.id="blocker";blocker.textContent="Approval";document.body.append(blocker)',
          );
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              'probe.document.querySelector("#increment").closest("[inert]")!==null',
            ),
          );
          assert.equal(
            await owner.webContents.executeJavaScript(
              'probe.document.querySelector("[data-testid=workspace-main-prompt]").open',
            ),
            true,
          );
          assert.equal(
            await owner.webContents.executeJavaScript(
              'let button=probe.document.querySelector("[data-testid=workspace-main-prompt] button");button.focus();probe.document.activeElement===button',
            ),
            true,
          );
          await owner.webContents.executeJavaScript('document.querySelector("#blocker").remove()');
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              'probe.document.querySelector("#increment").closest("[inert]")===null',
            ),
          );
          await owner.webContents.executeJavaScript('probe.dialog.close();probe.dialog.remove()');
          owner.showInactive();
          owner.minimize();
          await waitFor(() => owner.isMinimized());
          assert.equal(shell.isVisible(), true);
          // Resize child DOM only: a native resize listener could hide a source-
          // realm observer that stops delivering while Main is minimized.
          const oldColumns =
            terminalCalls.resize.filter(call => call.owner === owner.webContents.id).at(-1)?.cols ??
            terminalCalls.create.filter(call => call.owner === owner.webContents.id).at(-1).cols;
          const oldDiffWidth = await owner.webContents.executeJavaScript('probe.diffLayoutWidth()');
          await owner.webContents.executeJavaScript(
            'probe.document.querySelector("#probe-terminal-host").style.width="240px";probe.document.querySelector("#probe-editor-host").style.width="260px";probe.document.querySelector("#probe-diff-host").style.width="260px";probe.document.querySelector("#probe-flow-host").style.width="480px";probe.document.querySelector("#probe-scroll-host").shadowRoot.querySelector(".chat-container").style.height="600px";',
          );
          await waitFor(
            () =>
              terminalCalls.resize.filter(call => call.owner === owner.webContents.id).at(-1).cols <
              oldColumns,
          );
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              `probe.editor.getLayoutInfo().width===260 && probe.diffLayoutWidth()===${oldDiffWidth - 120} && probe.document.querySelector("#probe-flow-host svg[role=group]").getAttribute("viewBox").split(" ")[2]==="410"`,
            ),
          );
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              '(()=>{const host=probe.document.querySelector("#probe-scroll-host");return host.scrollTop>500 && host.scrollHeight-host.scrollTop-host.clientHeight<2})()',
            ),
          );
          await owner.webContents.executeJavaScript(
            'probe.document.querySelector("#probe-terminal-host").style.width="380px";probe.document.querySelector("#probe-editor-host").style.width="380px";probe.document.querySelector("#probe-diff-host").style.width="380px";probe.document.querySelector("#probe-flow-host").style.width="620px";probe.showDragProbe();',
          );
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              `probe.editor.getLayoutInfo().width===380 && probe.diffLayoutWidth()===${oldDiffWidth} && probe.document.querySelector("#probe-flow-host svg[role=group]").getAttribute("viewBox").split(" ")[2]==="600" && !!probe.document.querySelector("#probe-drag-handle")`,
            ),
          );
          await owner.webContents.executeJavaScript(
            'let handle=probe.document.querySelector("#probe-drag-handle");for(let [type,x,y] of [["pointerdown",150,140],["pointermove",1500,1200],["pointerup",1500,1200]])handle.dispatchEvent(new probe.document.defaultView.PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:x,clientY:y}));',
          );
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              '(()=>{const r=probe.document.querySelector("#probe-drag-dialog").getBoundingClientRect();return r.right<=probe.document.defaultView.innerWidth-11 && r.bottom<=probe.document.defaultView.innerHeight-11 && r.left>=11 && r.top>=11})()',
            ),
          );
          shell.setSize(480, 450);
          await waitFor(() =>
            owner.webContents.executeJavaScript(
              '(()=>{const r=probe.document.querySelector("#probe-drag-dialog").getBoundingClientRect();return probe.document.defaultView.innerWidth<490 && r.right<=probe.document.defaultView.innerWidth-11 && r.bottom<=probe.document.defaultView.innerHeight-11})()',
            ),
          );
          await owner.webContents.executeJavaScript('probe.hideDragProbe()');
          console.log(
            `${mode}: minimized child DOM resize, terminal columns, Monaco layout, Swarm graph and modal bounds passed`,
          );
          owner.close();
          await waitFor(() => !shell.isVisible());
          assert.equal(owner.isDestroyed(), false);
          owner.restore();
          owner.showInactive();
          await waitFor(() => shell.isVisible());
          owner.hide();
          await waitFor(() => !shell.isVisible());
          owner.showInactive();
          await waitFor(() => shell.isVisible());
        }
        shell.close();
        await waitFor(() => !manager.prepare().detached);
        assert.equal(host.isDestroyed(), false);
        assert.equal(host.id, hostId);
        assert.equal(guest.id, guestId);
        assert.equal(host.getBackgroundThrottling(), false);
        await waitFor(() =>
          owner.webContents.executeJavaScript(
            'probe.document.defaultView.innerWidth===520 && !probe.snapshot().detached',
          ),
        );
        await waitFor(() =>
          owner.webContents.executeJavaScript(
            '!!probe.document.querySelector(".cowork-display-tab-list-button")',
          ),
        );
        await owner.webContents.executeJavaScript(
          'probe.document.querySelector(".cowork-display-tab-list-button").click()',
        );
        await waitFor(() =>
          owner.webContents.executeJavaScript(
            'probe.document.querySelectorAll("[role=menuitemradio]").length===8',
          ),
        );
        await owner.webContents.executeJavaScript(
          'probe.document.querySelector("[role=menuitemradio]").click()',
        );
        await waitFor(() =>
          owner.webContents.executeJavaScript(
            'probe.document.querySelector("[role=tab][aria-selected=true]").textContent.includes("Browser") && !probe.document.querySelector("[role=menu]") && probe.document.activeElement.getAttribute("aria-selected")==="true"',
          ),
        );
      }
      const after = await owner.webContents.executeJavaScript('probe.snapshot()');
      assert.equal(after.mounts, 1);
      assert.equal(after.unmounts, 0);
      assert.equal(after.count, '4');
      assert.equal(after.draft, 'unsaved edited draft 中文');
      assert.equal(after.guestId, before.guestId);
      assert.ok(after.litText.includes('retained Lit'));
      assert.ok(after.terminalText.includes('retained terminal'));
      assert.equal(await guest.executeJavaScript('window.instance'), instance);
      assert.equal(
        await guest.executeJavaScript('document.querySelector("#form").value'),
        'unsaved browser form',
      );
      assert.equal(await owner.webContents.executeJavaScript('probe.composition'), 1);
      assert.equal(await owner.webContents.executeJavaScript('probe.selected'), 3);
      assert.ok(
        (await owner.webContents.executeJavaScript('probe.data.join("")')).includes('pasted 中文'),
      );
      assert.equal(
        terminalCalls.create.filter(call => call.owner === owner.webContents.id).length,
        1,
      );
      assert.equal(
        terminalCalls.close.filter(call => call.owner === owner.webContents.id).length,
        0,
      );
      assert.equal(
        await owner.webContents.executeJavaScript(
          'probe.document.querySelector("#notice") !== null',
        ),
        true,
      );
      // Exercise native minimum-size enforcement as well as pure geometry when
      // the remaining display has a very small DIP work area.
      const getAllDisplays = screen.getAllDisplays;
      try {
        screen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 400, height: 240 } }];
        assert.equal(manager.setDetached(manager.prepare().generation, true).success, true);
        const smallShell = manager.presentationWindow();
        assert.equal(smallShell.getBounds().width, 400);
        assert.equal(smallShell.getBounds().height, 240);
        screen.getAllDisplays = getAllDisplays;
        screen.emit('display-metrics-changed');
        assert.deepEqual(smallShell.getMinimumSize(), [480, 320]);
        screen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 400, height: 240 } }];
        screen.emit('display-removed');
        assert.equal(smallShell.getBounds().width, 400);
        assert.equal(smallShell.getBounds().height, 240);
      } finally {
        screen.getAllDisplays = getAllDisplays;
        screen.emit('display-metrics-changed');
        manager.setDetached(manager.prepare().generation, false);
      }
      await waitFor(() => owner.webContents.executeJavaScript('!probe.snapshot().detached'));
      // Reacquire an existing named document after React entry changes. The grant
      // must report current presentation, and must never navigate the live host.
      await owner.webContents.executeJavaScript('probe.remount()');
      await waitFor(() => owner.webContents.executeJavaScript('probe.mounts===2'));
      assert.equal(host.id, hostId);
      await owner.webContents.executeJavaScript('probe.move()');
      await waitFor(() => manager.prepare().detached);
      await owner.webContents.executeJavaScript('probe.remount()');
      await waitFor(() =>
        owner.webContents.executeJavaScript('probe.mounts===3 && probe.snapshot().detached'),
      );
      manager.presentationWindow().close();
      await waitFor(() => !manager.prepare().detached);
      await owner.webContents.executeJavaScript('probe.remount()');
      await waitFor(() =>
        owner.webContents.executeJavaScript('probe.mounts===4 && !probe.snapshot().detached'),
      );
      assert.equal(navigations, 1);
      for (const { detached, processExit } of [
        { detached: false, processExit: false },
        { detached: true, processExit: false },
        { detached: true, processExit: true },
      ]) {
        console.log(
          `${mode}: recover ${processExit ? 'process loss' : 'document close'} (${detached ? 'detached' : 'docked'})`,
        );
        if (detached && !manager.prepare().detached) {
          await owner.webContents.executeJavaScript('probe.move()');
          await waitFor(() => manager.prepare().detached);
        }
        const closedHost = host;
        const closedHostId = closedHost.id;
        const oldGrant = manager.prepare();
        const revoked = oldGrant.generation;
        const mounts = await owner.webContents.executeJavaScript('probe.mounts');
        if (processExit) {
          // Exercise the manager's process-loss branch with a live source; a real
          // same-origin Chromium crash also crashes Main in this Electron build.
          closedHost.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 2 });
        } else {
          await owner.webContents.executeJavaScript('probe.document.defaultView.close()');
        }
        await waitFor(() => closedHost.isDestroyed());
        await waitFor(
          () =>
            host !== closedHost &&
            owner.webContents.executeJavaScript(`probe.mounts===${mounts + 1}`),
        );
        await waitFor(() => manager.prepare().detached === detached);
        if (detached) assert.equal(manager.presentationWindow().getTitle(), '');
        assert.equal(isWorkspaceBrowserHost(owner.webContents.id, closedHostId), false);
        assert.equal(manager.setDetached(revoked, true).success, false);
        assert.notEqual(manager.prepare().frameName, oldGrant.frameName);
        assert.equal(owner.webContents.isCrashed(), false);
        assert.equal(
          await owner.webContents.executeJavaScript('probe.document.defaultView.closed'),
          false,
        );
        assert.equal(manager.captureFrame().processId, host.mainFrame.processId);
        assert.equal(manager.captureFrame().routingId, host.mainFrame.routingId);
        const currentGeneration = manager.prepare().generation;
        const currentHost = host;
        owner.webContents.send('cowork:workspaceWindow:invalidated', {
          generation: revoked,
          detached,
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(manager.prepare().generation, currentGeneration);
        assert.equal(host, currentHost);
      }
      if (manager.prepare().detached) {
        manager.presentationWindow().close();
        await waitFor(() => !manager.prepare().detached);
      }
      const generation = manager.prepare().generation;
      await owner.reload();
      await waitFor(() => host.isDestroyed());
      assert.equal(manager.setDetached(generation, true).success, false);
      assert.equal(isWorkspaceBrowserHost(owner.webContents.id, hostId), false);
      // Native quit may close the detached shell before Main. Cleanup must not
      // access the destroyed shell or leave its still-live WebContents registered.
      await owner.webContents.executeJavaScript(
        '(async()=>{let grant=await window.electron.workspaceWindow.prepare();window.open(grant.url,grant.frameName)})()',
      );
      await waitFor(() => manager.prepare().existing);
      const quitHost = host;
      const ownerId = owner.webContents.id;
      assert.equal(manager.setDetached(manager.prepare().generation, true).success, true);
      const quitShell = manager.presentationWindow();
      quitting = true;
      quitShell.close();
      await waitFor(() => quitShell.isDestroyed());
      owner.destroy();
      await waitFor(() => quitHost.isDestroyed());
      assert.equal(getWorkspaceWindowManager(ownerId), undefined);
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log(
        `${mode}: React/Lit, Monaco, xterm, guest retention, menus, composition, native close, visibility and generation revocation passed`,
      );
    }
    server.close();
    clearTimeout(deadline);
    console.log('WORKSPACE_WINDOW_PROBE_PASSED');
    app.exit(0);
  })
  .catch(error => {
    console.error(error);
    app.exit(1);
  });
