'use strict';
// Actual bundled draw.io + standard MCP + actual product host + native sandbox.
// Only the Gateway identity facade and native Save dialog are fixtures in this UI test.
// --unsafe-port forces the first service allocation to Chromium's blocked port 6000.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.agent-tasks/drawio/ui');
fs.mkdirSync(output, { recursive: true });

// This runs only inside the isolated MCP service, never in the product or browser.
function forceFirstUnsafePort(report) {
  const net = require('node:net');
  const fs = require('node:fs');
  const original = net.Server.prototype.listen;
  let forced = false;
  net.Server.prototype.listen = function (...args) {
    const options = args[0];
    const port = typeof options === 'object' ? options.port : options;
    const host = typeof options === 'object' ? options.host : args[1];
    if (port !== 0 || host !== '127.0.0.1') return original.apply(this, args);
    const force = !forced;
    forced = true;
    if (force) {
      // A running product may already own 127.0.0.1:6000. This remains an actual
      // loopback allocation; Chromium rejects the advertised port before I/O.
      if (typeof options === 'object') args[0] = { ...options, port: 6000, host: '127.0.0.2' };
      else {
        args[0] = 6000;
        args[1] = '127.0.0.2';
      }
    }
    this.prependOnceListener('listening', () => {
      fs.appendFileSync(
        report,
        JSON.stringify({ requestedPort: port, forced: force, port: this.address().port }) + '\n',
      );
    });
    return original.apply(this, args);
  };
}

