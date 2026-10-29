'use strict';

// Opt-in real Electron probe. No Gateway, application launch or user browser profile.
// node scripts/test/verify-background-browser.cjs [--dependencies-root <checkout>]
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < args.length; index += 2) {
  assert.ok(
    args[index] === '--dependencies-root' && args[index + 1] && !flags.has(args[index]),
    'Expected optional --dependencies-root <checkout>',
  );
  flags.set(args[index], args[index + 1]);
}
const dependencies = flags.has('--dependencies-root')
  ? path.resolve(flags.get('--dependencies-root'))
  : root;
const resolveDependency = name => require.resolve(name, { paths: [dependencies] });
const declaredElectron = require(path.join(root, 'package.json')).devDependencies.electron;
const expectedElectron = require(resolveDependency('electron/package.json')).version;
assert.match(declaredElectron, /^\^?\d+\.\d+\.\d+$/u, 'Unsupported Electron version declaration');
const minimum = declaredElectron.replace(/^\^/u, '').split('.').map(Number);
const installed = expectedElectron.split('.').map(Number);
const different = installed.findIndex((value, index) => value !== minimum[index]);
assert.ok(
  declaredElectron.startsWith('^')
    ? installed[0] === minimum[0] && (different < 0 || installed[different] > minimum[different])
    : expectedElectron === declaredElectron,
  'The prepared Electron does not match package.json',
);
const electron = require(resolveDependency('electron'));
assert.ok(fs.existsSync(electron), 'The local Electron binary has not been prepared');

async function main() {
  const artifactRoot = path.join(root, '.agent-tasks/browser-artifacts');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(artifactRoot, 'background-probe-中文 空格-'));
  const output = path.join(root, 'build/browser-background-probe', path.basename(runRoot));
  fs.mkdirSync(output, { recursive: true });
  // Chromium's service-worker LevelDB adds long suffixes below sessionData on
  // Windows. Keep this isolated root short without using any system/user folder.
  const runtimeRoot = fs.mkdtempSync(path.join(root, 'build/bgp-'));
  for (const directory of ['h', 'a', 'l', 't', 'p', 's', 'c', 'd']) {
    fs.mkdirSync(path.join(runtimeRoot, directory));
  }
  const entry = path.join(output, 'entry.ts');
  fs.writeFileSync(
    entry,
    [
      `export { BackgroundBrowserHost } from ${JSON.stringify(path.join(root, 'src/main/browser/backgroundBrowserHost.ts'))};`,
      `export { browserPartitionForProfile } from ${JSON.stringify(path.join(root, 'src/shared/browser/browser.ts'))};`,
      `export { ensureBrowserSessionPolicy, configureBrowserSessionUi, releaseBrowserSessionUi } from ${JSON.stringify(path.join(root, 'src/main/browser/browserSessionPolicy.ts'))};`,
      `export { isSameBrowserSession } from ${JSON.stringify(path.join(root, 'src/main/browser/browserSessionIdentity.ts'))};`,
      `export { recordImportedBrowserProfile } from ${JSON.stringify(path.join(root, 'src/main/browser/data/browserDataImportService.ts'))};`,
      `export { BrowserAgentBridge } from ${JSON.stringify(path.join(root, 'src/main/browser/browserAgentBridge.ts'))};`,
      `export { BrowserIpc } from ${JSON.stringify(path.join(root, 'src/shared/browser/browser.ts'))};`,
      `export { EmbeddedBrowserGatewayBridge } from ${JSON.stringify(path.join(root, 'src/main/browser/embeddedBrowserGatewayBridge.ts'))};`,
      `export { BrowserAgentCdpInput } from ${JSON.stringify(path.join(root, 'src/main/browser/agent/browserAgentInput.ts'))};`,
      `export { executeAct } from ${JSON.stringify(path.join(root, 'src/main/browser/agent/browserAgentActions.ts'))};`,
      `export { applyBrowserProxyPreference } from ${JSON.stringify(path.join(root, 'src/main/core/network/systemProxyPreference.ts'))};`,
    ].join('\n'),
  );
  console.log('[BackgroundBrowserProbe] Building the production host and input implementation');
  await require(resolveDependency('esbuild')).build({
    entryPoints: [entry],
    outfile: path.join(output, 'browser.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    packages: 'external',
  });

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith('OPENCLAW_') &&
        ![
          'NODE_OPTIONS',
          'ELECTRON_RUN_AS_NODE',
          'HTTP_PROXY',
          'HTTPS_PROXY',
          'ALL_PROXY',
          'NO_PROXY',
        ].includes(key.toUpperCase()),
    ),
  );
  Object.assign(env, {
    NODE_ENV: 'test',
    NODE_PATH: path.join(dependencies, 'node_modules'),
    HOME: path.join(runtimeRoot, 'h'),
    USERPROFILE: path.join(runtimeRoot, 'h'),
    APPDATA: path.join(runtimeRoot, 'a'),
    LOCALAPPDATA: path.join(runtimeRoot, 'l'),
    TEMP: path.join(runtimeRoot, 't'),
    TMP: path.join(runtimeRoot, 't'),
  });
  console.log('[BackgroundBrowserProbe] Starting the isolated, hidden Electron fixture');
  const stdout = fs.createWriteStream(path.join(runRoot, 'stdout.log'));
  const stderr = fs.createWriteStream(path.join(runRoot, 'stderr.log'));
  const child = spawn(
    electron,
    [path.join(root, 'tests/browser-background-electron/main.cjs'), output, runRoot, runtimeRoot],
    {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', data => {
    process.stdout.write(data);
    stdout.write(data);
  });
  child.stderr.on('data', data => {
    process.stderr.write(data);
    stderr.write(data);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', value => resolve(value ?? 1));
  }).finally(() => {
    clearTimeout(timer);
    stdout.end();
    stderr.end();
  });
  const reportPath = path.join(runRoot, 'report.json');
  console.log(`[BackgroundBrowserProbe] Report: ${reportPath}`);
  assert.equal(timedOut, false, 'The isolated Electron fixture exceeded 60 seconds');
  assert.equal(code, 0, `The isolated Electron fixture failed with exit code ${code}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.ok, true, 'The fixture did not report success');
  assert.equal(
    report.electron,
    expectedElectron,
    'The executing binary does not match the prepared Electron',
  );
  console.log(`[BackgroundBrowserProbe] PASS: ${report.checks.length} real Chromium checks`);
}

main().catch(error => {
  console.error('[BackgroundBrowserProbe]', error.stack);
  process.exitCode = 1;
});
