// Check real Chromium PDF loading with an isolated profile, without Gateway or public network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const root = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-native-pdf-'));
  const entry = path.join(fixture, 'entry.js');
  fs.writeFileSync(
    entry,
    [
      `export { readPreviewFile } from ${JSON.stringify(path.join(root, 'src/main/ipc/app/shell.ts'))};`,
      `export * from ${JSON.stringify(path.join(root, 'src/main/core/window/browserPanelSecurity.ts'))};`,
    ].join('\n'),
  );
  require('esbuild').buildSync({
    entryPoints: [entry],
    outfile: path.join(fixture, 'browser.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  });
  const env = { ...process.env };
  env.NODE_PATH = path.join(root, 'node_modules');
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(
    require('electron'),
    [__filename, fixture],
    {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
      timeout: 55000,
    },
  );
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.argv[2];
  app.setPath('userData', path.join(fixture, 'profile'));
  const deadline = setTimeout(() => app.exit(1), 45000);
  app
    .whenReady()
    .then(async () => {
      const {
        readPreviewFile,
        isAllowedBrowserPanelNavigationUrl,
        isBrowserPdfStreamNavigation,
      } = require(path.join(fixture, 'browser.cjs'));
      const stream = 'BT /F1 24 Tf 40 160 Td (Native PDF preview) Tj ET';
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      let pdf = '%PDF-1.4\n';
      const offsets = [0];
      objects.forEach((object, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = pdf.length;
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
      const filePath = path.join(fixture, 'native #100%.pdf');
      fs.writeFileSync(filePath, pdf);
      const prepared = await readPreviewFile(filePath);
      assert.equal(prepared.success, true);
      assert.equal(prepared.kind, 'pdf');
      assert.equal(new URL(prepared.url).protocol, 'file:');
      const server = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/pdf');
        response.end(pdf);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const host = new BrowserWindow({
        show: false,
        width: 900,
        height: 700,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      host.webContents.on('will-attach-webview', (_event, preferences) =>
        Object.assign(preferences, {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          plugins: true,
        }),
      );
      const attached = new Promise(resolve =>
        host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)),
      );
      await host.loadURL(
        'data:text/html,<body style="margin:0"><webview style="width:100vw;height:100vh" plugins="true" src="about:blank"></webview></body>',
      );
      const guest = await attached;
      guest.on('will-frame-navigate', event => {
        if (
          !isBrowserPdfStreamNavigation(event.url, event.isMainFrame, event.frame?.parent?.url) &&
          !isAllowedBrowserPanelNavigationUrl(event.url)
        )
          event.preventDefault();
      });
      const until = async predicate => {
        for (let attempt = 0; attempt < 150; attempt++) {
          try {
            const result = await predicate();
            if (result) return result;
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Native PDF viewer did not finish loading');
      };
      for (const [name, url] of [
        ['file', prepared.url],
        ['http', `http://127.0.0.1:${server.address().port}/report.pdf`],
      ]) {
        await guest.loadURL(url).catch(error => {
          if (error.code !== 'ERR_ABORTED') throw error;
        });
        const frame = await until(() =>
          guest.mainFrame.framesInSubtree.find(candidate =>
            candidate.url.startsWith(
              'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
            ),
          ),
        );
        const state = await until(() =>
          frame.executeJavaScript(
            `(() => { const viewer = document.querySelector('pdf-viewer'); const pages = viewer?.documentDimensions?.pageDimensions?.length; return viewer?.loadState_ === 'success' && pages > 0 && { pages, loaded: viewer.loadState_ }; })()`,
          ),
        );
        console.log(JSON.stringify({ name, state }));
        await frame.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
        fs.writeFileSync(
          path.join(fixture, `${name}.png`),
          (await host.webContents.capturePage()).toPNG(),
        );
      }
      console.log(JSON.stringify({ ok: true, fixture }));
      server.close();
      clearTimeout(deadline);
      app.exit(0);
    })
    .catch(error => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
