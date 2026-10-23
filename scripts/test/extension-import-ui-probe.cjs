'use strict';
/* global window */

// Opt-in UI integration probe. Inputs are the existing, read-only fixture suite;
// all imports run through the production manager, IPC and isolated native Gateway.
// node scripts/test/extension-import-ui-probe.cjs --fixtures <suite-root> --runtime <prepared-runtime-root> [--suite all|negative|valid|update|uninstall] [--rename-observer <build-only-preload.cjs>]
// PLAYWRIGHT_MODULE may name an externally provisioned Playwright installation.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'tests/electron/plugin-marketplace');
const flags = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--fixtures', '--runtime', '--runtime-dependencies', '--suite', '--rename-observer'].includes(args[index]) &&
    args[index + 1] && !flags.has(args[index]), 'Expected known flags with one value each');
  flags.set(args[index], args[index + 1]);
}
const suite = flags.get('--suite') || 'all';
assert.ok(['all', 'negative', 'valid', 'update', 'uninstall'].includes(suite), '--suite must be all, negative, valid, update or uninstall');
assert.ok(flags.has('--fixtures') && flags.has('--runtime'), 'Pass the existing read-only suite with --fixtures and locked offline runtime with --runtime');
const fixturesRoot = fs.realpathSync(path.resolve(flags.get('--fixtures')));
const runtimeRoot = fs.realpathSync(path.resolve(flags.get('--runtime')));
const nativeDependenciesRoot = flags.has('--runtime-dependencies')
  ? fs.realpathSync(path.resolve(flags.get('--runtime-dependencies'))) : undefined;
const renameObserver = flags.has('--rename-observer')
  ? fs.realpathSync(path.resolve(flags.get('--rename-observer'))) : undefined;
if (renameObserver) {
  const relative = path.relative(fs.realpathSync(path.join(root, 'build')), renameObserver);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) && path.extname(renameObserver) === '.cjs' &&
    fs.statSync(renameObserver).isFile(), 'The explicit observer must be a build-only CJS file inside this worktree');
}
assert.ok(fs.existsSync(path.join(runtimeRoot, 'gateway-bundle.mjs')), 'A complete locked offline runtime is required');
const catalog = JSON.parse(fs.readFileSync(path.join(fixturesRoot, 'catalog.json'), 'utf8'));
assert.equal(catalog.format, 1);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function inputHashes() {
  const manifest = fs.readFileSync(path.join(fixturesRoot, 'SHA256SUMS.txt'), 'utf8');
  const hashes = {};
  for (const line of manifest.trim().split(/\r?\n/)) {
    const match = /^([a-f\d]{64})\s{2}(.+)$/.exec(line);
    assert.ok(match, 'Each existing checksum entry must be well formed');
    const absolute = fs.realpathSync(path.join(fixturesRoot, match[2]));
    const relative = path.relative(fixturesRoot, absolute);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'A fixture input must stay inside the read-only suite');
    hashes[match[2]] = sha256(fs.readFileSync(absolute));
    assert.equal(hashes[match[2]], match[1], `Existing fixture checksum: ${match[2]}`);
  }
  hashes['catalog.json'] = sha256(fs.readFileSync(path.join(fixturesRoot, 'catalog.json')));
  hashes['SHA256SUMS.txt'] = sha256(manifest);
  return hashes;
}

// Capability review tokens are compared in memory by the UI assertions. Preserve
// equality evidence in reports without publishing a reusable authorization value.
function reportValue(value, key = '') {
  if (/token/i.test(key) && typeof value === 'string') return { sha256: sha256(value) };
  if (Array.isArray(value)) return value.map(item => reportValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, reportValue(item, name)]));
  return value;
}

const initialHashes = inputHashes();
const artifactRoot = path.join(root, '.agent-tasks/extension-import-ui');
fs.mkdirSync(artifactRoot, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(artifactRoot, 'probe-中文 空格-'));
const output = path.join(root, 'build/extension-import-ui', path.basename(runRoot));
fs.mkdirSync(output, { recursive: true });
for (const name of ['home', 'roaming', 'local', 'profile', 'tmp']) fs.mkdirSync(path.join(runRoot, name));
const report = { runRoot, output, fixturesRoot, runtimeRoot, suite, renameObserver, checks: [], rendererErrors: [], blockedBrowserRequests: [] };

