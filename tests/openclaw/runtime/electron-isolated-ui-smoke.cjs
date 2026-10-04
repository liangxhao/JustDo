'use strict';

// Read-only desktop smoke. Run only after the Electron native ABI is restored.
// PLAYWRIGHT_MODULE may point at an existing externally provisioned playwright package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '../../..');
  const metadata = require(path.join(root, 'package.json'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-electron-ui-'));
  const home = path.join(fixture, 'home');
  const appData = path.join(fixture, 'roaming');
  const localAppData = path.join(fixture, 'local');
  const profile = path.join(fixture, 'profile');
  for (const directory of [home, appData, localAppData, profile]) fs.mkdirSync(directory);
  const dist = path.join(root, 'dist');
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    let target = path.resolve(dist, '.' + pathname);
    if (target !== dist && !target.startsWith(dist + path.sep)) {
      response.writeHead(403).end(); return;
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(dist, 'index.html');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
    response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = path.join(fixture, 'bootstrap.cjs');
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: metadata.name, productName: metadata.productName, version: metadata.version, main: 'bootstrap.cjs' }));
  fs.writeFileSync(bootstrap, [
    "const { app } = require('electron');",
    `app.setPath('appData', ${JSON.stringify(appData)});`,
    `app.setPath('userData', ${JSON.stringify(profile)});`,
    `app.setPath('home', ${JSON.stringify(home)});`,
    `app.setAppPath(${JSON.stringify(root)});`,
    `require(${JSON.stringify(path.join(root, metadata.main))});`,
  ].join('\n'));
  const env = { ...process.env, NODE_ENV: 'development', JUSTDO_DEV_USER_DATA_DIR: profile, ELECTRON_START_URL: url, JUSTDO_DEV_SERVER_PORT: String(server.address().port), APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: home, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: path.join(profile, 'openclaw') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENCLAW_CONFIG_PATH;
  let app;
  const result = { fixture, checks: [], rendererErrors: [] };
  try {
    app = await electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: [fixture], cwd: root, env, timeout: 90000 });
    const paths = await app.evaluate(({ app }) => ({ appData: app.getPath('appData'), userData: app.getPath('userData'), home: app.getPath('home'), packaged: app.isPackaged }));
    assert.deepEqual(paths, { appData, userData: profile, home, packaged: false });
    result.paths = paths;
    app.process().stdout.on('data', data => fs.appendFileSync(path.join(fixture, 'stdout.log'), data));
    app.process().stderr.on('data', data => fs.appendFileSync(path.join(fixture, 'stderr.log'), data));
    const page = await app.firstWindow({ timeout: 90000 });
    page.on('pageerror', error => result.rendererErrors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).waitFor({ timeout: 90000 });
    const deadline = Date.now() + 90000;
    while (true) {
      const status = await page.evaluate(() => globalThis.electron.openclaw.engine.getStatus());
      if (status.success && status.status?.phase === 'running') {
        assert.equal(status.status.version?.replace(/^v/, ''), '2026.9.8');
        result.engine = { phase: status.status.phase, version: status.status.version };
        break;
      }
      assert.notEqual(status.status?.phase, 'error', 'native Gateway failed to start');
      assert.ok(Date.now() < deadline, 'native Gateway did not reach running');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const snapshot = async label => {
      fs.writeFileSync(path.join(fixture, `${label}.txt`), await page.locator('body').innerText());
      await page.screenshot({ path: path.join(fixture, `${label}.png`) });
      result.checks.push(label);
    };
    await page.getByRole('button', { name: /^(执行权限|Execution permissions)$/ }).waitFor();
    await snapshot('01-home');
    await page.getByRole('button', { name: /^(执行权限|Execution permissions)$/ }).click();
    for (const label of [/请求批准|Ask for approval/, /智能审批|Smart approval/, /完全权限|Full access/]) {
      await page.getByRole('option', { name: label }).waitFor();
    }
    await snapshot('01-permission-options');
    await page.getByRole('button', { name: /^(执行权限|Execution permissions)$/ }).click();
    await page.getByRole('button', { name: /^(记忆|Memory)$/ }).click();
    await snapshot('02-memory');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).click();
    await snapshot('03-settings');
    await page.getByRole('button', { name: /^(模型|Model)$/ }).click();
    await page.getByRole('heading', { name: /^(模型|Model)$/ }).waitFor();
    await snapshot('04-models');
    await page.getByRole('button', { name: /^(安全|Security)$/ }).click();
    await page.getByRole('heading', { name: /^(安全|Security)$/ }).waitFor();
    await snapshot('05-permissions');
    await page.getByRole('button', { name: /^(返回|Back)$/ }).click();
    await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click();
    await page.getByText(/^(系统与内置|System & built-in)$/).waitFor({ timeout: 45000 });
    await snapshot('06-plugins');
    await page.getByRole('button', { name: /^(定时任务|Scheduled Tasks)/ }).click();
    await page.getByRole('button', { name: /^(新建任务|New task|Create task)$/i }).waitFor();
    await snapshot('07-tasks');
    await page.getByRole('button', { name: /^(任务看板|Workboard)$/ }).click();
    await page.getByText(/^(暂无卡片|No cards)$/).first().waitFor({ timeout: 45000 });
    await snapshot('08-workboard');
    const finalStatus = await page.evaluate(() => globalThis.electron.openclaw.engine.getStatus());
    assert.equal(finalStatus.status?.phase, 'running', 'Gateway must remain running after navigation');
    assert.deepEqual(result.rendererErrors, [], 'unexpected renderer page errors');
    result.ok = true;
  } catch (error) {
    result.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
