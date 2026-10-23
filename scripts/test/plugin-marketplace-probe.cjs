'use strict';

// Opt-in integration probe: real Electron IPC + production installers + an isolated
// native Gateway. The market is loopback-only and all packages are generated here.
// node scripts/test/plugin-marketplace-probe.cjs --runtime <prepared-runtime-root>
// Optional: --runtime-dependencies <same-version-complete-runtime-root>
// PLAYWRIGHT_MODULE can point at an externally provisioned playwright package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'tests/electron/plugin-marketplace');
const args = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--runtime', '--runtime-dependencies'].includes(args[index]) && args[index + 1] && !flags.has(args[index]),
    'Expected --runtime <root> and optional --runtime-dependencies <same-version-root>');
  flags.set(args[index], args[index + 1]);
}
const runtimeRoot = path.resolve(flags.get('--runtime') || path.join(root, 'vendor/openclaw-runtime/current'));
const nativeDependenciesRoot = flags.has('--runtime-dependencies') ? path.resolve(flags.get('--runtime-dependencies')) : undefined;
assert.ok(fs.existsSync(path.join(runtimeRoot, 'gateway-bundle.mjs')), 'Prepare the locked native runtime or pass its existing directory with --runtime');
const artifactRoot = path.join(root, '.agent-tasks/plugin-marketplace');
fs.mkdirSync(artifactRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(artifactRoot, 'probe-中文 空格-'));
const output = path.join(root, 'build/plugin-marketplace', path.basename(runRoot));
fs.mkdirSync(output, { recursive: true });
for (const name of ['home', 'roaming', 'local', 'profile', 'tmp']) fs.mkdirSync(path.join(runRoot, name));
const report = { runRoot, output, runtimeRoot, checks: [], rendererErrors: [] };

async function until(read, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The real IPC state did not satisfy the probe assertion in time');
}