async function main() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  console.log('[Extension import UI] Verifying the isolated offline runtime');
  require(path.join(fixture, 'native-runtime.cjs')).prepareRuntime(runtimeRoot, nativeDependenciesRoot);
  console.log('[Extension import UI] Building the real production manager fixture');
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

  const allowedEnvironment = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL|TZ)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.test(key)));
  Object.assign(env, {
    NODE_ENV: 'test', APPDATA: path.join(runRoot, 'roaming'), LOCALAPPDATA: path.join(runRoot, 'local'),
    HOME: path.join(runRoot, 'home'), USERPROFILE: path.join(runRoot, 'home'),
    TMP: path.join(runRoot, 'tmp'), TEMP: path.join(runRoot, 'tmp'),
  });
  if (renameObserver) env.PLUGIN_COPY_OBSERVER_PATH = renameObserver;
  let app;
  try {
    console.log('[Extension import UI] Starting isolated Electron and native Gateway');
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [path.join(fixture, 'main.cjs'), output, runRoot, runtimeRoot, process.execPath, nativeDependenciesRoot || '', 'extension-import'],
      cwd: root, env, timeout: 120000,
    });
    app.process().stdout.on('data', data => fs.appendFileSync(path.join(runRoot, 'main-stdout.log'), data));
    app.process().stderr.on('data', data => fs.appendFileSync(path.join(runRoot, 'main-stderr.log'), data));
    const page = await app.firstWindow();
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => report.rendererErrors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue();
      report.blockedBrowserRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
      return route.abort();
    });
    const paths = await app.evaluate(({ app }) => ({ profile: app.getPath('userData'), home: app.getPath('home') }));
    assert.deepEqual(paths, { profile: path.join(runRoot, 'profile'), home: path.join(runRoot, 'home') });
    report.paths = paths;
    await page.getByTestId('extension-import-pane').waitFor({ timeout: 300000 });
    const isolated = await page.evaluate(() => ({
      invokeAvailable: typeof window.electron?.extensions?.importPath === 'function',
      rendererRequire: typeof require, rendererProcess: typeof process,
    }));
    assert.deepEqual(isolated, { invokeAvailable: true, rendererRequire: 'undefined', rendererProcess: 'undefined' });
    report.isolated = isolated;
    const startupEvidence = await page.evaluate(() => window.marketplaceProbe.evidence());
    report.launchEnvironment = startupEvidence.native.launchEnvironment;
    if (process.platform === 'win32') {
      assert.deepEqual(report.launchEnvironment, { windowsPolling: 'true', pollingInterval: null },
        'Windows integration must use the production watcher mode and native intervals');
    }
    const assertions = require(path.join(fixture, 'assert-extension-import.cjs'));
    report.outcomes = await assertions.run(page, { output: runRoot, fixturesRoot, catalog, suite, report });
    report.evidence = await page.evaluate(() => window.marketplaceProbe.evidence());
    assert.deepEqual(report.rendererErrors, []);
    assert.deepEqual(report.blockedBrowserRequests, [], 'The UI must not attempt a public service or asset');
  } catch (error) {
    report.error = error.stack || String(error);
    if (app) {
      const page = app.windows()[0];
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(runRoot, 'failure.png'), animations: 'disabled', timeout: 10000 }).catch(() => {});
        report.evidence = await page.evaluate(() => window.marketplaceProbe.evidence()).catch(() => undefined);
      }
    }
  } finally {
    if (app) await app.close();
    assert.deepEqual(inputHashes(), initialHashes, 'Every original fixture and checksum must remain unchanged');
    report.fixtureInputsUnchanged = true;
    report.verifiedInputCount = Object.keys(initialHashes).length - 2;
    const shutdownFile = path.join(runRoot, 'shutdown.json');
    if (fs.existsSync(shutdownFile)) {
      report.shutdown = JSON.parse(fs.readFileSync(shutdownFile, 'utf8'));
      assert.equal(report.shutdown.ok, true, 'Fixture teardown must succeed');
      assert.equal(report.shutdown.native.cleanShutdown, true, 'Native Gateway must exit cleanly');
    } else if (app) throw new Error('The isolated native Gateway did not publish a shutdown receipt');
  }
  assert.ok(!report.error, report.error);
  report.ok = true;
}

main().catch(error => {
  report.ok = false;
  report.error ||= error.stack || String(error);
  process.exitCode = 1;
}).finally(() => {
  fs.writeFileSync(path.join(runRoot, 'result.json'), JSON.stringify(reportValue(report), null, 2));
  console.log(JSON.stringify({ ok: report.ok === true, checks: report.checks, error: report.error, result: path.join(runRoot, 'result.json') }));
});
