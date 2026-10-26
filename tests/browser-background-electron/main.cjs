'use strict';

const assert = require('node:assert/strict');
const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const [output, runRoot, runtimeRoot] = process.argv.slice(2);
assert.ok(
  [output, runRoot, runtimeRoot].every(value => path.isAbsolute(value)),
  'Use the probe runner',
);
const repository = path.resolve(__dirname, '../..');
for (const [parent, candidate] of [
  [path.join(repository, 'build/browser-background-probe'), output],
  [path.join(repository, '.agent-tasks/browser-artifacts'), runRoot],
  [path.join(repository, 'build'), runtimeRoot],
]) {
  const relative = path.relative(parent, candidate);
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Fixture directories must remain inside the designated repository artifact roots',
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
}))
  app.setPath(name, path.join(runtimeRoot, directory));
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.on('window-all-closed', () => {});

const report = {
  ok: false,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  runRoot,
  runtimeRoot,
  checks: [],
  windowShows: [],
  windowFocus: [],
  chooserEvents: [],
};
app.on('browser-window-created', (_event, window) => {
  const id = window.id;
  window.on('show', () => report.windowShows.push(id));
  window.on('focus', () => report.windowFocus.push(id));
});
let host;
let server;
let mainPath;
let sharedRoutes;
let finished = false;
const deadline = setTimeout(() => {
  report.error ??= 'The Electron fixture exceeded its execution deadline';
  finish(1);
}, 55000);
const started = Date.now();

