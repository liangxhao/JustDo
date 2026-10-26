'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const [fixture, artifactRoot] = process.argv.slice(2);
const repository = path.resolve(__dirname, '../..');
for (const candidate of [fixture, artifactRoot]) {
  const relative = path.relative(repository, candidate);
  assert.ok(
    path.isAbsolute(candidate) &&
      relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative),
  );
}
for (const [name, directory] of Object.entries({
  userData: 'p',
  sessionData: 's',
  home: 'h',
  appData: 'a',
  temp: 't',
  cache: 'c',
  crashDumps: 'd',
})) {
  const target = path.join(fixture, 'e', directory);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(name, target);
}
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.on('window-all-closed', () => {});
const report = {
  rendererCalls: [],
  shows: [],
  focus: [],
  requests: [],
  executions: [],
  mappedJobs: [],
  resolutions: [],
  releases: [],
  revocations: [],
  screenshot: null,
};
app.on('browser-window-created', (_event, window) => {
  window.on('show', () => report.shows.push(window.id));
  window.on('focus', () => report.focus.push(window.id));
});
const rpcWaiters = new Map();
let rpcSequence = 0;
let controller;
let browser;
let host;
let finished = false;
const send = value => {
  if (process.connected) process.send(value);
};
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++rpcSequence;
    const timer = setTimeout(() => {
      rpcWaiters.delete(id);
      reject(new Error(`Parent RPC timeout: ${method}`));
    }, 20000);
    rpcWaiters.set(id, { resolve, reject, timer });
    send({ type: 'rpc', id, method, params });
  });
const deadline = setTimeout(
  () => fail(new Error('Native cron Electron deadline exceeded')),
  150000,
);
async function until(read, description) {
  const expires = Date.now() + 8000;
  while (Date.now() < expires) {
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}
function assertHidden() {
  for (const window of BrowserWindow.getAllWindows()) {
    assert.equal(window.isVisible(), false);
    assert.equal(window.isFocused(), false);
  }
  assert.deepEqual(report.shows, []);
  assert.deepEqual(report.focus, []);
  assert.deepEqual(report.rendererCalls, []);
}
async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try {
    controller?.revoke();
    await browser?.stop();
    await host?.waitForDrain();
    assertHidden();
    report.remainingWindows = BrowserWindow.getAllWindows().length;
    assert.equal(report.remainingWindows, 0);
  } catch (error) {
    report.cleanupError = error.message;
    code = 1;
  }
  report.paths = Object.fromEntries(
    ['userData', 'sessionData', 'home', 'appData', 'temp', 'cache', 'crashDumps'].map(name => [
      name,
      app.getPath(name),
    ]),
  );
  fs.writeFileSync(
    path.join(artifactRoot, 'electron-report.json'),
    JSON.stringify(report, null, 2),
  );
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  if (process.connected) process.send({ type: 'finished', code, report }, () => app.exit(code));
  else app.exit(code);
}
function fail(error) {
  report.error ??= error.stack;
  send({ type: 'failure', error: error.message });
  void finish(1);
}
process.on('disconnect', () => {
  void finish(1);
});
process.on('message', message => {
  if (message.type === 'rpc-result') {
    const waiter = rpcWaiters.get(message.id);
    if (!waiter) return;
    rpcWaiters.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error));
    return;
  }
  if (message.type === 'finish') {
    void finish(0);
    return;
  }
  if (message.type !== 'gateway-event') return;
  void (async () => {
    assert.ok(controller, 'Authenticated event arrived before the Main bridge was ready');
    const event = message.event;
    if (event.event === 'plugin.embedded-browser.revoked') report.revocations.push(event.payload);
    if (event.event === 'plugin.embedded-browser.requested') {
      const { run, requestId, toolCallId, command, policy } = event.payload;
      assert.equal(run.trigger, 'cron');
      assert.equal(command.headless, true, 'The native plugin must force background mode');
      report.requests.push({
        run,
        requestId,
        toolCallId,
        action: command.action,
        headless: command.headless,
        policy,
      });
    }
    controller.handleEvent(event);
    if (event.event === 'plugin.embedded-browser.released') {
      assert.equal(event.payload.reason, 'settled');
      assert.equal(event.payload.discardPages, false);
      assert.deepEqual(event.payload.run, report.requests[0].run);
      await until(
        () => BrowserWindow.getAllWindows().length === 0,
        'native terminal release destroys the exact task page',
      );
      await host.waitForDrain();
      assertHidden();
      report.releases.push(event.payload);
      send({ type: 'release-observed', report });
    }
  })().catch(fail);
});

app
  .whenReady()
  .then(async () => {
    const implementation = require(path.join(fixture, 'main.cjs'));
    await implementation.applyBrowserProxyPreference({ browserProxy: { mode: 'direct' } });
    host = new implementation.BackgroundBrowserHost();
    browser = new implementation.BrowserAgentBridge(
      channel => {
        report.rendererCalls.push(channel);
        assert.fail(`Headless cron attempted Renderer interaction: ${channel}`);
      },
      () => false,
      () => null,
      true,
      undefined,
      undefined,
      host,
    );
    controller = new implementation.EmbeddedBrowserGatewayBridge({
      isEnabled: () => true,
      getDesktopSession: () => null,
      getScheduledTask: async id => {
        const raw = await rpc('cron.get', { id });
        if (!raw) return null;
        const mapped = implementation.mapGatewayJob(raw);
        report.mappedJobs.push({
          id: mapped.id,
          management: mapped.management,
          sessionTarget: mapped.sessionTarget,
          agentId: mapped.agentId,
          payloadKind: mapped.payload.kind,
        });
        return mapped;
      },
      execute: async (sessionKey, command, signal, scope) => {
        report.executions.push({ sessionKey, action: command.action, scope });
        assert.equal(scope.headlessOnly, true);
        const identity = report.requests.at(-1).run;
        assert.equal(scope.runId, identity.runId);
        assert.equal(sessionKey, identity.sessionKey);
        assert.equal(path.resolve(scope.workspaceDir), path.resolve(identity.workspaceDir));
        assert.match(scope.sessionId, /^browser-run:[a-f0-9]{64}$/u);
        const result = await browser.executeCommand(sessionKey, command, signal, scope);
        if (command.action === 'open') {
          assert.equal(result.headless, true);
          assert.equal(BrowserWindow.getAllWindows().length, 1);
        }
        if (command.action === 'screenshot') {
          const image = result.content?.find(block => block.type === 'image');
          assert.ok(image?.data?.length > 100);
          const png = Buffer.from(image.data, 'base64');
          const decoded = nativeImage.createFromBuffer(png);
          report.screenshot = { ...decoded.getSize(), bytes: png.length };
          assert.deepEqual(decoded.getSize(), { width: 1280, height: 800 });
          const bitmap = decoded.toBitmap();
          const colors = new Set();
          for (let index = 0; index < bitmap.length; index += 400)
            colors.add(bitmap.subarray(index, index + 4).toString('hex'));
          report.screenshot.colors = colors.size;
          assert.ok(colors.size > 3, 'The actual native cron screenshot was blank');
          fs.writeFileSync(path.join(artifactRoot, 'native-cron.png'), png);
        }
        assertHidden();
        return result;
      },
      releaseScope: (sessionId, closePages) => browser.releaseExecutionScope(sessionId, closePages),
      revokeAll: () => browser.revokeBackgroundPages(),
      resolve: async (requestId, response) => {
        report.resolutions.push({ requestId, ok: response.ok });
        return rpc('embeddedBrowser.resolve', { requestId, ...response });
      },
    });
    send({ type: 'ready' });
  })
  .catch(fail);
