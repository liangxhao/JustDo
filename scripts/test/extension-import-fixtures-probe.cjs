'use strict';

// Reuse the existing 68-check suite without writing to its input directory.
// node scripts/test/extension-import-fixtures-probe.cjs --fixtures <fixture-root> --runtime <snapshot-root> [--f01-only | --update-only]
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repository = path.resolve(__dirname, '../..');
const artifacts = path.join(repository, '.agent-tasks/extension-import-fixtures');
const argumentsList = process.argv.slice(2);
const flags = new Map();
let f01Only = false;
let updateOnly = false;
for (let index = 0; index < argumentsList.length; index += 1) {
  const flag = argumentsList[index];
  if (flag === '--f01-only') {
    assert.equal(f01Only, false, 'Do not repeat --f01-only.');
    f01Only = true;
    continue;
  }
  if (flag === '--update-only') {
    assert.equal(updateOnly, false, 'Do not repeat --update-only.');
    updateOnly = true;
    continue;
  }
  assert.ok(
    ['--fixtures', '--runtime'].includes(flag) && argumentsList[index + 1] && !flags.has(flag),
    'Pass --fixtures <existing-input-root> and --runtime <explicit-local-snapshot-root>.',
  );
  flags.set(flag, argumentsList[index + 1]);
  index += 1;
}
assert.ok(!(f01Only && updateOnly), 'Select only one focused case.');
assert.equal(flags.size, 2, 'Both input and runtime directories must be explicit.');
assert.equal(process.versions.node.split('.')[0], '24', 'Use Node.js 24.');
const fixtureRoot = fs.realpathSync(path.resolve(flags.get('--fixtures')));
const runtimeRoot = fs.realpathSync(path.resolve(flags.get('--runtime')));
const within = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
assert.ok(
  within(path.join(repository, 'build'), runtimeRoot),
  'Use the isolated runtime snapshot under this worktree build directory.',
);
fs.mkdirSync(artifacts, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(artifacts, 'run-'));
assert.ok(within(artifacts, fs.realpathSync(runRoot)));
const output = path.join(repository, 'build/extension-import', path.basename(runRoot));
fs.mkdirSync(output, { recursive: true });
const verificationPath = path.join(runRoot, 'verification.json');
const resultPath = path.join(runRoot, 'result.json');
const digest = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const report = {
  fixtureRoot,
  repository,
  runtimeRoot,
  runRoot,
  output,
  mode: f01Only ? 'f01-only' : updateOnly ? 'update-only' : 'complete-suite',
  startedAt: new Date().toISOString(),
  limits: [
    'This reuses the original cold CLI suite. It does not start Gateway, call a model or exercise Renderer UI.',
    'Failed mutations are not replayed. A failed cold installation closes later mutation admission; independent native read checks may continue.',
    'Original fixture inputs and their prior verification directory are read-only; only the current worktree receives outputs.',
  ],
};