async function main() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  // Large offline copies must finish before Electron/inspector startup deadlines.
  console.log('[Marketplace probe] Verifying the isolated native runtime copy');
  require(path.join(fixture, 'native-runtime.cjs')).prepareRuntime(fs.realpathSync(runtimeRoot), nativeDependenciesRoot);
  console.log('[Marketplace probe] Building the isolated Electron fixture');
  await build({
    entryPoints: [path.join(fixture, 'ui.tsx')], bundle: true, format: 'iife',
    outfile: path.join(output, 'bundle.js'), tsconfig: path.join(root, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logOverride: { 'empty-import-meta': 'silent' },
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.png': 'file', '.webp': 'file' },
  });
  await build({
    entryPoints: [path.join(fixture, 'preload.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: path.join(output, 'preload.cjs'),
  });
  await build({
    entryPoints: [path.join(fixture, 'main-services.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron', 'better-sqlite3'], outfile: path.join(output, 'services.cjs'),
  });
  const tailwind = require('tailwindcss/loadConfig')(path.join(root, 'tailwind.config.js'));
  const styles = await require('postcss')([require('tailwindcss')({
    ...tailwind, content: [...tailwind.content, path.join(fixture, 'ui.tsx')],
  })]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: path.join(root, 'src/renderer/index.css') });
  fs.writeFileSync(path.join(output, 'layout.css'), styles.css + '\nhtml,body{margin:0}body{font-family:system-ui,sans-serif}');
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><link rel="stylesheet" href="/layout.css"><div id="root"></div><script src="/bundle.js"></script></html>');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith('OPENCLAW_') && !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())));
  Object.assign(env, {
    NODE_ENV: 'test', APPDATA: path.join(runRoot, 'roaming'), LOCALAPPDATA: path.join(runRoot, 'local'),
    HOME: path.join(runRoot, 'home'), USERPROFILE: path.join(runRoot, 'home'),
    TMP: path.join(runRoot, 'tmp'), TEMP: path.join(runRoot, 'tmp'),
  });
  let app;
  try {
    console.log('[Marketplace probe] Starting isolated Electron and native Gateway');
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [path.join(fixture, 'main.cjs'), output, runRoot, runtimeRoot, process.execPath, nativeDependenciesRoot || ''],
      cwd: root, env, timeout: 120000,
    });
    app.process().stdout.on('data', data => fs.appendFileSync(path.join(runRoot, 'main-stdout.log'), data));
    app.process().stderr.on('data', data => fs.appendFileSync(path.join(runRoot, 'main-stderr.log'), data));
    const page = await app.firstWindow();
    page.on('pageerror', error => report.rendererErrors.push(error.message));
    page.setDefaultTimeout(60000);
    const actualPaths = await app.evaluate(({ app }) => ({ profile: app.getPath('userData'), home: app.getPath('home') }));
    assert.deepEqual(actualPaths, { profile: path.join(runRoot, 'profile'), home: path.join(runRoot, 'home') });
    report.paths = actualPaths;
    await page.getByTestId('category-skill').waitFor({ timeout: 300000 });
    console.log('[Marketplace probe] Real IPC and native Gateway ready');
    const before = await page.evaluate(() => window.marketplaceProbe.evidence());
    report.initialNative = before.native;
    report.uiFailure = await require(path.join(fixture, 'assert-ui.cjs')).run(page, { output: runRoot });
    report.checks.push('real download failure, duplicate-click prevention, cross-category progress and error modal');
    report.packageFailures = await require(path.join(fixture, 'assert-ui.cjs')).runPackageFailures(page, { output: runRoot });
    report.checks.push('metadata HTTP failure and invalid archive show the correct phase and leave no installation');
    await page.evaluate(() => window.marketplaceProbe.setScenario({}));
    await runInstallChecks(page);
    report.requiredConfiguration = await require(path.join(fixture, 'assert-ui.cjs')).runRequiredConfiguration(page, { output: runRoot });
    report.checks.push('required extension configuration follows the actual native validation and error modal');
    report.evidence = await page.evaluate(() => window.marketplaceProbe.evidence());
    assert.ok(report.evidence.preparations.every(item => item.cleaned), 'Every settled attempt must clean its own staging directory');
    assert.deepEqual(report.evidence.remainingDownloads, []);
    assert.deepEqual(report.rendererErrors, []);
  } catch (error) {
    report.error = error.stack || String(error);
    if (app) {
      const page = app.windows()[0];
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {});
        report.evidence = await page.evaluate(() => window.marketplaceProbe.evidence()).catch(() => undefined);
      }
    }
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
  }
  assert.ok(!report.error, report.error);
  const shutdown = JSON.parse(fs.readFileSync(path.join(runRoot, 'shutdown.json'), 'utf8'));
  assert.equal(shutdown.ok, true, 'Fixture teardown must succeed');
  assert.equal(shutdown.native.cleanShutdown, true, 'Native Gateway must exit cleanly');
  report.shutdown = shutdown;
  report.ok = true;
}

