'use strict';

// Exercises the real React controls in Chromium and captures light/dark/narrow states.
// The controls discover only real entrypoints supplied by the isolated fixture.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.agent-tasks/mcp-apps/product-ui');
fs.mkdirSync(output, { recursive: true });
if (!process.versions.electron) {
  void (async () => {
    const css = fs
      .readdirSync(path.join(root, 'dist/assets'))
      .find(file => /^main-.*\.css$/.test(file));
    if (!css) throw new Error('Run npm run build first');
    fs.copyFileSync(path.join(root, 'dist/assets', css), path.join(output, 'product.css'));
    await require('esbuild').build({
      entryPoints: [path.join(__dirname, 'product-ui-host.tsx')],
      outfile: path.join(output, 'host.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'chrome140',
      jsx: 'automatic',
      alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') },
    });
    const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
      cwd: root,
      stdio: 'inherit',
      timeout: 180000,
      windowsHide: true,
    });
    process.exit(result.status ?? 1);
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(output, 'profile'));
  let win;
  const server = http.createServer((req, res) => {
    if (req.url === '/host.js' || req.url === '/product.css') {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(fs.readFileSync(path.join(output, req.url.slice(1))));
      return;
    }
    res.end(
      '<html lang="zh" data-theme="classic-light"><head><meta charset="UTF-8"><link rel="stylesheet" href="/product.css"><style>body{margin:0;padding:32px;font:14px system-ui;background:var(--justdo-background);color:var(--justdo-text-primary)}#root{height:auto;min-height:0;max-width:720px;margin:0 auto;background:var(--justdo-surface);border:1px solid var(--justdo-border);border-radius:16px}</style></head><body><div id="root"></div><script type="module" src="/host.js"></script></body></html>',
    );
  });
  const finish = code => {
    win?.destroy();
    server.close();
    app.exit(code);
  };
  app
    .whenReady()
    .then(async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      win = new BrowserWindow({
        show: false,
        width: 900,
        height: 850,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      const errors = [];
      win.webContents.on('console-message', event => {
        if (event.level === 'error') errors.push(event.message);
      });
      await win.loadURL('http://127.0.0.1:' + server.address().port);
      const js = source => win.webContents.executeJavaScript(source);
      const until = async source => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await js(source)) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Product UI timed out: ' + source + ': ' + errors.join('; '));
      };
      const click = text =>
        js(
          `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}||b.title===${JSON.stringify(text)});if(!button)throw Error('Missing button');button.click();return true})()`,
        );
      const capture = async name => {
        await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        fs.writeFileSync(
          path.join(output, name + '.png'),
          (await win.webContents.capturePage()).toPNG(),
        );
      };
      await until('Boolean(document.querySelector("button[aria-expanded]"))');
      if (await js('document.body.textContent.includes("春季发布计划")'))
        throw new Error('App selection must not render a badge above the composer');
      await capture('collapsed');
      if (
        await js(
          'Boolean([...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="应用"))',
        )
      )
        throw new Error('Standalone Apps button should be absent');
      await click('添加');
      await until(
        'Boolean([...document.querySelectorAll("[role=menuitem]")].find(b=>b.getAttribute("aria-label")==="draw.io"))',
      );
      if (
        !(await js(
          'document.querySelector("[role=menu]").getAttribute("aria-label") === "添加" && ["应用","插件"].every(label=>[...document.querySelectorAll("[role=presentation]")].some(group=>group.textContent.trim()===label)) && ![...document.querySelectorAll("[role=menuitem]")].some(item=>item.textContent.trim()==="应用")',
        ))
      )
        throw new Error('Apps and Plugins should be sibling groups in the root menu');
      if (await js('document.querySelector("[role=menu]").getBoundingClientRect().top < 0'))
        throw new Error('Grouped menu is clipped above the viewport');
      await capture('apps-group-light');
      await js(
        'document.documentElement.dataset.theme="classic-dark";document.documentElement.classList.add("dark");true',
      );
      await until(
        'getComputedStyle(document.querySelector("[role=menuitem]")).color === "rgb(230, 230, 230)"',
      );
      await capture('apps-group-dark');
      win.setSize(420, 850);
      await capture('apps-group-narrow');
      if (await js('document.documentElement.scrollWidth > innerWidth'))
        throw new Error('Narrow Apps menu overflows horizontally');
      win.setSize(900, 850);
      await js(
        'document.documentElement.dataset.theme="classic-light";document.documentElement.classList.remove("dark");true',
      );
      await until(
        'getComputedStyle(document.querySelector("[role=menuitem]")).color === "rgb(29, 32, 38)"',
      );
      await click('项目日历');
      await until('document.body.textContent.includes("任务看板")');
      await capture('catalog-light');
      await js(
        'document.documentElement.dataset.theme="classic-dark";document.documentElement.classList.add("dark");true',
      );
      await until(
        'getComputedStyle(document.querySelector("button[title=任务看板]")).color === "rgb(230, 230, 230)"',
      );
      await capture('catalog-dark');
      await js(
        'document.documentElement.dataset.theme="classic-light";document.documentElement.classList.remove("dark");true',
      );
      await until(
        'getComputedStyle(document.querySelector("button[title=任务看板]")).color === "rgb(29, 32, 38)"',
      );
      await click('服务设置');
      await until('document.body.textContent.includes("每页显示")');
      await capture('settings');
      await click('取消');
      await js('window.fixtureQuestion(true);true');
      await until('document.body.textContent.includes("选择保存位置")');
      await capture('question');
      win.setSize(420, 850);
      await capture('narrow');
      const overflow = await js('document.documentElement.scrollWidth > innerWidth');
      if (overflow) throw new Error('Narrow controls overflow horizontally');
      if (errors.length) throw new Error(errors.join('; '));
      console.log(
        'MCP Apps product UI passed: sibling Apps/Plugins groups, multiple apps, catalog, settings, question, light/dark, narrow layout',
      );
      finish(0);
    })
    .catch(async error => {
      console.error(error);
      if (win)
        console.error(
          await win.webContents.executeJavaScript(
            'JSON.stringify([...document.querySelectorAll("button")].map(button=>({text:button.textContent.trim(),label:button.getAttribute("aria-label"),title:button.title})))',
          ),
        );
      finish(1);
    });
}
