'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');

// A real foreground webview and production browser bridge. Only Renderer IPC
// admission and native run ingress are synthetic, as in the owning Main fixture.
exports.run = async ({ implementation, foreground, workspace, checked, until }) => {
  const { guest, carrier, read } = foreground;
  const states = [];
  const targetId = 'foreground-upload';
  const scope = { sessionId: 'foreground-upload-session', runId: 'foreground-upload-run',
    workspaceDir: workspace, headlessOnly: false, allowLocalFiles: true };
  const source = new AbortController();
  const bridge = new implementation.BrowserAgentBridge((channel, payload) => {
    if (channel === implementation.BrowserIpc.AgentInteractionState && payload.targetId === targetId) states.push(payload);
  }, id => id === carrier.webContents.id, () => workspace);
  bridge.registerIpc();
  ipcMain.emit(implementation.BrowserIpc.AgentRegisterTab, {
    sender: carrier.webContents, senderFrame: carrier.webContents.mainFrame,
  }, { sessionId: scope.sessionId, profile: 'embedded', targetId, webContentsId: guest.id });
  const call = command => bridge.executeCommand('agent:fixture:desktop:foreground-upload', {
    ...(command.action === 'act' ? {} : { targetId }), ...command,
  }, source.signal, scope);
  const click = () => call({ action: 'act', request: { kind: 'click', targetId, selector: '#pending-upload-trigger' } });
  const fileName = '前台文件选择.txt';
  fs.writeFileSync(path.join(workspace, fileName), 'real foreground fixture file');
  try {
    await read(`(() => {
      const button = document.createElement('button'); button.id = 'pending-upload-trigger';
      button.textContent = 'Choose pending fixture'; button.dataset.clicks = '0'; button.dataset.changes = '0';
      button.onclick = () => {
        button.dataset.clicks = String(Number(button.dataset.clicks) + 1);
        const input = document.createElement('input'); input.type = 'file'; input.hidden = true;
        input.id = 'pending-file-' + button.dataset.clicks;
        input.onchange = () => {
          button.dataset.changes = String(Number(button.dataset.changes) + 1);
          button.dataset.fileName = input.files[0]?.name;
        };
        document.body.append(input); input.click();
      };
      document.body.prepend(button); return true;
    })()`);
    const opened = await click();
    assert.equal(opened.details.blockedByFileChooser, true, 'click must return a pending chooser without an OS modal');
    assert.equal(opened.details.fileChooser.pending, true);
    assert.equal(await read('document.querySelector("#pending-upload-trigger").dataset.changes'), '0');
    assert.equal(states.at(-1).busy, true, 'pending chooser keeps its interaction lease');
    const snapshot = await call({ action: 'snapshot' });
    assert.equal(snapshot.details.fileChooser.pending, true);
    await call({ action: 'act', request: { kind: 'wait', timeMs: 30, targetId } });
    const uploaded = await call({ action: 'upload', paths: [fileName] });
    assert.equal(uploaded.completed, true);
    assert.equal(uploaded.armed, false);
    assert.equal(await read('document.querySelector("#pending-upload-trigger").dataset.fileName'), fileName);
    assert.equal(await read('document.querySelector("#pending-upload-trigger").dataset.clicks'), '1');
    assert.equal(await read('document.querySelector("#pending-upload-trigger").dataset.changes'), '1');
    assert.equal(states.at(-1).busy, false, 'completed chooser releases both operation and retained leases');

    await read(`new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.id = 'pending-upload-frame';
      frame.srcdoc = '<button id="child-upload">Child upload</button>';
      frame.onload = () => {
        frame.contentDocument.querySelector('button').onclick = () => {
          const input = frame.contentDocument.createElement('input'); input.type = 'file';
          input.id = 'child-file'; input.hidden = true; frame.contentDocument.body.append(input); input.click();
        };
        resolve();
      };
      document.body.append(frame);
    })`);
    const clickChild = async () => {
      const snapshot = await call({ action: 'snapshot', frame: '#pending-upload-frame' });
      const text = snapshot.content.filter(value => value.type === 'text').map(value => value.text).join('\n');
      const ref = /Child upload[^\n]*\[ref=([^\]]+)\]/u.exec(text)?.[1];
      assert.ok(ref, 'The child snapshot must identify its upload control');
      return call({ action: 'act', request: { kind: 'click', targetId, ref } });
    };
    const childOpened = await clickChild();
    assert.equal(childOpened.details.fileChooser.pending, true);
    await call({ action: 'upload', paths: [fileName] });
    assert.equal(await read('document.querySelector("#pending-upload-frame").contentDocument.querySelector("#child-file").files[0].name'), fileName);
    await clickChild();
    await read('document.querySelector("#pending-upload-frame").srcdoc = "<p>New child document</p>";true');
    await until(() => states.at(-1).busy === false, 'child frame navigation retires its chooser');
    const afterChildNavigation = await call({ action: 'snapshot' });
    assert.equal(afterChildNavigation.details.fileChooser, undefined);

    const childNavigationBatch = await call({ action: 'act', request: { kind: 'batch', targetId, stopOnError: false, actions: [
      { kind: 'evaluate', fn: '() => { document.querySelector("#pending-upload-frame").srcdoc = "<p>Another child document</p>"; return true; }' },
      { kind: 'click', selector: '#pending-upload-trigger' },
    ] } });
    assert.equal(childNavigationBatch.details.captureRetired, true);
    assert.equal(await read('document.querySelector("#pending-upload-trigger").dataset.clicks'), '1');

    const batch = await call({ action: 'act', request: { kind: 'batch', targetId, actions: [
      { kind: 'click', selector: '#pending-upload-trigger' },
      { kind: 'evaluate', fn: '() => document.body.dataset.unexpectedBatchMutation = "yes"' },
    ] } });
    assert.equal(batch.details.fileChooser.pending, true);
    assert.equal(await read('document.body.dataset.unexpectedBatchMutation ?? null'), null);
    source.abort();
    await until(() => states.at(-1).busy === false, 'source abort restores interception and releases the pending lease');
    assert.equal(await read('document.querySelector("#pending-upload-trigger").dataset.changes'), '1');
    assert.equal(await read('document.querySelector("#pending-file-1").files[0].name'), fileName);
    checked('real foreground chooser survives snapshot/wait, fills once including iframe input, and frame navigation/batch/cancellation preserve ownership and selected files');
  } finally {
    bridge.releaseExecutionScope(scope.sessionId, false);
    await bridge.stop();
    await read('document.querySelector("#pending-upload-trigger")?.remove();true');
    await read('document.querySelector("#pending-upload-frame")?.remove();true');
  }
};