async function fixture() {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const sourceAssets = path.join(
    root,
    process.argv.includes('--runtime')
      ? 'vendor/openclaw-runtime/current/dist/extensions/drawio/assets'
      : 'plugins/extensions/drawio/assets',
  );
  require('../../plugins/extensions/drawio/scripts/prepare.cjs').verifyDrawioAssets(sourceAssets);
  // No ancestor node_modules: this proves the service/SDK dependencies are bundled.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-offline-'));
  for (const file of fs.readdirSync(sourceAssets).filter(file => /\.(cjs|js|css|pack)$/.test(file)))
    fs.copyFileSync(path.join(sourceAssets, file), path.join(isolated, file));
  if (fs.existsSync(path.join(sourceAssets, 'public')))
    fs.symlinkSync(path.join(sourceAssets, 'public'), path.join(isolated, 'public'), 'junction');
  const portReport = path.join(isolated, 'port-attempts.jsonl');
  const serviceArgs = [path.join(isolated, 'server.cjs')];
  if (process.argv.includes('--unsafe-port')) {
    const shim = path.join(isolated, 'force-unsafe-port.cjs');
    fs.writeFileSync(shim, `(${forceFirstUnsafePort.toString()})(${JSON.stringify(portReport)});`);
    serviceArgs.unshift('--require', shim);
  }
  const transport = new StdioClientTransport({
    command: process.env.DIAGRAM_TEST_NODE || process.execPath,
    args: serviceArgs,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'offline-test', version: '1' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools[0]._meta.ui.resourceUri, 'ui://drawio/editor');
  const sourceXml = fs.readFileSync(
    path.join(root, 'plugins/extensions/drawio/tests/fixture.xml'),
    'utf8',
  );
  const xml = process.argv.includes('--compressed')
    ? `<mxfile><diagram name="采购审批">${require('node:zlib')
        .deflateRawSync(
          encodeURIComponent(sourceXml.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/)[0]),
        )
        .toString('base64')}</diagram></mxfile>`
    : sourceXml;
  const file = process.argv.includes('--file')
    ? {
        name: '采购审批流程.drawio',
        resourceUri: 'openclaw-file://12345678-1234-1234-1234-123456789abc',
      }
    : undefined;
  const result = await client.callTool({
    name: file ? 'open_file' : process.argv.includes('--blank') ? 'open_editor' : 'create_diagram',
    arguments: file
      ? { file }
      : process.argv.includes('--blank')
        ? {}
        : { xml, title: '采购审批流程' },
  });
  assert.ok(!result.isError);
  const resource = await client.readResource({ uri: 'ui://drawio/editor' });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(Buffer.byteLength(resource.contents[0].text) < 2 * 1024 * 1024);
  const csp = resource.contents[0]._meta.ui.csp;
  const portAttempts = fs.existsSync(portReport)
    ? fs
        .readFileSync(portReport, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    : [];
  if (process.argv.includes('--unsafe-port')) {
    assert.deepEqual(portAttempts[0], { requestedPort: 0, forced: true, port: 6000 });
  }
  const dist = path.join(root, 'vendor/openclaw-runtime/current/dist');
  const moduleFile = fs.readdirSync(dist).find(file => /^sandbox-host-.*\.mjs$/.test(file));
  const native = await import(pathToFileURL(path.join(dist, moduleFile)).href);
  const document = native.n(csp);
  const sandbox = http.createServer((_req, res) => {
    res.writeHead(200, document.headers);
    res.end(document.html);
  });
  await new Promise(resolve => sandbox.listen(0, '127.0.0.1', resolve));
  const payload = {
    html: resource.contents[0].text,
    csp,
    sandboxUrl: native.r(csp),
    sandboxPort: sandbox.address().port,
    toolInput: file ? { file } : process.argv.includes('--blank') ? {} : { xml },
    toolResult: result,
    ...(file ? { fileResourcesSupported: true } : {}),
  };
  const host = http.createServer((req, res) => {
    res.setHeader(
      'Content-Type',
      req.url === '/host.js'
        ? 'text/javascript'
        : req.url === '/product.css'
          ? 'text/css'
          : 'text/html; charset=utf-8',
    );
    if (req.url === '/host.js') return res.end(fs.readFileSync(path.join(output, 'host.js')));
    if (req.url === '/product.css')
      return res.end(fs.readFileSync(path.join(output, 'product.css')));
    res.end(
      `<html lang="zh" data-theme="classic-light"><head><link rel="stylesheet" href="/product.css"><style>html{background:var(--justdo-background);color:var(--justdo-text-primary)}body{max-width:1000px;margin:30px auto;font:14px system-ui}</style></head><body><script>window.fixturePayload=${JSON.stringify(payload).replaceAll('<', '\\u003c')};window.fixtureIcons=${JSON.stringify(tools.tools[0].icons ?? [])};window.fixtureFile=${JSON.stringify(file ? { ...file, xml } : null).replaceAll('<', '\\u003c')};</script><script type="module" src="/host.js"></script></body></html>`,
    );
  });
  await new Promise(resolve =>
    host.listen(process.argv.includes('--serve') ? 7842 : 0, '127.0.0.1', resolve),
  );
  return {
    url: `http://127.0.0.1:${host.address().port}`,
    assetOrigin: csp.resourceDomains[0],
    portAttempts,
    close: async () => {
      host.close();
      sandbox.close();
      await client.close();
      if (fs.existsSync(path.join(isolated, 'public')))
        fs.unlinkSync(path.join(isolated, 'public'));
      assert.equal(path.dirname(isolated), os.tmpdir());
      fs.rmSync(isolated, { recursive: true, force: true });
    },
  };
}

if (!process.versions.electron) {
  require('../../plugins/extensions/drawio/scripts/prepare.cjs').verifyDrawioAssets();
  const css = fs
    .readdirSync(path.join(root, 'dist/assets'))
    .find(file => /^main-.*\.css$/.test(file));
  if (!css) throw new Error('Build the product stylesheet first');
  fs.copyFileSync(path.join(root, 'dist/assets', css), path.join(output, 'product.css'));
  require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, 'ui-host.ts')],
    outfile: path.join(output, 'host.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
    minify: true,
    jsx: 'automatic',
    alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') },
  });
  if (process.argv.includes('--serve')) {
    fixture()
      .then(value => {
        console.log(`Draw.io UI preview: ${value.url}`);
        setTimeout(
          () => {
            void value.close();
          },
          2 * 60 * 60 * 1000,
        );
      })
      .catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
  } else {
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
      cwd: root,
      env: { ...process.env, DIAGRAM_TEST_NODE: process.execPath },
      windowsHide: true,
      stdio: 'inherit',
      timeout: 180000,
    });
    process.exit(result.status ?? 1);
  }
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = fs.mkdtempSync(path.join(output, 'cold-profile-'));
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('disable-background-networking');
  let win, running;
  const evidence = {
    runtime: process.argv.includes('--runtime'),
    file: process.argv.includes('--file'),
    compressed: process.argv.includes('--compressed'),
    forcedUnsafePort: process.argv.includes('--unsafe-port'),
    portAttempts: [],
    assetOrigin: undefined,
    editorReady: false,
    sourceExported: false,
    publicRequests: [],
    requestErrors: [],
    failedLoads: [],
    errors: [],
  };
  const savePortEvidence = error => {
    if (!evidence.forcedUnsafePort) return;
    fs.writeFileSync(
      path.join(output, `unsafe-port-${evidence.runtime ? 'runtime' : 'local'}-result.json`),
      JSON.stringify({ ...evidence, ...(error ? { failure: String(error) } : {}) }, null, 2),
    );
  };
  app
    .whenReady()
    .then(async () => {
      running = await fixture();
      evidence.assetOrigin = running.assetOrigin;
      evidence.portAttempts = running.portAttempts;
      win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 850,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      const blocked = evidence.publicRequests,
        errors = evidence.errors;
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed =
          ['127.0.0.1', ''].includes(new URL(details.url).hostname) ||
          /^(data|blob|about):/.test(details.url);
        if (!allowed) blocked.push(details.url);
        callback({ cancel: !allowed });
      });
      win.webContents.on('console-message', event => {
        if (event.level === 'error') errors.push(event.message);
      });
      win.webContents.session.webRequest.onErrorOccurred(details => {
        evidence.requestErrors.push({ error: details.error, url: details.url });
      });
      win.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
        evidence.failedLoads.push({ code, description, url, mainFrame });
      });
      const hostUrl = new URL(running.url);
      for (const flag of ['file', 'blank', 'reference'])
        if (process.argv.includes(`--${flag}`)) hostUrl.searchParams.set(flag, '1');
      await win.loadURL(hostUrl.href);
      const until = async (fn, label) => {
        for (let i = 0; i < 300; i++) {
          const value = await fn();
          if (value) return value;
          if (
            evidence.forcedUnsafePort &&
            (evidence.failedLoads.some(failure =>
              failure.description.includes('ERR_UNSAFE_PORT'),
            ) ||
              evidence.requestErrors.some(failure => failure.error.includes('ERR_UNSAFE_PORT')) ||
              errors.some(message => message.includes('ERR_UNSAFE_PORT')))
          )
            throw new Error(`${label}: Chromium rejected the real asset port with ERR_UNSAFE_PORT`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`${label} timed out: ${JSON.stringify(errors)}`);
      };
      const inner = await until(async () => {
        for (const frame of win.webContents.mainFrame.framesInSubtree)
          try {
            if (
              await frame.executeJavaScript(
                'Boolean(document.querySelector("#save") && !document.querySelector("#save").disabled)',
              )
            )
              return frame;
          } catch {
            /* Wait for the isolated App document. */
          }
      }, 'App ready');
      if (process.argv.includes('--blank') && process.argv.includes('--editing')) {
        await until(async () => {
          for (const frame of win.webContents.mainFrame.framesInSubtree)
            try {
              if (
                await frame.executeJavaScript(
                  'Boolean(document.querySelector(".geDiagramContainer"))',
                )
              )
                return frame;
            } catch {
              /* wait */
            }
        }, 'Blank editor ready');
        await win.webContents.executeJavaScript(
          'window.fixtureBlankFrame=window.fixtureView.shadowRoot.querySelector("iframe");window.fixturePrepareDiagram()',
        );
        const blank = await win.webContents.executeJavaScript('window.fixtureSnapshot');
        assert.doesNotMatch(blank.xml, /vertex="1"/);
        const initial = fs.readFileSync(
          path.join(root, 'plugins/extensions/drawio/tests/fixture.xml'),
          'utf8',
        );
        const applied = await win.webContents.executeJavaScript(
          `window.fixtureApplyDiagram(${JSON.stringify(initial)})`,
        );
        assert.equal(applied.status, 'applied');
        assert.equal(
          await win.webContents.executeJavaScript(
            'window.fixtureBlankFrame===window.fixtureView.shadowRoot.querySelector("iframe")',
          ),
          true,
        );
      }
      if (process.argv.includes('--blank') && !process.argv.includes('--editing')) {
        const blankEditor = await until(async () => {
          for (const frame of win.webContents.mainFrame.framesInSubtree) {
            try {
              if (
                await frame.executeJavaScript(
                  'Boolean(document.querySelector(".geDiagramContainer"))',
                )
              )
                return frame;
            } catch {
              /* Wait for the local editor document. */
            }
          }
        }, 'Blank editor');
        evidence.editorReady = true;
        assert.equal(
          await blankEditor.executeJavaScript('document.body.innerText.includes("提交申请")'),
          false,
          'The manual entry must open an empty graph',
        );
        await inner.executeJavaScript('document.querySelector("#save").click()');
        await until(
          () => win.webContents.executeJavaScript('window.downloads.length === 1'),
          'Save a manually opened blank graph',
        );
        const saved = await win.webContents.executeJavaScript('window.downloads[0]');
        const source = Buffer.from(saved.dataBase64, 'base64').toString();
        assert.match(source, /mxfile/);
        assert.doesNotMatch(source, /vertex="1"/);
        evidence.sourceExported = true;
        assert.deepEqual(blocked, [], 'Manual editing must use local assets only');
        await blankEditor.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        await win.webContents.capturePage();
        fs.writeFileSync(
          path.join(output, 'drawio-manual-blank.png'),
          (await win.webContents.capturePage()).toPNG(),
        );
        console.log('Manual blank draw.io UI and source export passed with no public requests.');
        return;
      }
      const editor = await until(async () => {
        for (const frame of win.webContents.mainFrame.framesInSubtree)
          try {
            if (
              await frame.executeJavaScript(
                'Boolean(document.querySelector(".geDiagramContainer svg") && document.body.innerText.includes("提交申请"))',
              )
            )
              return frame;
          } catch {
            /* Wait for the local editor document. */
          }
      }, 'Diagram rendered');
      assert.ok(editor);
      evidence.editorReady = true;
      await until(
        () =>
          inner.executeJavaScript('document.documentElement.hasAttribute("data-shared-header")'),
        'Shared toolbar layout',
      );
      const hostHeader = await win.webContents.executeJavaScript(`(() => {
        const root=window.fixtureView.shadowRoot,frame=root.querySelector('iframe').getBoundingClientRect();
        const header=root.querySelector('header').getBoundingClientRect();
        const space=root.querySelector('.app-header-space').getBoundingClientRect();
        return {frame:frame.toJSON(),header:header.toJSON(),space:space.toJSON(),
          shared:root.querySelector('header').hasAttribute('shared'),
          pluginIcon:root.querySelector('.app-icon img')?.getAttribute('src')};
      })()`);
      assert.ok(hostHeader.shared);
      assert.equal(hostHeader.header.height, 44);
      assert.ok(
        Math.abs(hostHeader.header.top - hostHeader.frame.top) < 1,
        'Host and App header occupy the same row',
      );
      assert.ok(
        hostHeader.pluginIcon?.startsWith('data:image/'),
        'Inline header uses the actual plugin catalog icon',
      );
      assert.equal(
        await inner.executeJavaScript('getComputedStyle(document.querySelector("#title")).display'),
        'none',
      );
      for (const id of ['save', 'png', 'svg']) {
        const rect = await inner.executeJavaScript(
          `document.querySelector('#${id}').getBoundingClientRect().toJSON()`,
        );
        const x = hostHeader.frame.left + rect.left + rect.width / 2,
          y = hostHeader.frame.top + rect.top + rect.height / 2;
        assert.ok(Math.abs(y - (hostHeader.header.top + 22)) < 2, id + ' shares the header row');
        assert.ok(
          hostHeader.frame.left + rect.left >= hostHeader.space.left - 1 &&
            hostHeader.frame.left + rect.right <= hostHeader.space.right + 1,
          id + ' avoids host controls',
        );
        assert.equal(
          await win.webContents.executeJavaScript(
            `window.fixtureView.shadowRoot.elementFromPoint(${x},${y})?.tagName`,
          ),
          'IFRAME',
          id + ' remains directly clickable in the original App',
        );
      }
      await win.webContents.capturePage();
      await win.webContents.executeJavaScript(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      fs.writeFileSync(
        path.join(output, 'drawio-single-header.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      if (process.argv.includes('--editing')) {
        await win.webContents.executeJavaScript(
          'window.fixtureOriginalFrame=window.fixtureView.shadowRoot.querySelector("iframe");window.fixturePrepareDiagram()',
        );
        const prepared = await win.webContents.executeJavaScript('window.fixtureSnapshot');
        assert.match(prepared.xml, /提交申请/);
        const candidate = prepared.xml.replaceAll('提交申请', 'AI 修改后的申请');
        const applied = await win.webContents.executeJavaScript(
          `window.fixtureApplyDiagram(${JSON.stringify(candidate)})`,
        );
        assert.equal(applied.status, 'applied');
        await until(
          () => editor.executeJavaScript('document.body.innerText.includes("AI 修改后的申请")'),
          'AI update visible',
        );
        assert.equal(
          await win.webContents.executeJavaScript(
            'window.fixtureView.shadowRoot.querySelector("iframe")===window.fixtureOriginalFrame',
          ),
          true,
        );
        const shortcut = async (key, keyCode) => {
          await editor.executeJavaScript(
            `document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:${JSON.stringify(key)}, code:'Key${key.toUpperCase()}', keyCode:${keyCode}, ctrlKey:true }))`,
          );
        };
        await shortcut('z', 90);
        await until(
          () =>
            editor.executeJavaScript(
              'document.body.innerText.includes("提交申请") && !document.body.innerText.includes("AI 修改后的申请")',
            ),
          'Single-step AI undo',
        );
        await shortcut('y', 89);
        await until(
          () => editor.executeJavaScript('document.body.innerText.includes("AI 修改后的申请")'),
          'AI redo',
        );
        await win.webContents.executeJavaScript('window.fixturePrepareDiagram()');
        const stale = await win.webContents.executeJavaScript('window.fixtureSnapshot');
        await editor.executeJavaScript(`(() => {
          const label = [...document.querySelectorAll('foreignObject div')].find(element => element.textContent === 'AI 修改后的申请' && !element.childElementCount);
          const bounds = label.getBoundingClientRect();
          label.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, button:0, clientX:bounds.x+bounds.width/2, clientY:bounds.y+bounds.height/2 }));
        })()`);
        await until(
          () =>
            editor.executeJavaScript(
              'Boolean(document.querySelector(".mxCellEditor[contenteditable=true]"))',
            ),
          'Uncommitted manual editing',
        );
        await editor.executeJavaScript(
          `(() => { const input = document.querySelector('.mxCellEditor[contenteditable=true]'); input.textContent='尚未按回车的手工修改'; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); })()`,
        );
        if (process.argv.includes('--reference')) {
          const reads = await win.webContents.executeJavaScript('window.fixtureViewReads');
          // Historical/local-only presentations use the same editor but must not
          // add a second host notice row above the App's own title and toolbar.
          const inactive = await win.webContents.executeJavaScript('window.fixtureView.inactive');
          await win.webContents.executeJavaScript(
            'window.fixtureView.inactive=true;window.fixtureView.updateComplete',
          );
          await editor.executeJavaScript('window.referenceDocumentInstance=Math.random()');
          const instance = await editor.executeJavaScript('window.referenceDocumentInstance');
          for (const pinned of [true, false, true, false]) {
            await win.webContents.executeJavaScript(`window.fixtureReference(${pinned})`);
            await until(
              () =>
                win.webContents.executeJavaScript(`window.fixtureView.fillContainer===${pinned}`),
              'Reference presentation mode',
            );
            await win.webContents.executeJavaScript('window.fixtureView.updateComplete');
            if (pinned) {
              assert.equal(
                await win.webContents.executeJavaScript(
                  'Array.from(window.fixtureView.shadowRoot.querySelectorAll(".notice")).filter(node=>node.getClientRects().length).length',
                ),
                0,
                'Workspace local editing hints must not reserve a separate row',
              );
              assert.equal(
                await win.webContents.executeJavaScript(
                  'window.fixtureView.shadowRoot.querySelector("iframe").getBoundingClientRect().top-window.fixtureView.getBoundingClientRect().top',
                ),
                0,
                'The App starts at the top of its workspace surface',
              );
              fs.writeFileSync(
                path.join(output, 'reference-compact.png'),
                (await win.webContents.capturePage()).toPNG(),
              );
            } else {
              assert.equal(
                await win.webContents.executeJavaScript(
                  'window.fixtureView.shadowRoot.querySelector("header .notice")?.textContent.trim() ?? ""',
                ),
                '',
                'Optional local editing hints do not occupy the inline title row',
              );
              await until(
                () =>
                  win.webContents.executeJavaScript(
                    'window.fixtureView.shadowRoot.querySelector("header").hasAttribute("shared")',
                  ),
                'Inline shared header restored',
              );
              await win.webContents.executeJavaScript(
                'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
              );
              const bounds = await win.webContents.executeJavaScript(
                'window.fixtureView.getBoundingClientRect().toJSON()',
              );
              fs.writeFileSync(
                path.join(output, 'drawio-inline-single-header.png'),
                (
                  await win.webContents.capturePage({
                    x: Math.ceil(bounds.x),
                    y: Math.ceil(bounds.y),
                    width: Math.floor(bounds.width),
                    height: 105,
                  })
                ).toPNG(),
              );
            }
            await until(
              () =>
                editor.executeJavaScript(
                  'document.querySelector(".mxCellEditor[contenteditable=true]")?.textContent==="尚未按回车的手工修改"',
                ),
              'Uncommitted text survives reference move',
            );
          }
          assert.equal(
            await editor.executeJavaScript('window.referenceDocumentInstance'),
            instance,
          );
          assert.equal(await win.webContents.executeJavaScript('window.fixtureViewReads'), reads);
          await win.webContents.executeJavaScript(
            `window.fixtureView.inactive=${inactive};window.fixtureView.updateComplete`,
          );
          assert.equal(
            await win.webContents.executeJavaScript(
              'window.fixtureView.shadowRoot.querySelector("iframe")===window.fixtureOriginalFrame',
            ),
            true,
          );
          console.log(
            'Actual draw.io reference pin/unpin retains document, uncommitted node text and native view reads.',
          );
        }
        const conflict = await win.webContents.executeJavaScript(
          `window.fixtureApplyDiagram(${JSON.stringify(stale.xml.replaceAll('AI 修改后的申请', '不应覆盖手改'))})`,
        );
        assert.equal(conflict.status, 'conflict');
        await until(
          () =>
            editor.executeJavaScript('document.body.innerText.includes("尚未按回车的手工修改")'),
          'Manual edit preserved',
        );
        await win.webContents.executeJavaScript('window.fixturePrepareDiagram()');
        const current = await win.webContents.executeJavaScript('window.fixtureSnapshot');
        assert.match(current.xml, /尚未按回车的手工修改/);
        await shortcut('z', 90);
        await until(
          () => editor.executeJavaScript('document.body.innerText.includes("AI 修改后的申请")'),
          'Existing manual undo stack retained',
        );
        await shortcut('z', 90);
        await until(
          () =>
            editor.executeJavaScript(
              'document.body.innerText.includes("提交申请") && !document.body.innerText.includes("AI 修改后的申请")',
            ),
          'Earlier AI undo remains available',
        );
        await win.webContents.executeJavaScript('window.fixturePrepareDiagram()');
        const originalPage = await win.webContents.executeJavaScript('window.fixtureSnapshot');
        const extraPage =
          '<diagram id="second-page" name="第二页"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>';
        const pages = originalPage.xml.replace('</mxfile>', extraPage + '</mxfile>');
        const paged = await win.webContents.executeJavaScript(
          `window.fixtureApplyDiagram(${JSON.stringify(pages)})`,
        );
        assert.equal(paged.status, 'applied');
        await until(
          () => editor.executeJavaScript('document.body.innerText.includes("第二页")'),
          'AI multipage update',
        );
        await shortcut('z', 90);
        await until(
          () =>
            editor.executeJavaScript(
              '!document.body.innerText.includes("第二页") && document.body.innerText.includes("提交申请")',
            ),
          'Single-step multipage undo',
        );
        await until(
          () =>
            win.webContents.executeJavaScript(
              '!window.fixtureView.loading && !window.fixtureView.error && !window.fixtureView.shadowRoot.querySelector(".status")',
            ),
          'Product host finished loading',
        );
        await editor.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        await win.webContents.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        await win.webContents.capturePage();
        assert.deepEqual(blocked, []);
        fs.writeFileSync(
          path.join(
            output,
            `editing${process.argv.includes('--blank') ? '-blank' : process.argv.includes('--file') ? '-file' : ''}-result.json`,
          ),
          JSON.stringify(
            {
              passed: true,
              sameIframe: true,
              singleUndo: true,
              retainedUndo: true,
              multipageUndo: true,
              uncommittedConflict: true,
              noPublicRequests: true,
            },
            null,
            2,
          ),
        );
        fs.writeFileSync(
          path.join(output, 'editing.png'),
          (await win.webContents.capturePage()).toPNG(),
        );
        console.log(
          'Real offline editor continuous update, undo/redo and uncommitted-edit conflict passed.',
        );
        return;
      }
      let currentLabel = '提交申请';
      for (const format of ['save', 'png', 'svg']) {
        const editedLabel = `${format} 前即时修改`;
        await editor.executeJavaScript(`(() => {
          const label = [...document.querySelectorAll('foreignObject div')].find(
            element => element.textContent === ${JSON.stringify(currentLabel)} && !element.childElementCount,
          );
          if (!label) throw new Error('Diagram label missing');
          const bounds = label.getBoundingClientRect();
          label.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true, button: 0,
            clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2,
          }));
        })()`);
        await until(
          () =>
            editor.executeJavaScript(
              'Boolean(document.querySelector(".mxCellEditor[contenteditable=true]"))',
            ),
          `${format} cell editing`,
        );
        await editor.executeJavaScript(`(() => {
          const input = document.querySelector('.mxCellEditor[contenteditable=true]');
          input.textContent = ${JSON.stringify(editedLabel)};
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        })()`);
        await inner.executeJavaScript(`document.querySelector('#${format}').click()`);
        const count = ['save', 'png', 'svg'].indexOf(format) + 1;
        await until(
          () => win.webContents.executeJavaScript(`window.downloads.length === ${count}`),
          `${format} export`,
        );
        assert.equal(
          await editor.executeJavaScript(
            'Boolean(document.querySelector(".mxCellEditor[contenteditable=true]"))',
          ),
          false,
          `${format} commits active cell text before export`,
        );
        currentLabel = editedLabel;
      }
      const downloads = await win.webContents.executeJavaScript('window.downloads');
      for (const file of downloads) {
        const bytes = Buffer.from(file.dataBase64, 'base64');
        fs.writeFileSync(path.join(output, file.fileName), bytes);
        if (file.mimeType === 'image/png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
        else if (file.mimeType === 'image/svg+xml') {
          assert.match(bytes.toString(), /<svg/);
          assert.match(bytes.toString(), /svg 前即时修改/);
        } else {
          assert.match(bytes.toString(), /mxfile/);
          assert.match(bytes.toString(), /save 前即时修改/);
        }
      }
      // Commit the latest edit to a source file before leaving the editor, so
      // the fixture exercises the normal saved-document navigation path too.
      await inner.executeJavaScript("document.querySelector('#save').click()");
      await until(
        () => win.webContents.executeJavaScript('window.downloads.length === 4'),
        'Save latest diagram edits',
      );
      const latestSource = await win.webContents.executeJavaScript('window.downloads[3]');
      const latestBytes = Buffer.from(latestSource.dataBase64, 'base64');
      assert.match(latestBytes.toString(), /svg 前即时修改/);
      evidence.sourceExported = true;
      fs.writeFileSync(path.join(output, latestSource.fileName), latestBytes);
      assert.deepEqual(blocked, [], 'No public request is needed');
      await new Promise(resolve => setTimeout(resolve, 1000));
      fs.writeFileSync(
        path.join(output, 'drawio-inline.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.webContents.executeJavaScript(
        'window.fixtureEditorFrame=window.fixtureView.shadowRoot.querySelector("iframe");window.fixtureView.shadowRoot.querySelector("[data-action=display-mode]").click();true',
      );
      await until(
        () => win.webContents.executeJavaScript('window.fixtureView.expanded'),
        'Expand diagram',
      );
      await new Promise(resolve => setTimeout(resolve, 1000));
      fs.writeFileSync(
        path.join(output, 'drawio-expanded.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      for (let cycle = 0; cycle < 2; cycle++) {
        await win.webContents.executeJavaScript(
          'window.fixtureView.shadowRoot.querySelector("[data-action=dismiss]").click();true',
        );
        await until(
          () => win.webContents.executeJavaScript('!window.fixtureView.expanded'),
          'Return to inline diagram',
        );
        assert.equal(
          await win.webContents.executeJavaScript(
            '!window.fixtureView.closed && window.fixtureView.shadowRoot.querySelector("iframe") === window.fixtureEditorFrame && window.fixtureEditorFrame.isConnected',
          ),
          true,
          'The same diagram frame must survive closing its expanded presentation',
        );
        assert.equal(
          await editor.executeJavaScript('document.body.innerText.includes("svg 前即时修改")'),
          true,
          'Returning from expansion must preserve edited node text',
        );
        if (cycle === 0) {
          await inner.executeJavaScript('document.querySelector("#save").click()');
          await until(
            () => win.webContents.executeJavaScript('window.downloads.length === 5'),
            'Save after returning from expansion',
          );
          const afterReturn = await win.webContents.executeJavaScript('window.downloads[4]');
          assert.match(Buffer.from(afterReturn.dataBase64, 'base64').toString(), /svg 前即时修改/);
          await new Promise(resolve => setTimeout(resolve, 500));
          fs.writeFileSync(
            path.join(output, 'drawio-returned-inline.png'),
            (await win.webContents.capturePage()).toPNG(),
          );
        }
        await win.webContents.executeJavaScript(
          'window.fixtureView.shadowRoot.querySelector("[data-action=display-mode]").click();true',
        );
        await until(
          () => win.webContents.executeJavaScript('window.fixtureView.expanded'),
          'Expand the same diagram again',
        );
      }
      await win.webContents.executeJavaScript(
        'document.documentElement.classList.add("dark");document.documentElement.dataset.theme="classic-dark"',
      );
      await until(
        () => editor.executeJavaScript('Boolean(document.querySelector(".geDarkMode"))'),
        'Live theme',
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(
        path.join(output, 'drawio-dark.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      win.setSize(560, 720);
      await until(() => editor.executeJavaScript('innerWidth < 550'), 'Nested frame resized');
      await until(
        () =>
          inner.executeJavaScript(
            'document.querySelector("#svg").getBoundingClientRect().right <= innerWidth',
          ),
        'Narrow export controls',
      );
      await until(
        () =>
          win.webContents.executeJavaScript(
            'document.documentElement.scrollWidth <= document.documentElement.clientWidth',
          ),
        'Narrow layout',
      );
      const viewport = await editor.executeJavaScript(
        '({ height: innerHeight, scroll: document.documentElement.scrollHeight, children: [...document.body.children].filter(e=>e.className).map(e=>({cls:String(e.className).slice(0,60), top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})) })',
      );
      const layout = await win.webContents.executeJavaScript(
        '(()=>{const v=document.querySelector("mcp-app-view");return [v,...v.shadowRoot.querySelectorAll("header,.mount,iframe")].map(e=>({tag:e.tagName,cls:e.className,h:e.getBoundingClientRect().height}))})()',
      );
      assert.ok(
        viewport.scroll <= viewport.height + 2,
        'Editor toolbar stays inside the expanded viewport',
      );
      await new Promise(resolve => setTimeout(resolve, 500));
      fs.writeFileSync(
        path.join(output, 'drawio-narrow.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.webContents.executeJavaScript(
        '(async()=>{const view=window.fixtureView;view.shadowRoot.querySelector("[data-action=dismiss]").click();await view.updateComplete;view.fillContainer=true;document.body.style.cssText="margin:0;height:100vh;max-width:none";await view.updateComplete;return true})()',
      );
      await until(
        () =>
          win.webContents.executeJavaScript(
            'getComputedStyle(window.fixtureView.shadowRoot.querySelector("header")).display === "none"',
          ),
        'Workspace hides the duplicate host title bar',
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          'window.fixtureView.shadowRoot.querySelector("iframe") === window.fixtureEditorFrame && !window.fixtureView.closed',
        ),
        true,
        'Workspace layout must keep the same editor document',
      );
      assert.equal(
        await editor.executeJavaScript('document.body.innerText.includes("svg 前即时修改")'),
        true,
      );
      assert.ok(
        await inner.executeJavaScript(
          'document.querySelector("#toolbar").getBoundingClientRect().top === 0 && document.querySelector("#svg").getBoundingClientRect().right <= innerWidth',
        ),
        'The editor has one top toolbar with all export controls',
      );
      await editor.executeJavaScript(`(() => {
        const label = [...document.querySelectorAll('foreignObject div')].find(
          element => element.textContent === 'svg 前即时修改' && !element.childElementCount);
        const bounds = label.getBoundingClientRect();
        label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0,
          clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 }));
      })()`);
      await until(
        () =>
          editor.executeJavaScript(
            'Boolean(document.querySelector(".mxCellEditor[contenteditable=true]"))',
          ),
        'Edit before switching sessions',
      );
      await editor.executeJavaScript(`(() => {
        const input = document.querySelector('.mxCellEditor[contenteditable=true]');
        input.textContent = '切换前未保存的修改';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      })()`);
      await win.webContents.executeJavaScript('window.fixtureView.prepareContext()');
      const firstSendContext = await win.webContents.executeJavaScript(
        'window.fixtureModelContext',
      );
      assert.match(
        JSON.stringify(firstSendContext),
        /切换前未保存的修改/,
        'First send captures the current cell text without saving a file',
      );
      assert.equal(
        await win.webContents.executeJavaScript('window.downloads.length'),
        5,
        'Context preparation must not export a file',
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          'window.fixtureView.shadowRoot.querySelector("iframe") === window.fixtureEditorFrame',
        ),
        true,
        'Context preparation keeps the same editor document',
      );
      evidence.firstSendContextCapturesUnsavedCell = true;
      await win.webContents.executeJavaScript('window.fixtureSwitchSession(false);true');
      await win.webContents.executeJavaScript('window.fixtureSwitchSession(true);true');
      await until(
        () => win.webContents.executeJavaScript('window.fixtureView.context.isCurrent()'),
        'Return to the original drawing session',
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          'window.fixtureView.shadowRoot.querySelector("iframe") === window.fixtureEditorFrame',
        ),
        true,
        'Switching sessions preserves the actual draw.io editor',
      );
      assert.equal(
        await editor.executeJavaScript('document.body.innerText.includes("切换前未保存的修改")'),
        true,
        'Unexported draw.io edits survive a session switch',
      );
      await inner.executeJavaScript('document.querySelector("#save").click()');
      await until(
        () => win.webContents.executeJavaScript('window.downloads.length === 6'),
        'Save from the compact workspace',
      );
      const workspaceSource = await win.webContents.executeJavaScript('window.downloads[5]');
      assert.match(
        Buffer.from(workspaceSource.dataBase64, 'base64').toString(),
        /切换前未保存的修改/,
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(
        path.join(output, 'drawio-workspace-toolbar-dark.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.webContents.executeJavaScript(
        'document.documentElement.classList.remove("dark");document.documentElement.dataset.theme="classic-light"',
      );
      await until(
        () => editor.executeJavaScript('!document.querySelector(".geDarkMode")'),
        'Compact workspace light theme',
      );
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(
        path.join(output, 'drawio-workspace-toolbar-light.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.loadURL(running.url + '/?list=1');
      await until(
        () =>
          win.webContents.executeJavaScript(
            '[...document.querySelectorAll("[role=note]")].some(note=>note.textContent==="APP")',
          ),
        'MCP interface badge',
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          '[...document.querySelectorAll("[role=note]")].filter(note=>note.textContent==="APP").length',
        ),
        1,
      );
      await new Promise(resolve => setTimeout(resolve, 500));
      fs.writeFileSync(
        path.join(output, 'mcp-interface-badge.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      assert.deepEqual(
        errors.filter(
          message => !message.includes("Unrecognized Content-Security-Policy directive 'webrtc'"),
        ),
        [],
      );
      console.log(
        JSON.stringify(
          {
            coldProfile: true,
            file: evidence.file,
            compressed: evidence.compressed,
            publicRequests: blocked.length,
            expandedCloseReturnsInline: true,
            returnedDiagramRetainsEdits: true,
            returnedDiagramCanExport: true,
            workspaceSingleToolbar: true,
            workspaceEditorRetainsEditsAndExports: true,
            sessionSwitchRetainsUnsavedDrawioEdit: true,
            exports: downloads.map(file => file.mimeType),
            errors,
            viewport,
            layout,
          },
          null,
          2,
        ),
      );
    })
    .then(async () => {
      if (evidence.forcedUnsafePort) {
        assert.notEqual(new URL(running.assetOrigin).port, '6000');
        assert.ok(running.portAttempts.length >= 2, 'The service must retry the blocked port');
        assert.deepEqual(
          evidence.requestErrors.filter(failure => failure.error.includes('ERR_UNSAFE_PORT')),
          [],
          'Chromium must never receive the rejected allocation',
        );
      }
      savePortEvidence();
      if (evidence.forcedUnsafePort) console.log(JSON.stringify(evidence, null, 2));
      win?.destroy();
      await running?.close();
      app.exit(0);
    })
    .catch(async error => {
      savePortEvidence(error);
      console.error(error);
      win?.destroy();
      await running?.close();
      app.exit(1);
    });
}
