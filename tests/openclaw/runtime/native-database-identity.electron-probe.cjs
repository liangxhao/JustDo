'use strict';

// Real Electron Main process, no BrowserWindow/Gateway/database/ABI dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const repository = path.resolve(__dirname, '../../..');
const expectedVersion = `v${require('../../../package.json').openclaw.version.replace(/^v/u, '')}`;
const runtimeRoot = fs.realpathSync(process.argv[2]);
const diagnostic = process.argv.includes('--archived-diagnostic');
const verifier = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
const manifest = diagnostic
  ? verifier.verifyFrozenOpenClawRuntime(runtimeRoot, { expectedVersion, requireBundle: true }).manifest
  : verifier.verifyOpenClawPatchManifest(runtimeRoot, { repoRoot: repository, version: expectedVersion });
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(runtimeRoot, 'node-runtime/node.exe')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestSha256 = digest(fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json')));
const evidence = path.join(repository, '.agent-tasks/runtime/native-database-electron-identity', randomUUID());
fs.mkdirSync(evidence, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'native-database-electron-identity-'));
const profile = path.join(fixture, 'profile'); fs.mkdirSync(profile);
fs.mkdirSync(path.join(fixture, 'appData'));
const compiled = path.join(evidence, 'identity.cjs');
require('esbuild').buildSync({ entryPoints: [path.join(repository, 'src/main/startup/upgrade/nativeDatabaseIdentity.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: compiled });
const contract = require('../../../src/main/startup/upgrade/nativeDatabaseContract.json');
const copied = path.join(fixture, 'copied-runtime');
for (const file of new Set(['package.json', 'runtime-build-info.json', 'runtime-patch-manifest.json', 'npm-shrinkwrap.json',
  'gateway-bundle.mjs', 'node-runtime/node-runtime-manifest.json', 'node-runtime/node.exe',
  ...Object.values(contract.modules).map(owner => owner.path)])) {
  const target = path.join(copied, file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(runtimeRoot, file), target);
}
const archiveBytesSha256 = digest(fs.readFileSync(path.join(runtimeRoot, 'gateway.asar')));
assert.equal(archiveBytesSha256, manifest.sourceArtifacts.gatewayAsarSha256);
const bootstrap = path.join(evidence, 'electron-main.cjs');
fs.writeFileSync(bootstrap, `
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const physical = require('original-fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app } = require('electron');
const runtime = ${JSON.stringify(runtimeRoot)};
const copied = ${JSON.stringify(copied)};
const archive = path.join(runtime, 'gateway.asar');
const originalNoAsar = process.noAsar;
const result = { identityScope: ${JSON.stringify(diagnostic ? 'current Main identity on archived immutable native bytes; not fresh recipe acceptance' : 'current Main identity on strictly admitted fresh artifact')},
  fixture: ${JSON.stringify(fixture)}, runtime, checks: [] };
assert.ok(process.versions.electron, 'This must be real Electron Main, not Electron Node mode.');
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
app.setPath('userData', ${JSON.stringify(profile)});
app.setPath('appData', ${JSON.stringify(path.join(fixture, 'appData'))});
const deadline = setTimeout(() => { console.error('Electron identity observation timed out.'); app.exit(1); }, 60_000);
app.whenReady().then(async () => {
  assert.equal((await fs.promises.stat(archive)).isDirectory(), true, 'Negative control: Electron virtual stat sees an archive directory.');
  assert.equal((await physical.promises.stat(archive)).isFile(), true);
  const hash = createHash('sha256');
  for await (const chunk of physical.createReadStream(archive)) hash.update(chunk);
  assert.equal(hash.digest('hex'), ${JSON.stringify(archiveBytesSha256)}, 'Physical stream hashes the whole original archive bytes.');
  result.checks.push('real Electron virtual-directory negative control + physical regular-file stat and exact raw stream hash');
  const { admitNativeDatabaseRuntime } = require(${JSON.stringify(compiled)});
  const identity = await admitNativeDatabaseRuntime(runtime);
  assert.equal(identity.manifestSha256, ${JSON.stringify(manifestSha256)});
  result.identity = identity;
  result.checks.push('actual current Main identity accepts the real archive with ordinary archive-member reads and no reader replacement');
  await assert.rejects(() => admitNativeDatabaseRuntime(runtime, { readArchiveModule: async () => Buffer.from('controlled damaged archive member') }), /missing or inconsistent/);
  result.checks.push('a damaged archive-member projection remains rejected');
  await admitNativeDatabaseRuntime(copied);
  result.checks.push('real packaged shape without duplicate ASAR still requires and accepts all original owners');
  physical.writeFileSync(path.join(copied, 'gateway.asar'), 'controlled physical archive damage');
  await assert.rejects(() => admitNativeDatabaseRuntime(copied), /missing or inconsistent/);
  physical.unlinkSync(path.join(copied, 'gateway.asar'));
  physical.mkdirSync(path.join(copied, 'gateway.asar'));
  await assert.rejects(() => admitNativeDatabaseRuntime(copied), /missing or inconsistent/);
  result.checks.push('physical archive corruption and an actual directory remain rejected');
  assert.equal(process.noAsar, originalNoAsar, 'No global ASAR mode changes.');
  result.electronVersion = process.versions.electron;
  result.manifestSha256 = ${JSON.stringify(manifestSha256)};
  physical.writeFileSync(${JSON.stringify(path.join(evidence, 'result.json'))}, JSON.stringify(result, null, 2));
  console.log('NATIVE_DATABASE_ELECTRON_IDENTITY=' + JSON.stringify(result));
  clearTimeout(deadline); app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
`);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^OPENCLAW_/i.test(name) && !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(name)));
Object.assign(env, { OPENCLAW_HOME: profile, OPENCLAW_STATE_DIR: profile,
  OPENCLAW_CONFIG_PATH: path.join(profile, 'openclaw.json') });
const electron = require('electron');
const child = spawn(electron, [bootstrap], { cwd: repository, env, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'] });
const output = fs.createWriteStream(path.join(evidence, 'electron.log'));
child.stdout.on('data', bytes => { output.write(bytes); process.stdout.write(bytes); });
child.stderr.on('data', bytes => output.write(bytes));
let timedOut = false;
const outerDeadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 75_000);
child.on('error', error => { console.error(error); });
child.once('close', (code, signal) => {
  clearTimeout(outerDeadline); output.end();
  if (code !== 0 || signal || timedOut || !fs.existsSync(path.join(evidence, 'result.json'))) {
    console.error('Real Electron identity did not close naturally with a confirmed result:', { code, signal, timedOut, evidence });
    process.exitCode = 1;
  } else console.log('ELECTRON_IDENTITY_NATURAL_CLOSE=' + JSON.stringify({ code, signal, evidence }));
});