function inventoryInputs() {
  const entries = {};
  const visit = relative => {
    const filename = path.join(fixtureRoot, relative);
    const stat = fs.lstatSync(filename);
    assert.ok(!stat.isSymbolicLink(), `Input links are not admitted: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(filename).sort()) visit(path.join(relative, child));
    } else {
      assert.ok(stat.isFile(), `Unexpected input type: ${relative}`);
      entries[relative.replaceAll(path.sep, '/')] = digest(filename);
    }
  };
  for (const entry of [
    'catalog.json',
    'SHA256SUMS.txt',
    'verify.cjs',
    'sources',
    'packages',
    'formats',
    'negative',
  ])
    visit(entry);
  return entries;
}

function verifyArchives() {
  const rows = fs
    .readFileSync(path.join(fixtureRoot, 'SHA256SUMS.txt'), 'utf8')
    .trim()
    .split(/\r?\n/);
  assert.equal(rows.length, 32, 'The existing suite must retain all 32 archive hashes.');
  const archives = rows.map(row => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(row);
    assert.ok(match, 'Invalid SHA256SUMS row.');
    const filename = fs.realpathSync(path.join(fixtureRoot, match[2]));
    assert.ok(within(fixtureRoot, filename), 'Archive input escaped the fixture directory.');
    assert.equal(digest(filename), match[1], match[2]);
    return { input: match[2], sha256: match[1] };
  });
  assert.equal(new Set(archives.map(entry => entry.input)).size, 32);
  return archives;
}

function verifyRuntime() {
  require('../../tests/electron/plugin-marketplace/native-runtime.cjs')
    .verifySnapshotPatchArtifacts(runtimeRoot);
  const marker = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, 'fixture-runtime-ready.json'), 'utf8'),
  );
  assert.equal(path.basename(runtimeRoot), `native-runtime-${marker.identity}`);
  assert.deepEqual(Object.keys(marker.digests).sort(), [
    'dist/plugin-sdk/gateway-runtime.js',
    'gateway-bundle.mjs',
    'gateway-launcher.cjs',
    'npm-shrinkwrap.json',
    'openclaw.mjs',
    'package.json',
    'runtime-build-info.json',
    'runtime-patch-manifest.json',
    'windows-runtime-preload.cjs',
  ]);
  for (const [relative, expected] of Object.entries(marker.digests)) {
    const filename = fs.realpathSync(path.join(runtimeRoot, relative));
    assert.ok(within(runtimeRoot, filename));
    assert.equal(digest(filename), expected, `Native snapshot changed: ${relative}`);
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'),
  ).version;
  const lockedVersion = JSON.parse(
    fs.readFileSync(path.join(repository, 'package.json'), 'utf8'),
  ).openclaw.version.replace(/^v/, '');
  assert.equal(version, lockedVersion);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'catalog.json'), 'utf8')).runtimeVersion,
    version,
  );
  return {
    version, identity: marker.identity,
    checkedDigests: Object.keys(marker.digests).length,
    digests: { ...marker.digests },
  };
}

function adaptSuite(source) {
  let adapted = source;
  const replace = (original, replacement, count = 1) => {
    assert.equal(
      adapted.split(original).length - 1,
      count,
      `The original suite contract changed: ${original}`,
    );
    adapted = adapted.replaceAll(original, replacement);
  };
  replace('const root = __dirname;', `const root = ${JSON.stringify(fixtureRoot)};`);
  replace(
    "const repository = path.resolve(root, '../..');",
    `const repository = ${JSON.stringify(repository)};`,
  );
  replace(
    "const runtimeRoot = fs.realpathSync(path.join(repository, 'vendor/openclaw-runtime/current'));",
    `const runtimeRoot = ${JSON.stringify(runtimeRoot)};`,
  );
  replace("path.join(root, 'verification.json')", JSON.stringify(verificationPath), 4);
  replace(
    "const verificationRoot = path.join(root, 'verification');",
    `const verificationRoot = ${JSON.stringify(artifacts)};`,
  );
  replace(
    "const runRoot = resumeRun\n    ? path.resolve(root, resumeRun)\n    : fs.mkdtempSync(path.join(verificationRoot, 'run-'));",
    `const runRoot = ${JSON.stringify(runRoot)};`,
  );
  replace('report.runDirectory = path.relative(root, runRoot);', 'report.runDirectory = runRoot;');
  replace(
    "path.join(runRoot, 'import-adapter.cjs')",
    JSON.stringify(path.join(output, 'import-adapter.cjs')),
  );
  replace(
    "path.join(runRoot, 'mcp-adapter.cjs')",
    JSON.stringify(path.join(output, 'mcp-adapter.cjs')),
  );
  replace(
    "    NPM_CONFIG_OFFLINE: 'true',",
    `    OPENCLAW_NO_RESPAWN: '1',\n    NODE_OPTIONS: ${JSON.stringify(`--require=${JSON.stringify(path.join(runtimeRoot, 'windows-runtime-preload.cjs'))}`)},\n    NPM_CONFIG_OFFLINE: 'true',`,
  );
  replace(
    'const execute = promisify(execFile);',
    `const execute = promisify(execFile);
let stoppedColdMutation;
const isColdMutation = name => name.startsWith('Real offline cold CLI install:') || name === 'Repeated import replaces the same ID without duplicate installed cards';
const sanitize = value => {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  return token && typeof value === 'string' ? value.replaceAll(token, '[fixture-token]') : value;
};
for (const method of ['log', 'warn', 'error']) {
  const write = console[method].bind(console);
  console[method] = (...values) => write(...values.map(value => typeof value === 'string' ? sanitize(value) : value));
}`,
  );
  replace(
    '  const start = Date.now();\n  try {\n    const details = await run();',
    `  const start = Date.now();
  if (stoppedColdMutation && isColdMutation(name)) {
    report.checks.push({ name, success: false, skipped: true, reason: 'A previous cold mutation failed; it was not replayed.', elapsedMs: 0 });
    fs.writeFileSync(${JSON.stringify(verificationPath)}, JSON.stringify(report, (_key, value) => sanitize(value), 2));
    console.log('[SKIP] ' + name);
    return;
  }
  try {
    const details = await run();`,
  );
  replace(
    '    if (!continueOnFailure) throw error;',
    `    if (name.startsWith('Real offline cold CLI install:')) {
      stoppedColdMutation = name;
      report.mutationStoppedAfter = name;
    } else if (!continueOnFailure && !name.startsWith('Native ')) throw error;`,
  );
  replace(
    'JSON.stringify(report, null, 2)',
    'JSON.stringify(report, (_key, value) => sanitize(value), 2)',
    3,
  );
  if (f01Only) {
    replace(
      '    for (const item of good) {\n      await check(`Real offline cold CLI install: ${item.folder}`',
      "    for (const item of good.filter(entry => entry.folder === '01-skill')) {\n      await check(`Real offline cold CLI install: ${item.folder}`",
    );
    replace(
      '        assert.equal(installer.listInstalled().filter((entry) => entry.id === v1.id).length, 1);',
      '        // The focused run has no unrelated update fixture; the repeated ID assertion above is unchanged.',
    );
    replace(
      '  if (!skillsOnly) {',
      `  if (${JSON.stringify(f01Only)}) {
    report.focused = true;
    report.installedFilesAfterAttempt = preflight.listInstalled().map(({ id, version }) => ({ id, version }));
    report.success = report.checks.every(entry => entry.success);
    report.total = report.checks.length;
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(${JSON.stringify(verificationPath)}, JSON.stringify(report, (_key, value) => sanitize(value), 2));
    return;
  }
  if (!skillsOnly) {`,
    );
  }
  if (updateOnly) {
    replace(
      "const expectedCurrent = good.filter((item) => item.folder !== '10-update-v1');",
      "const expectedCurrent = good.filter((item) => item.folder === '11-update-v2');",
    );
    replace(
      '    for (const item of good) {\n      await check(`Real offline cold CLI install: ${item.folder}`',
      "    for (const item of good.filter(entry => ['10-update-v1', '11-update-v2'].includes(entry.folder))) {\n      await check(`Real offline cold CLI install: ${item.folder}`",
    );
    replace(
      "    await check(\n      'Repeated import replaces the same ID without duplicate installed cards',",
      "    if (false) await check(\n      'Repeated import replaces the same ID without duplicate installed cards',",
    );
    replace(
      "        const expected = good.filter((item) => item.folder !== '10-update-v1');",
      '        const expected = expectedCurrent;',
    );
    replace(
      '        return { pluginId: result.extensionId, version: item.version };',
      `        const installed = installer.listInstalled().find(entry => entry.id === item.id);
        const manifest = JSON.parse(fs.readFileSync(path.join(installed.installPath, 'openclaw.plugin.json'), 'utf8'));
        assert.equal(manifest.version, item.version);
        assert.deepEqual(Object.keys(manifest.mcpServers).toSorted(), item.servers.toSorted());
        const skillDirectories = fs.readdirSync(path.join(installed.installPath, 'skills')).toSorted();
        assert.deepEqual(skillDirectories, item.skills.map(skill => skill.name).toSorted());
        for (const skill of item.skills) assert.ok(fs.readFileSync(path.join(installed.installPath, 'skills', skill.name, 'SKILL.md'), 'utf8').includes(skill.marker));
        const hookDirectories = fs.readdirSync(path.join(installed.installPath, 'hooks')).toSorted();
        assert.equal(hookDirectories.length, item.hook);
        report.installedVersions ??= [];
        report.installedVersions.push({ version: item.version, skills: skillDirectories.length, mcpServers: Object.keys(manifest.mcpServers).length, hookDirectories: hookDirectories.length });
        return { pluginId: result.extensionId, version: item.version, skills: skillDirectories.length, mcpServers: Object.keys(manifest.mcpServers).length, hookDirectories: hookDirectories.length };`,
    );
    replace(
      '    for (const item of expectedCurrent.filter((entry) => entry.mcp)) {\n      await check(`Native MCP connection, resource and echo: ${item.id}`',
      '    for (const item of expectedCurrent.filter((entry) => entry.mcp).flatMap(entry => entry.servers.map(server => ({ ...entry, servers: [server] })))) {\n      await check(`Native MCP connection, resource and echo: ${item.id}/${item.servers[0]}`',
    );
  }
  return adapted;
}

function cleanEnvironment() {
  const allowed =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL|TZ)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const directories = {
    HOME: 'home',
    USERPROFILE: 'home',
    APPDATA: 'appdata',
    LOCALAPPDATA: 'local-appdata',
    TMP: 'temporary',
    TEMP: 'temporary',
    XDG_CONFIG_HOME: 'xdg-config',
    XDG_CACHE_HOME: 'xdg-cache',
    XDG_DATA_HOME: 'xdg-data',
    NPM_CONFIG_CACHE: 'npm-cache',
  };
  for (const [key, relative] of Object.entries(directories)) {
    env[key] = path.join(runRoot, relative);
    fs.mkdirSync(env[key], { recursive: true });
  }
  const npmConfig = path.join(runRoot, 'offline.npmrc');
  fs.writeFileSync(
    npmConfig,
    'offline=true\nregistry=http://127.0.0.1:9\nfund=false\naudit=false\nupdate-notifier=false\n',
  );
  Object.assign(env, {
    NODE_ENV: 'test',
    NODE_DISABLE_COMPILE_CACHE: '1',
    OPENCLAW_NO_RESPAWN: '1',
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(runtimeRoot, 'windows-runtime-preload.cjs'))}`,
    NPM_CONFIG_USERCONFIG: npmConfig,
    NPM_CONFIG_GLOBALCONFIG: npmConfig,
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9',
  });
  return env;
}

async function main() {
  const inputBefore = inventoryInputs();
  report.archives = verifyArchives();
  report.nativeSnapshot = verifyRuntime();
  report.originalSuiteSha256 = inputBefore['verify.cjs'];
  const suitePath = path.join(output, 'verification-suite.cjs');
  fs.writeFileSync(
    suitePath,
    adaptSuite(fs.readFileSync(path.join(fixtureRoot, 'verify.cjs'), 'utf8')),
  );
  console.log(`[Extension import probe] Validated 32 archives; outputs: ${runRoot}`);
  const stdout = fs.createWriteStream(path.join(runRoot, 'stdout.log'));
  const stderr = fs.createWriteStream(path.join(runRoot, 'stderr.log'));
  const child = spawn(process.execPath, [suitePath], {
    cwd: repository,
    env: cleanEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => {
    stdout.write(data);
    process.stdout.write(data);
  });
  child.stderr.on('data', data => {
    stderr.write(data);
    process.stderr.write(data);
  });
  const heartbeat = setInterval(() => {
    let completed = 0;
    try {
      completed = JSON.parse(fs.readFileSync(verificationPath, 'utf8')).checks.length;
    } catch {}
    console.log(
      `[Extension import probe] ${completed} checks recorded; isolated suite is still running.`,
    );
  }, 30_000);
  let outcome;
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearInterval(heartbeat);
    await Promise.all([
      new Promise(resolve => stdout.end(resolve)),
      new Promise(resolve => stderr.end(resolve)),
    ]);
  }
  report.child = outcome;
  const inputAfter = inventoryInputs();
  report.inputsUnchanged = JSON.stringify(inputBefore) === JSON.stringify(inputAfter);
  assert.deepEqual(verifyRuntime(), report.nativeSnapshot, 'The native runtime changed during verification.');
  report.runtimeInputsUnchanged = true;
  assert.equal(
    report.inputsUnchanged,
    true,
    'The original fixture inputs changed during verification.',
  );
  const verification = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
  report.checks = verification.checks;
  report.total = verification.checks.length;
  report.passed = verification.checks.filter(entry => entry.success).length;
  report.failed = verification.checks.filter(entry => !entry.success && !entry.skipped).length;
  report.skipped = verification.checks.filter(entry => entry.skipped).length;
  report.f01 = verification.checks.find(
    entry =>
      entry.name === 'Repeated import replaces the same ID without duplicate installed cards',
  );
  if (f01Only) report.installedFilesAfterAttempt = verification.installedFilesAfterAttempt;
  if (updateOnly) report.installedVersions = verification.installedVersions;
  report.success =
    outcome.code === 0 &&
    verification.success === true &&
    report.total === (f01Only ? 48 : updateOnly ? 53 : 68) &&
    report.inputsUnchanged;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[Extension import probe] ${report.passed}/${report.total} passed; ${report.failed} failed; ${report.skipped} skipped. Report: ${resultPath}`,
  );
  process.exitCode = report.success ? 0 : 2;
}

main().catch(error => {
  report.success = false;
  report.error = String(error.stack || error);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(error.stack || error);
  process.exitCode = 1;
});
