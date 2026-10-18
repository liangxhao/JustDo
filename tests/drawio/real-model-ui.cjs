'use strict';
// Test-only Save destination; the product's native Save dialog is covered separately.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
// Electron treats additional absolute positional paths as application entries.
const url = process.env.DIAGRAM_TEST_URL;
const output = process.env.DIAGRAM_TEST_OUTPUT;
assert.ok(url && output);
const profile = fs.mkdtempSync(path.join(output, 'cold-profile-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
let win;
app
  .whenReady()
  .then(async () => {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', event => console.error(event.message));
    win.webContents.on('render-process-gone', (_event, details) =>
      console.error(JSON.stringify(details)),
    );
    const publicRequests = [];
    win.webContents.session.webRequest.onBeforeRequest((details, done) => {
      const allowed =
        new URL(details.url).hostname === '127.0.0.1' || /^(data|blob|about):/.test(details.url);
      if (!allowed) publicRequests.push(new URL(details.url).origin);
      done({ cancel: !allowed });
    });
    const until = async (read, name) => {
      for (let n = 0; n < 300; n++) {
        const result = await read();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${name} timed out`);
    };
    await win.loadURL(url);
    const downloadBaseline = (
      await fetch(new URL('downloads', url)).then(response => response.json())
    ).length;
    const editor = await until(async () => {
      for (const frame of win.webContents.mainFrame.framesInSubtree) {
        try {
          if (
            await frame.executeJavaScript(
              'Boolean(document.querySelector(".geDiagramContainer svg"))',
            )
          )
            return frame;
        } catch {
          /* Wait for native nested sandbox. */
        }
      }
    }, 'Real model diagram');
    const appFrame = await until(async () => {
      for (const frame of win.webContents.mainFrame.framesInSubtree) {
        try {
          if (
            await frame.executeJavaScript(
              'Boolean(document.querySelector("#save:not([disabled])"))',
            )
          )
            return frame;
        } catch {
          /* Not the App wrapper. */
        }
      }
    }, 'App controls');
    await until(
      () =>
        editor.executeJavaScript(
          'document.querySelectorAll(".geDiagramContainer svg foreignObject, .geDiagramContainer svg text").length >= 6',
        ),
      'Diagram labels',
    );
    const inline = await win.webContents.executeJavaScript(`(() => {
      const chat = document.querySelector('justdo-chat');
      const view = chat?.shadowRoot?.querySelector('mcp-app-view');
      return Boolean(view && view.getRootNode() === chat.shadowRoot &&
        window.liveController.state.currentSessionId);
    })()`);
    assert.equal(inline, true, 'Production message timeline must render the App');
    await until(
      () =>
        win.webContents.executeJavaScript(
          'window.liveView && !window.liveView.loading && !window.liveView.error',
        ),
      'Visible inline App',
    );
    const duplicates = await win.webContents.executeJavaScript(`({
      apps: window.liveChat.shadowRoot.querySelectorAll('mcp-app-view').length,
      unavailable: window.liveChat.shadowRoot.querySelectorAll('.assistant-canvas__unavailable').length,
    })`);
    assert.deepEqual(
      duplicates,
      { apps: 1, unavailable: 0 },
      'Do not render a duplicate unavailable preview',
    );
    const editedLabel = '人事登记（已编辑）';
    await editor.executeJavaScript(`(() => {
      const label = document.querySelector('.geDiagramContainer foreignObject div, .geDiagramContainer svg text');
      if (!label) throw new Error('No editable diagram label');
      const bounds = label.getBoundingClientRect();
      label.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2, view: window,
      }));
    })()`);
    await until(
      () =>
        editor.executeJavaScript(
          'Boolean(document.querySelector(".mxCellEditor[contenteditable=true]"))',
        ),
      'Editable diagram cell',
    );
    await editor.executeJavaScript(`(() => {
      const input = document.querySelector('.mxCellEditor[contenteditable=true]');
      input.textContent = ${JSON.stringify(editedLabel)};
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })()`);
    const waitForLayout = async () => {
      await until(async () => {
        const expected = await win.webContents.executeJavaScript(
          'window.liveView.shadowRoot.querySelector("iframe").clientWidth',
        );
        const actual = await appFrame.executeJavaScript('innerWidth');
        return Math.abs(actual - expected) <= 2;
      }, 'App frame layout');
      await editor.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      await win.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      await win.webContents.capturePage();
    };
    await waitForLayout();
    fs.writeFileSync(
      path.join(output, 'real-model-inline.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    for (const format of ['save', 'png', 'svg']) {
      await appFrame.executeJavaScript(`document.querySelector('#${format}').click()`);
      await until(async () => {
        const files = await fetch(new URL('downloads', url)).then(response => response.json());
        return files.length === downloadBaseline + ['save', 'png', 'svg'].indexOf(format) + 1;
      }, format);
    }
    await win.webContents.executeJavaScript(
      'window.liveEditorFrame=window.liveView.shadowRoot.querySelector("iframe");window.liveView.shadowRoot.querySelector("[data-action=display-mode]").click();true',
    );
    await until(
      () => win.webContents.executeJavaScript('window.liveView.expanded'),
      'Expand message App',
    );
    await waitForLayout();
    fs.writeFileSync(
      path.join(output, 'real-model-expanded.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await win.webContents.executeJavaScript(
      'window.liveView.shadowRoot.querySelector("[data-action=dismiss]").click();true',
    );
    await until(
      () => win.webContents.executeJavaScript('!window.liveView.expanded'),
      'Return message App',
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        '!window.liveView.closed && window.liveView.shadowRoot.querySelector("iframe") === window.liveEditorFrame && window.liveEditorFrame.isConnected',
      ),
      true,
    );
    assert.equal(
      await editor.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(editedLabel)})`,
      ),
      true,
    );
    await waitForLayout();
    fs.writeFileSync(
      path.join(output, 'real-model-returned-inline.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    assert.deepEqual(publicRequests, []);
    const actualDownloads = (
      await fetch(new URL('downloads', url)).then(response => response.json())
    ).slice(downloadBaseline);
    assert.deepEqual(
      actualDownloads.map(item => item.mimeType),
      ['application/vnd.jgraph.mxfile', 'image/png', 'image/svg+xml'],
    );
    fs.writeFileSync(
      path.join(output, 'ui-proof.json'),
      JSON.stringify(
        {
          ...(fs.existsSync(path.join(output, 'ui-proof.json'))
            ? JSON.parse(fs.readFileSync(path.join(output, 'ui-proof.json')))
            : {}),
          coldProfile: true,
          messageTimeline: true,
          expandedCloseReturnsInline: true,
          view: await win.webContents.executeJavaScript(`({
            original: window.liveView.preview.viewId,
            native: window.liveView.resources.session.nativeViewId,
          })`),
          editedLabel,
          publicRequests: 0,
          exports: actualDownloads,
        },
        null,
        2,
      ),
    );
    win.destroy();
    app.exit(0);
  })
  .catch(async error => {
    console.error(error.message);
    if (win && !win.isDestroyed()) {
      const previews = await win.webContents.executeJavaScript(`({
        app: window.liveView?.preview,
        canvases: (window.liveController?.state.chatMessages ?? []).flatMap(message =>
          Array.isArray(message.content) ? message.content.filter(item => item.type === 'canvas') : []),
      })`);
      fs.writeFileSync(
        path.join(output, 'ui-preview-diagnostics.json'),
        JSON.stringify(previews, null, 2),
      );
      fs.writeFileSync(
        path.join(output, 'ui-failure.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      console.error(
        await win.webContents.executeJavaScript(
          'window.liveView?.shadowRoot?.textContent || document.querySelector("justdo-chat")?.shadowRoot?.textContent || document.body.innerText',
        ),
      );
    }
    win?.destroy();
    app.exit(1);
  });