const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<style>
body{margin:0;font:16px sans-serif;background:rgb(245,246,250)}
form{position:absolute;left:30px;top:30px}input[type=text]{width:360px;height:32px}
button{height:36px}#click{position:absolute;left:30px;top:110px;width:150px;background:rgb(240,120,60)}
#hover{position:absolute;left:220px;top:110px;width:150px;height:50px;background:rgb(40,80,180)}
#hover:hover{background:rgb(40,180,80)}
#drag{position:absolute;left:40px;top:230px;width:70px;height:70px;background:rgb(120,50,200);touch-action:none}
#drop{position:absolute;left:350px;top:240px;width:120px;height:100px;border:2px solid #333}
#file{position:absolute;left:30px;top:400px}
</style>
<form id=form><input id=text type=text name=query><button type=submit>Submit</button></form>
<button id=click>Click</button><div id=hover>Hover</div>
<div id=drag>Drag</div><div id=drop>Drop</div><input id=file type=file>
<script>
window.fixture={submissions:[],clicks:0,doubleClicks:0,hovers:0,drags:[],keyUps:[],inputEvents:[]};
const fixture=window.fixture;
document.querySelector('#form').addEventListener('submit',event=>{event.preventDefault();fixture.submissions.push(document.querySelector('#text').value)});
document.querySelector('#text').addEventListener('input',event=>fixture.inputEvents.push({value:event.target.value,data:event.data,inputType:event.inputType}));
document.addEventListener('keyup',event=>fixture.keyUps.push(event.key));
document.querySelector('#click').addEventListener('click',()=>fixture.clicks++);
document.querySelector('#click').addEventListener('dblclick',()=>fixture.doubleClicks++);
document.querySelector('#hover').addEventListener('pointerenter',()=>fixture.hovers++);
const drag=document.querySelector('#drag');let dragging;
drag.addEventListener('pointerdown',event=>{dragging={x:event.clientX,y:event.clientY};drag.setPointerCapture(event.pointerId)});
drag.addEventListener('pointermove',event=>{if(dragging)fixture.lastDrag={x:event.clientX,y:event.clientY}});
drag.addEventListener('pointerup',event=>{if(dragging)fixture.drags.push({from:dragging,to:{x:event.clientX,y:event.clientY}});dragging=null});
</script></html>`;

async function until(read, description, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

function hidden() {
  for (const window of BrowserWindow.getAllWindows()) {
    assert.equal(window.isVisible(), false, 'A background window became visible');
    assert.equal(window.isFocused(), false, 'A background window received native focus');
  }
  assert.equal(BrowserWindow.getFocusedWindow(), null);
  assert.deepEqual(report.windowShows, []);
  assert.deepEqual(report.windowFocus, []);
}

function checked(name) {
  hidden();
  report.checks.push(name);
  console.log(`[BackgroundBrowserProbe] ${Date.now() - started}ms: ${name}`);
}

async function bounded(pending, description, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${milliseconds}ms: ${description}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try {
    mainPath?.revoke();
    host?.stop();
  } catch (error) {
    report.cleanupError = error.message;
    code = 1;
  }
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  sharedRoutes?.close();
  server?.closeAllConnections();
  server?.close();
  report.remainingWindows = BrowserWindow.getAllWindows().length;
  fs.writeFileSync(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(code);
}

app
  .whenReady()
  .then(async () => {
    const {
      BackgroundBrowserHost,
      BrowserAgentCdpInput,
      executeAct,
      applyBrowserProxyPreference,
    } = require(path.join(output, 'browser.cjs'));
    await applyBrowserProxyPreference({ browserProxy: { mode: 'direct' } });
    assert.equal(app.getPath('userData'), path.join(runtimeRoot, 'p'));
    assert.equal(app.getPath('sessionData'), path.join(runtimeRoot, 's'));
    assert.equal(app.getPath('home'), path.join(runtimeRoot, 'h'));
    report.paths = Object.fromEntries(
      ['userData', 'sessionData', 'home', 'appData', 'temp', 'cache', 'crashDumps'].map(name => [
        name,
        app.getPath(name),
      ]),
    );
    report.environmentRoots = Object.fromEntries(
      ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].map(name => [
        name,
        process.env[name],
      ]),
    );
    report.generatedBundleRoot = output;
    sharedRoutes = require('./shared-profile.cjs').createRoutes(report);
    server = http.createServer((request, response) => {
      assert.equal(request.headers.host, `127.0.0.1:${server.address().port}`);
      if (sharedRoutes.route(request, response)) return;
      if (request.url === '/download') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Disposition', 'attachment; filename="synthetic-download.txt"');
        response.end('synthetic main-path download');
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(html);
    });
    // Pick only non-reserved Chromium ports; retry only an OS bind collision.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          const failed = error => {
            server.off('listening', listening);
            reject(error);
          };
          const listening = () => {
            server.off('error', failed);
            resolve();
          };
          server.once('error', failed);
          server.once('listening', listening);
          server.listen(randomInt(30000, 50001), '127.0.0.1');
        });
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || attempt >= 20) throw error;
      }
    }
    host = new BackgroundBrowserHost();
    const request = {
      scopeId: 'fixture-run',
      sessionId: 'fixture-session',
      profile: 'embedded',
      targetId: 'fixture-page',
    };
    const guest = await host.create(request);
    const tab = { ...request, webContentsId: guest.id, ownerId: -1, headless: true };
    const window = BrowserWindow.fromWebContents(guest);
    assert.ok(window);
    assert.equal(host.owns(tab, guest), true);
    assert.equal(window.isFocusable(), false);
    assert.equal(guest.getLastWebPreferences().sandbox, true);
    assert.equal(guest.getLastWebPreferences().nodeIntegration, false);
    assert.equal(
      guest.isOffscreen(),
      true,
      'Production background pages must support offscreen painting',
    );
    const storagePath = guest.session.storagePath;
    assert.ok(
      !path.relative(runtimeRoot, storagePath).startsWith('..'),
      'Browser storage escaped the fixture',
    );
    report.storagePath = storagePath;
    checked(
      'real host creates a sandboxed and unfocusable hidden browser inside the isolated fixture profile',
    );
    await guest.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
    assert.deepEqual(
      await guest.executeJavaScript(`({node:typeof require,bridge:typeof window.electron})`),
      {
        node: 'undefined',
        bridge: 'undefined',
      },
    );
    guest.debugger.attach('1.3');
    await guest.debugger.sendCommand('Page.enable');
    await guest.debugger.sendCommand('Runtime.enable');
    let cancelled = false;
    const assertActive = () => {
      if (cancelled) throw new Error('fixture cancelled');
      assert.equal(host.owns(tab, guest), true, 'The original page ownership was lost');
    };
    const wait = async milliseconds => {
      assertActive();
      await new Promise(resolve => setTimeout(resolve, milliseconds));
      assertActive();
    };
    const context = {
      navigationGenerations: new Map(),
      snapshots: new Map(),
      resolveTab: () => tab,
      blockedDialogResult: () => null,
      waitForPossibleNavigation: async () => null,
      resolveActElement: (act, _tab, _guest, _refKey, selectorKey = 'selector') => {
        assert.equal(typeof act[selectorKey], 'string');
        return {
          expression: `document.querySelector(${JSON.stringify(act[selectorKey])})`,
          label: act[selectorKey],
          frameSelector: '',
        };
      },
      executeInTargetWorld: (_tab, _guest, _frame, code) =>
        guest.executeJavaScriptInIsolatedWorld(999, [{ code }]),
      resolveTargetFrameOffset: async () => ({ x: 0, y: 0 }),
      waitWhileActive: (milliseconds, check) => wait(milliseconds).then(check),
      enableDebuggerDomains: async () => guest.debugger,
      focusGuestForKeyboardInput: () => assert.fail('Background input attempted foreground focus'),
      sendToRenderer: () => assert.fail('Background input attempted a Renderer operation'),
    };
    context.executeAct = executeAct.bind(context);
    const act = action =>
      executeAct.call(
        context,
        action,
        tab,
        guest,
        request.sessionId,
        request.profile,
        false,
        assertActive,
      );
    const read = expression => guest.executeJavaScript(expression);
    const center = selector =>
      read(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
      );

    await act({ kind: 'type', selector: '#text', text: '你好，后台浏览器🙂', submit: true });
    await until(
      async () => (await read('fixture.submissions.length')) === 1,
      'Chinese form submission',
    );
    assert.deepEqual(await read('fixture.submissions'), ['你好，后台浏览器🙂']);
    assert.equal((await read('fixture.inputEvents'))[0].data, '你好，后台浏览器🙂');
    checked('DOM Chinese and emoji input reaches the actual page and CDP Enter submits its form');

    await act({ kind: 'press', key: process.platform === 'darwin' ? 'Meta+A' : 'Control+A' });
    await act({ kind: 'press', key: 'Backspace' });
    assert.equal(await read('document.querySelector("#text").value'), '');
    await act({ kind: 'press', key: 'Shift+a' });
    assert.equal(await read('document.querySelector("#text").value'), 'A');
    checked(
      'native selection, Backspace and shifted printable keys work without native window focus',
    );

    const click = await center('#click');
    await act({ kind: 'clickCoords', ...click });
    assert.equal(await read('fixture.clicks'), 1);
    await act({ kind: 'click', selector: '#click', doubleClick: true });
    assert.equal(await read('fixture.clicks'), 3);
    assert.equal(await read('fixture.doubleClicks'), 1);
    await act({ kind: 'hover', selector: '#hover' });
    assert.equal(await read('fixture.hovers'), 1);
    assert.equal(
      await read('getComputedStyle(document.querySelector("#hover")).backgroundColor'),
      'rgb(40, 180, 80)',
    );
    checked('coordinate click, element double click and native hover reach the hidden guest');

    const dragStarted = Date.now();
    await act({ kind: 'drag', startSelector: '#drag', endSelector: '#drop' });
    report.dragMs = Date.now() - dragStarted;
    assert.equal((await read('fixture.drags')).length, 1);
    assert.deepEqual((await read('fixture.drags'))[0].to, await center('#drop'));
    checked('trusted pointer drag reaches its destination and releases the pointer');

    const image = await bounded(
      guest.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      'production CDP viewport screenshot',
    );
    const png = Buffer.from(image.data, 'base64');
    const decoded = nativeImage.createFromBuffer(png);
    const size = decoded.getSize();
    assert.ok(size.width >= 1000 && size.height >= 600);
    assert.ok(png.length > 1000);
    const bitmap = decoded.toBitmap();
    const palette = new Set();
    for (let index = 0; index < bitmap.length; index += 400)
      palette.add(bitmap.subarray(index, index + 4).toString('hex'));
    assert.ok(palette.size > 3, 'The hidden screenshot was blank');
    fs.writeFileSync(path.join(runRoot, 'background.png'), png);
    report.screenshot = { ...size, bytes: png.length, colors: palette.size };
    const nativeCapture = await bounded(
      guest.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      'production capturePage(stayHidden:true,stayAwake:true)',
    );
    assert.deepEqual(nativeCapture.getSize(), size);
    checked('production CDP and native capturePage produce a nonblank hidden viewport screenshot');

    await guest.executeJavaScript('document.body.style.minHeight="1900px"');
    await until(
      async () => (await read('document.documentElement.scrollHeight')) >= 1900,
      'the fixture document reaches its requested full-page height',
    );
    report.fullPageLayout = await guest.debugger.sendCommand('Page.getLayoutMetrics');
    const fullPage = await bounded(
      guest.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
      }),
      'production full-page screenshot',
    );
    const fullPng = Buffer.from(fullPage.data, 'base64');
    const fullSize = nativeImage.createFromBuffer(fullPng).getSize();
    report.fullPage = fullSize;
    assert.ok(fullSize.height >= 1900);
    fs.writeFileSync(path.join(runRoot, 'background-fullpage.png'), fullPng);
    checked('the production offscreen host preserves the full-page Chromium screenshot');

    const element = await bounded(
      guest.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 30, y: 110, width: 150, height: 36, scale: 1 },
      }),
      'production element screenshot',
    );
    const elementPng = Buffer.from(element.data, 'base64');
    const elementSize = nativeImage.createFromBuffer(elementPng).getSize();
    assert.deepEqual(elementSize, { width: 150, height: 36 });
    fs.writeFileSync(path.join(runRoot, 'background-element.png'), elementPng);
    report.element = elementSize;
    checked('the production offscreen host preserves the element-clip Chromium screenshot');

    guest.debugger.on('message', (_event, method, parameters) => {
      if (method === 'Page.fileChooserOpened') report.chooserEvents.push(parameters);
    });
    await guest.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    await act({ kind: 'click', selector: '#file' });
    await until(() => report.chooserEvents.length === 1, 'intercepted file chooser');
    assert.equal(typeof report.chooserEvents[0].backendNodeId, 'number');
    const uploadPath = path.join(runRoot, '上传 fixture.txt');
    fs.writeFileSync(uploadPath, 'synthetic local upload');
    await guest.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [uploadPath],
      backendNodeId: report.chooserEvents[0].backendNodeId,
    });
    assert.equal(await read('document.querySelector("#file").files[0].name'), '上传 fixture.txt');
    checked(
      'CDP intercepts the chooser and supplies an explicit fixture file without an OS picker',
    );

    assert.equal(await read('window.open("/popup") === null'), true);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    checked('the production host denies untracked popup windows');

    const input = new BrowserAgentCdpInput(guest.debugger, assertActive, () => guest.isDestroyed());
    const drag = await center('#drag');
    await assert.rejects(
      input.click(drag, 'left', 1, [], async () => {
        cancelled = true;
        assertActive();
      }),
      /fixture cancelled/,
    );
    cancelled = false;
    assert.equal(
      (await read('fixture.drags')).length,
      2,
      'Cancellation did not release the pressed pointer',
    );
    await read('document.querySelector("#text").focus()');
    await assert.rejects(
      input.press('Enter', [], async () => {
        cancelled = true;
        assertActive();
      }),
      /fixture cancelled/,
    );
    cancelled = false;
    assert.equal((await read('fixture.keyUps')).at(-1), 'Enter');
    checked('cancelled mouse and keyboard holds release into their original target');

    const parallel = await host.create({
      ...request,
      sessionId: 'fixture-parallel-session',
      scopeId: 'fixture-parallel-run',
      targetId: 'fixture-parallel-page',
    });
    assert.equal(guest.session.storagePath, parallel.session.storagePath);
    host.closeScope(request.sessionId);
    assert.equal(host.has(tab.webContentsId), false);
    await until(() => guest.isDestroyed(), 'closed original guest destruction');
    assert.equal(parallel.isDestroyed(), false);
    await parallel.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
    assert.equal(
      await parallel.executeJavaScript('Boolean(document.querySelector("#text"))'),
      true,
    );
    const recreated = await host.create({ ...request, scopeId: 'fixture-next-run' });
    assert.notEqual(recreated.id, tab.webContentsId);
    host.stop();
    await until(() => recreated.isDestroyed(), 'stopped replacement guest destruction');
    await until(() => parallel.isDestroyed(), 'stopped parallel guest destruction');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    checked(
      'different scopes share the profile; closing one keeps its sibling live and host stop destroys only owned pages',
    );
    await require('./main-path.cjs').run({
      implementation: require(path.join(output, 'browser.cjs')),
      runRoot,
      url: `http://127.0.0.1:${server.address().port}/fixture`,
      report,
      checked,
      bounded,
      until,
      registerCleanup: controller => {
        mainPath = controller;
      },
    });
    report.ok = true;
    finish(0);
  })
  .catch(error => {
    report.error ??= error.stack;
    console.error('[BackgroundBrowserProbe]', error.stack);
    finish(1);
  });
