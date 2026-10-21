// Real Lit viewer + native sandbox + fixed renderers; synthetic documents only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, nativeImage } = require('electron');
app.setPath('userData', path.join(path.dirname(process.argv[2]), 'presentation-profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
let server;
let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function snapshot(bounds, filename) {
  const result = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
    clip: { ...bounds, scale: 1 },
  });
  const bytes = Buffer.from(result.data, 'base64');
  const size = nativeImage.createFromBuffer(bytes).getSize();
  assert.equal(size.width, bounds.width);
  assert.equal(size.height, bounds.height, 'Capture must include the bottom action');
  await fs.writeFile(filename, bytes);
}
async function until(read, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Presentation timeout: ${label}`);
}
app.whenReady().then(async () => {
  try {
    const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    const root = path.resolve(__dirname, '../../..');
    const { build } = require('esbuild');
    const bundle = await build({
      entryPoints: [path.join(__dirname, 'presentation-entry.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'chrome140',
      tsconfig: path.join(root, 'tsconfig.json'),
    });
    const theme = await fs.readFile(path.join(root, 'src/renderer/theme/css/themes.css'), 'utf8');
    const page = `<!doctype html><html data-theme="classic-light"><style>${theme}
      body{margin:0;background:var(--justdo-background);color:var(--justdo-text-primary);font-family:system-ui,sans-serif}
      #preview{margin:12px;width:840px;max-width:calc(100% - 24px)}
      justdo-native-widget{background:var(--justdo-surface)}
    </style><div id="preview"></div><script src="/viewer.js"></script></html>`;
    server = http.createServer((request, response) => {
      response.writeHead(200, {
        'Content-Type': request.url === '/viewer.js' ? 'text/javascript' : 'text/html',
      });
      response.end(request.url === '/viewer.js' ? bundle.outputFiles[0].contents : page);
    });
    const origin = new URL(input.viewerOrigin);
    assert.equal(origin.hostname, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(origin.port), '127.0.0.1', resolve);
    });
    win = new BrowserWindow({
      show: false,
      opacity: 0.01,
      skipTaskbar: true,
      focusable: false,
      width: 900,
      height: 2200,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    await win.loadURL(input.viewerOrigin);
    // A visible Chromium surface is necessary for the product's visibility gate
    // and cross-origin compositing. Keep the fixture nearly transparent and unfocused.
    win.showInactive();
    const read = code => win.webContents.executeJavaScript(code);
    await until(() => read('typeof window.mountPresentation === "function"'), 'viewer module');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
    let screenshots = 0;
    for (const document of input.documents) {
      await read(
        `window.mountPresentation(${JSON.stringify({ ...document, gatewayUrl: input.gatewayUrl })})`,
      );
      await until(
        () =>
          read(
            `!!document.querySelector('justdo-native-widget').shadowRoot.querySelector('iframe') && !document.querySelector('justdo-native-widget').shadowRoot.querySelector('[role="status"]')`,
          ),
        'native widget render',
      );
      const outer = win.webContents.mainFrame.frames[0];
      const inner = await until(
        () => outer.frames.find(frame => frame.url.startsWith('about:')),
        'native inner frame',
      );
      if (document.name === 'ui')
        await until(
          () =>
            inner.executeJavaScript(
              `document.documentElement.classList.contains('openclaw-chat-host') && document.querySelector('main')?.dataset.widgetKitReady==='true'`,
            ),
          'fixed renderer and theme',
        );
      const count = document.name === 'ui' ? 5 : 1;
      assert.equal(
        await inner.executeJavaScript('getComputedStyle(document.body).fontFamily'),
        await read(`getComputedStyle(document.querySelector('justdo-native-widget')).fontFamily`),
        'Widget text must use its chat host font, not the unstyled document root',
      );
      for (const mode of ['light', 'dark']) {
        await read(`document.documentElement.dataset.theme='classic-${mode}'`);
        for (const width of [864, 336]) {
          await read(`document.getElementById('preview').style.width='${width - 24}px'`);
          await delay(300);
          await fs.mkdir(input.outputDirectory, { recursive: true });
          await until(
            () =>
              inner.executeJavaScript(
                `Math.abs(document.documentElement.clientWidth - ${width - 26}) <= 1`,
              ),
            'native viewport resize',
          );
          for (let index = 0; index < count; index++) {
            if (document.name === 'ui')
              await inner.executeJavaScript(
                `document.querySelectorAll('.ui-nav button')[${index}].click()`,
              );
            await delay(180);
            await until(async () => {
              const content = await inner.executeJavaScript(
                'Math.ceil(document.body.getBoundingClientRect().height)',
              );
              const frame = await read(
                `document.querySelector('justdo-native-widget').shadowRoot.querySelector('iframe').clientHeight`,
              );
              return Math.abs(frame - Math.max(48, content)) <= 2;
            }, 'native content height');
            const layout = await inner.executeJavaScript(
              `({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,height:document.body.scrollHeight,scheme:getComputedStyle(document.documentElement).colorScheme,primary:document.querySelectorAll('.ui-follow,#follow').length,details:[...document.querySelectorAll('details')].filter(d=>d.open).length})`,
            );
            assert.ok(
              layout.scrollWidth <= layout.width + 1,
              `Page overflow: ${JSON.stringify({ document: document.name, index, width, layout })}`,
            );
            assert.equal(layout.scheme, mode);
            assert.equal(
              await read(`document.querySelector('justdo-native-widget').failure`),
              false,
              `${document.name} must not report a runtime failure`,
            );
            assert.ok(layout.primary <= 1);
            assert.equal(layout.details, 0, 'Secondary details start collapsed');
            assert.equal(
              await read(
                `document.querySelector('justdo-native-widget').shadowRoot.querySelector('.notice')`,
              ),
              null,
            );
            await read('window.scrollTo(0,0)');
            const bounds = await read(
              `(()=>{const r=document.querySelector('justdo-native-widget').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.ceil(r.height)}})()`,
            );
            await fs.mkdir(input.outputDirectory, { recursive: true });
            await snapshot(
              bounds,
              path.join(input.outputDirectory, `${document.name}-${index}-${mode}-${width}.png`),
            );
            screenshots++;
          }
        }
      }
      if (document.name === 'html') {
        await inner.executeJavaScript(`document.getElementById('budget').value='5000'`);
        const rect = await inner.executeJavaScript(
          `(()=>{const r=document.getElementById('send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        const offset = await read(
          `(()=>{const r=document.querySelector('justdo-native-widget').shadowRoot.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
        );
        const { targetInfos } = await win.webContents.debugger.sendCommand('Target.getTargets');
        const target = targetInfos.find(
          item => item.type === 'iframe' && item.url.startsWith('about:'),
        );
        const session = target
          ? (
              await win.webContents.debugger.sendCommand('Target.attachToTarget', {
                targetId: target.targetId,
                flatten: true,
              })
            ).sessionId
          : undefined;
        const point = session ? rect : { x: rect.x + offset.x, y: rect.y + offset.y };
        for (const type of ['mousePressed', 'mouseReleased']) {
          await win.webContents.debugger.sendCommand(
            'Input.dispatchMouseEvent',
            {
              type,
              button: 'left',
              clickCount: 1,
              ...point,
            },
            session,
          );
        }
        await until(
          () =>
            read(
              `document.querySelector('justdo-native-widget').shadowRoot.querySelector('.suggestion p')?.textContent.includes('budget=5000')`,
            ),
          'HTML form submit reaches the host suggestion',
        );
      }
      if (document.name === 'ui') {
        // Exercise the actual product viewer's suggestion path with native activation.
        await inner.executeJavaScript(
          `globalThis.fixtureClicks=[];document.addEventListener('click',e=>fixtureClicks.push({trusted:e.isTrusted,active:navigator.userActivation.isActive,target:e.target.id}),true);document.querySelectorAll('.ui-nav button')[3].click();document.getElementById('ui_form_field_topic').value='Updated requirement';document.getElementById('ui_form_field_topic').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('ui_form_field_features_option_2').click()`,
        );
        await delay(150);
        const rect = await inner.executeJavaScript(
          `(()=>{const r=document.querySelector('#ui-follow').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        const offset = await read(
          `(()=>{const r=document.querySelector('justdo-native-widget').shadowRoot.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
        );
        const { targetInfos } = await win.webContents.debugger.sendCommand('Target.getTargets');
        const target = targetInfos.find(
          target => target.type === 'iframe' && target.url.startsWith('about:'),
        );
        const session = target
          ? (
              await win.webContents.debugger.sendCommand('Target.attachToTarget', {
                targetId: target.targetId,
                flatten: true,
              })
            ).sessionId
          : undefined;
        // An attached iframe target uses local viewport coordinates.
        const point = session ? rect : { x: rect.x + offset.x, y: rect.y + offset.y };
        for (const type of ['mousePressed', 'mouseReleased'])
          await win.webContents.debugger.sendCommand(
            'Input.dispatchMouseEvent',
            { type, button: 'left', clickCount: 1, ...point },
            session,
          );
        await delay(200);
        const clicked = await inner.executeJavaScript(
          `({clicks:fixtureClicks,disabled:document.getElementById('ui-follow').disabled,errors:[...document.querySelectorAll('.ui-error')].map(e=>e.textContent)})`,
        );
        assert.ok(
          clicked.clicks.some(
            click => click.trusted && click.active && click.target === 'ui-follow',
          ),
        );
        await until(
          () =>
            read(
              `!!document.querySelector('justdo-native-widget').shadowRoot.querySelector('.suggestion')`,
            ),
          'readable host suggestion',
        );
        const summary = await read(
          `document.querySelector('justdo-native-widget').shadowRoot.querySelector('.suggestion p').textContent`,
        );
        assert.ok(summary.includes('Updated requirement'));
        assert.ok(summary.includes('Features / Charts: Yes'));
        assert.ok(!summary.includes('"blocks":'));
        await read('window.scrollTo(0,0)');
        const bounds = await read(
          `(()=>{const r=document.querySelector('justdo-native-widget').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.ceil(r.height)}})()`,
        );
        await snapshot(bounds, path.join(input.outputDirectory, 'follow-up-dark-312.png'));
        screenshots++;

        assert.equal(
          await read(
            `document.querySelector('justdo-native-widget').shadowRoot.querySelectorAll('.suggestion button').length`,
          ),
          2,
        );
      }
    }
    process.stdout.write(
      JSON.stringify({
        presentation: true,
        screenshots,
        readableHostSuggestion: true,
        nativeViewportResize: true,
        htmlFormSubmission: true,
      }) + '\n',
    );
  } catch (error) {
    process.stderr.write(String(error.stack ?? error) + '\n');
    process.exitCode = 1;
  } finally {
    win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode ?? 0);
  }
});
