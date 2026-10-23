'use strict';

// Opt-in, Windows-only real Electron/native publication test. It uses existing
// read-only packages, a real no-DELETE file handle and the production import UI.
// --expect baseline keeps the unpatched Native failure as a false raw UI report;
// recovered expects same-stage recovery, bounded expects an intact v1 rollback.
// node scripts/test/extension-publication-lock-probe.cjs --fixtures <suite> --runtime <locked-runtime> --expect baseline|recovered|bounded
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'tests/electron/plugin-marketplace');
const args = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--fixtures', '--runtime', '--runtime-dependencies', '--expect'].includes(args[index]) && args[index + 1] &&
    !flags.has(args[index]), 'Pass each known flag with one explicit value');
  flags.set(args[index], args[index + 1]);
}
assert.equal(process.platform, 'win32', 'This test requires real Windows file sharing');
assert.equal(process.versions.node.split('.')[0], '24', 'Use the repository Node 24 runtime');
assert.ok(flags.has('--fixtures') && flags.has('--runtime') && flags.has('--expect'), 'Pass --fixtures, --runtime and --expect explicitly');
const expectations = { baseline: 'old-runtime-failure', recovered: 'recovered', bounded: 'budget-failure' };
const expectation = flags.get('--expect');
assert.ok(Object.hasOwn(expectations, expectation), '--expect must be baseline, recovered or bounded');
const fixturesRoot = fs.realpathSync(path.resolve(flags.get('--fixtures')));
const runtime = fs.realpathSync(path.resolve(flags.get('--runtime')));
const dependencies = flags.has('--runtime-dependencies') ? fs.realpathSync(path.resolve(flags.get('--runtime-dependencies'))) : undefined;
const artifacts = path.join(root, '.agent-tasks/extension-publication-lock-ui');
fs.mkdirSync(artifacts, { recursive: true });
const output = fs.mkdtempSync(path.join(artifacts, 'probe-中文 空格-'));
const build = path.join(root, 'build/extension-publication-lock', path.basename(output));
fs.mkdirSync(build, { recursive: true });
const helperScript = path.join(fixture, 'hold-publication-file.ps1');
const holdMs = expectation === 'bounded' ? 8000 : 800;
const preload = path.join(build, 'publication-lock.cjs');
fs.writeFileSync(preload, `'use strict';\nrequire(${JSON.stringify(path.join(fixture, 'publication-lock-preload.cjs'))}).install(${JSON.stringify({ helperScript, holdMs, scenario: expectation }, null, 2)});\n`);
const reportPath = path.join(output, 'result.json');
const report = { output, fixturesRoot, runtime, dependencies, expectation, holdMs, preload, startedAt: new Date().toISOString(),
  helperScriptSha256: createHash('sha256').update(fs.readFileSync(helperScript)).digest('hex') };
const within = (base, target) => {
  const relative = path.relative(base, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function main() {
  console.log(JSON.stringify({ phase: 'starting-publication-lock-probe', expectation, holdMs, output }));
  const runner = path.join(root, 'scripts/test/extension-import-ui-probe.cjs');
  const childArgs = [runner, '--suite', 'update', '--fixtures', fixturesRoot, '--runtime', runtime, '--rename-observer', preload];
  if (dependencies) childArgs.push('--runtime-dependencies', dependencies);
  // The existing UI runner applies its own OS allowlist and isolated HOME to
  // Electron and native processes; no caller-provided Node preload is inherited.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL|TZ|PLAYWRIGHT_MODULE)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
  const child = spawn(process.execPath, childArgs, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  report.runnerPid = child.pid;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffered = '';
  child.stdout.on('data', data => {
    fs.appendFileSync(path.join(output, 'ui-stdout.log'), data);
    process.stdout.write(data);
    buffered += String(data);
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (typeof value.result === 'string') report.rawUiReport = value.result;
      } catch { /* Ordinary UI runner progress lines are not result receipts. */ }
    }
  });
  child.stderr.on('data', data => {
    fs.appendFileSync(path.join(output, 'ui-stderr.log'), data);
    process.stderr.write(data);
  });
  report.runnerExit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.ok(report.rawUiReport, 'The actual UI runner must publish its raw result path');
  const raw = fs.realpathSync(report.rawUiReport);
  assert.ok(within(fs.realpathSync(path.join(root, '.agent-tasks/extension-import-ui')), raw), 'The raw report must stay inside this worktree fixture output');
  assert.equal(path.basename(raw), 'result.json');
  const rawResult = JSON.parse(fs.readFileSync(raw, 'utf8'));
  const hasControlledStage = fs.readdirSync(path.dirname(raw)).some(name => /^controlled-publication-lock-.*\.json$/.test(name));
  if (!hasControlledStage) {
    report.preparationFailed = true;
    throw new Error(rawResult.error || 'The real fixture did not reach the controlled v2 publication; inspect its raw UI result');
  }
  const assertions = require(path.join(fixture, 'assert-publication-lock.cjs')).assertPublicationLock(path.dirname(raw), expectations[expectation]);
  report.sidecar = path.join(path.dirname(raw), 'publication-assertions.json');
  assert.equal(assertions.ok, true, assertions.error);
  assert.deepEqual(report.runnerExit, { code: expectation === 'recovered' ? 0 : 1, signal: null }, 'Expected failures must keep the raw UI runner unsuccessful');
  report.checks = assertions.checks;
  report.expectedFailure = assertions.expectedFailure;
  report.ok = true;
}

main().catch(error => {
  report.ok = false;
  report.error = error.stack || String(error);
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, expectation, error: report.error, rawUiReport: report.rawUiReport, result: reportPath }));
});