async function runInstallChecks(page) {
  // Filled by the same probe below; use actual production bridge operations.
  for (const [kind, id, name, runtimeId] of [
    ['skill', 'catalog-skill', 'Fixture market skill', 'fixture-market-skill'],
    ['extension', 'catalog-extension', 'Fixture market extension', 'fixture-market-extension'],
    ['mcp', 'catalog-mcp', 'Fixture market MCP', undefined],
  ]) {
    console.log(`[Marketplace probe] Installing, updating and removing ${kind}`);
    await page.getByTestId(`category-${kind}`).click();
    const card = page.locator('article').filter({ has: page.getByText(name, { exact: true }) });
    await card.getByRole('button', { name: /^(安装|Install)$/ }).click();
    const installedResult = await until(async () => {
      const current = await page.evaluate(() => window.marketplaceProbe.evidence());
      return current.results.find(item => item.pluginId === id);
    });
    const evidence = await page.evaluate(() => window.marketplaceProbe.evidence());
    const result = installedResult.result;
    assert.equal(result.success, true, `${kind} install: ${JSON.stringify(result)}`);
    const installed = await page.evaluate(kind => window.marketplaceProbe.inventory(kind), kind);
    const entry = runtimeId ? installed.installed.find(item => item.id === runtimeId) : installed.installed[0];
    assert.ok(entry, `${kind} installed identity must exist`);
    assert.equal(entry.enabled, true, `${kind} must be enabled after a fresh market installation`);
    if (kind === 'mcp') assert.equal(evidence.config.mcp.servers[name].enabled, true);
    await page.getByTestId(`installed-${entry.id}`).waitFor();
    // Match the real UI admission: its market operation includes the final
    // inventory refresh, not just the Main install response observed above.
    await page.locator('[role="status"][aria-live="polite"]').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(runRoot, `marketplace-${kind}-installed.png`) });
    report.checks.push(`${kind}: real HTTP package, native installation and enabled state`);

    const disabled = await page.evaluate(({ kind, id }) => {
      const context = { requestId: `probe-disable-${kind}` };
      return kind === 'extension'
        ? window.electron.extensions.setEnabled({ extensionId: id, enabled: false }, context)
        : window.electron[kind === 'skill' ? 'skills' : 'mcp'].setEnabled({ id, enabled: false }, context);
    }, { kind, id: entry.id });
    assert.equal(disabled.success, true, `${kind} disable: ${JSON.stringify(disabled)}`);
    if (kind === 'mcp') {
      const disabledEvidence = await page.evaluate(() => window.marketplaceProbe.evidence());
      assert.equal(disabledEvidence.config.mcp.servers[name].enabled, false, 'MCP disable must reach the native config');
    }
    await page.evaluate(() => window.marketplaceProbe.setScenario({ version: '2.0.0' }));
    const updated = await page.evaluate(({ kind, id }) => window.electron.marketplace.install({
      sourceId: 'loopback-market', pluginId: id, kind, version: '2.0.0', operation: 'update',
    }, { requestId: `probe-update-${kind}` }), { kind, id });
    assert.equal(updated.success, true, `${kind} update: ${JSON.stringify(updated)}`);
    const afterUpdate = await page.evaluate(kind => window.marketplaceProbe.inventory(kind), kind);
    assert.equal(afterUpdate.installed.find(item => item.id === entry.id)?.enabled, false, `${kind} update must preserve disabled state`);
    if (kind !== 'mcp') assert.equal(afterUpdate.installed.find(item => item.id === entry.id)?.version, '2.0.0');
    else {
      const updatedEvidence = await page.evaluate(() => window.marketplaceProbe.evidence());
      assert.equal(updatedEvidence.mcpServers.find(item => item.id === entry.id)?.description, 'Fixture 2.0.0');
      assert.equal(updatedEvidence.config.mcp.servers[name].env.FIXTURE_VERSION, '2.0.0');
      assert.equal(updatedEvidence.config.mcp.servers[name].enabled, false, 'MCP update must preserve the native disabled state');
    }
    const removed = await page.evaluate(({ kind, id }) => {
      const context = { requestId: `probe-remove-${kind}` };
      if (kind === 'extension') return window.electron.extensions.delete({ extensionId: id }, context);
      if (kind === 'skill') return window.electron.skills.delete({ id, source: 'openclaw-managed' }, context);
      return window.electron.mcp.delete(id, context);
    }, { kind, id: entry.id });
    assert.equal(removed.success, true, `${kind} remove: ${JSON.stringify(removed)}`);
    if (entry.installPath) assert.equal(fs.existsSync(entry.installPath), false, `${kind} formal directory must be removed`);
    const identity = await page.evaluate(({ kind, entry }) => window.electron.marketplace.resolveInstalled({
      kind, installed: [{ id: entry.id, installPath: entry.installPath }],
    }), { kind, entry });
    assert.deepEqual(identity.installations, [], `${kind} removed market registry must be cleared`);
    await until(async () => {
      const result = await page.evaluate(kind => window.marketplaceProbe.inventory(kind), kind);
      return !result.installed.some(item => item.id === entry.id);
    }, 60000);
    if (kind === 'mcp') {
      const removedEvidence = await page.evaluate(() => window.marketplaceProbe.evidence());
      assert.equal(removedEvidence.mcpServers.some(item => item.id === entry.id), false);
      assert.equal(Object.hasOwn(removedEvidence.config.mcp.servers, name), false);
    }
    report.checks.push(`${kind}: disabled update to v2 preserves state, removal clears files/record and market identity`);
    await page.evaluate(() => window.marketplaceProbe.setScenario({}));
  }
}

main().catch(error => { report.ok = false; report.error = error.stack || String(error); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(runRoot, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok === true, checks: report.checks, error: report.error, result: path.join(runRoot, 'result.json') }));
});
