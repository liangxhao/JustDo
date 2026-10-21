// Hidden Electron fixture: actual native sandbox HTML and trusted input; no personal Gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(path.dirname(process.argv[2]), 'browser-profile'));

let server;
let window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  try {
    const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    const sandboxUrl = new URL(input.sandboxUrl, `http://127.0.0.1:${input.sandboxPort}`).href;
    const viewer = new URL(input.viewerOrigin);
    assert.equal(viewer.hostname, '127.0.0.1');
    const page = `<!doctype html><style>body{margin:0}iframe{width:800px;height:500px;border:0}</style><iframe id="widget" sandbox="allow-scripts allow-same-origin allow-forms"></iframe><script>
      const url=${JSON.stringify(sandboxUrl)}, html=${JSON.stringify(input.html).replaceAll('<', '\\u003c')};
      const frame=document.getElementById('widget');
      const renderId=crypto.randomUUID();
      window.probe={loaded:false,port:false,intents:[]};
      addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.origin!==new URL(url).origin)return;
        const data=event.data;
        if(data?.method==='ui/notifications/sandbox-proxy-ready'&&data.params?.sandboxUrl===url)
          frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html,renderId}},event.origin);
        if(data?.method==='ui/notifications/sandbox-resource-loaded'&&data.params?.renderId===renderId)window.probe.loaded=true;
        if(data?.type==='openclaw:widget-prompt-offer'){
          const port=event.ports[0];port.onmessage=event=>window.probe.intents.push(event.data);
          port.start();port.postMessage({type:'openclaw:widget-prompt-host-ready'});window.probe.port=true;
        }
        if(data?.type==='openclaw:widget-bridge-port-offer')for(const port of event.ports)port.close();
      });frame.src=url;
    </script>`;
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(viewer.port), '127.0.0.1', resolve);
    });
    window = new BrowserWindow({
      show: false,
      width: 900,
      height: 650,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    await window.loadURL(input.viewerOrigin);
    const read = code => window.webContents.executeJavaScript(code);
    await until(
      () => read('window.probe.loaded && window.probe.port'),
      'native render and private port',
    );
    const outer = window.webContents.mainFrame.frames[0];
    const inner = await until(
      () => outer.frames.find(frame => frame.url.startsWith('about:')),
      'opaque inner frame',
    );
    const blocked = await inner.executeJavaScript('openclaw.prompt.send("programmatic")');
    assert.equal(blocked, false, 'Calls without actual activation are refused');
    assert.equal(await read('window.probe.intents.length'), 0);
    await window.webContents.capturePage();
    const rect = await inner.executeJavaScript(
      `globalThis.fixtureClicks=[];document.addEventListener('click',e=>fixtureClicks.push({trusted:e.isTrusted,active:navigator.userActivation.isActive,target:e.target.id}),true);document.getElementById('budget').value='5000';(()=>{const r=document.getElementById('send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    const offset = await outer.executeJavaScript(
      `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
    );
    // Chromium input gives the real click activation without displaying a fixture window.
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
    const { targetInfos } = await window.webContents.debugger.sendCommand('Target.getTargets');
    const target =
      targetInfos.find(target => target.type === 'iframe' && target.url.startsWith('about:')) ??
      targetInfos.find(target => target.type === 'iframe' && target.url === sandboxUrl);
    const session = target
      ? (
          await window.webContents.debugger.sendCommand('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          })
        ).sessionId
      : undefined;
    await window.webContents.debugger.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        x: rect.x + offset.x,
        y: rect.y + offset.y,
      },
      session,
    );
    await window.webContents.debugger.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        x: rect.x + offset.x,
        y: rect.y + offset.y,
      },
      session,
    );
    await delay(300);
    const clicks = await inner.executeJavaScript('globalThis.fixtureClicks');
    assert.ok(
      clicks.some(click => click.trusted && click.active && click.target === 'send'),
      `No activated native click: ${JSON.stringify({ clicks, rect, offset })}`,
    );
    const intents = await until(async () => {
      const values = await read('window.probe.intents');
      return values.length ? values : null;
    }, 'trusted click prompt');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].type, 'openclaw:widget-prompt');
    await until(
      async () =>
        (await inner.executeJavaScript('document.getElementById("ack").textContent')) === 'true',
      'local bridge resolution',
    );
    process.stdout.write(
      JSON.stringify({
        nativePromptBridge: true,
        programmaticPromptBlocked: true,
        prompt: intents[0].prompt,
      }) + '\n',
    );
  } catch (error) {
    process.stderr.write(String(error.stack ?? error) + '\n');
    process.exitCode = 1;
  } finally {
    window?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode ?? 0);
  }
});
