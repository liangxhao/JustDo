'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function assertPublicationLock(inputRun, expectation) {
  const run = fs.realpathSync(inputRun);
  assert.ok(['old-runtime-failure', 'recovered', 'budget-failure'].includes(expectation));
  const result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8'));
  const file = path.join(run, 'publication-assertions.json');
  const report = { run, expectation, rawRunnerOk: result.ok, checks: [] };
  const sha256 = target => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const check = (name, predicate) => { assert.ok(predicate, name); report.checks.push(name); };
  const files = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? files(absolute) : entry.isFile() ? [absolute] : [];
  });

  try {
    const traces = fs.readdirSync(run).filter(name => /^controlled-publication-lock-.*\.json$/.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'))).filter(trace => trace.probes.length);
    check('Exactly one actual v2 copied stage received the controlled file handle', traces.length === 1 && traces[0].probes.length === 1);
    const trace = traces[0];
    const probe = trace.probes[0];
    report.trace = { pid: trace.pid, threadId: trace.threadId, scenario: trace.scenario, holdMs: trace.holdMs,
      source: probe.source, target: probe.target, sourceIdentity: probe.sourceIdentity, helperPid: probe.helperPid,
      helperReady: probe.helperReady, helperClosed: probe.helperClosed, helperExit: probe.helperExit,
      releaseRequestedAt: probe.releaseRequestedAt, attempts: probe.attempts };
    check('The real C# helper held the copied stage index file without DELETE sharing', probe.helperReady?.success === true &&
      probe.helperReady.pid === probe.helperPid && probe.helperReady.sharesDelete === false && probe.helperReady.shareMode === 3 &&
      probe.helperReady.target === path.join(probe.source, 'index.mjs'));
    check('The owned helper released its handle and exited successfully', probe.helperClosed?.released === true &&
      probe.helperClosed?.timedOut === false && probe.helperExit?.code === 0 && probe.helperExit?.signal === null);
    const attempts = probe.attempts;
    check('An actual original fs.rename rejected with Windows EPERM', attempts.some(attempt => !attempt.success && attempt.error?.code === 'EPERM'));
    check('Every low-level attempt used the same original copied stage identity', attempts.every(attempt =>
      attempt.sourceIdentity.exists && attempt.sourceIdentity.dev === probe.sourceIdentity.dev && attempt.sourceIdentity.ino === probe.sourceIdentity.ino));
    check('The original fixture archives stayed unchanged', result.fixtureInputsUnchanged === true && result.verifiedInputCount === 32);
    check('The isolated Gateway and broker exited cleanly', result.shutdown?.ok === true && result.shutdown.native.cleanShutdown === true && result.shutdown.native.brokerExited === true);
    check('No Renderer crash or public browser request occurred', result.rendererErrors.length === 0 && result.blockedBrowserRequests.length === 0);

    const imports = result.evidence.operationResults.filter(entry => entry.channel === 'extensions:import');
    const v2Imports = imports.filter(entry => path.basename(entry.request.sourcePath) === '11-update-v2.zip');
    check('v2 used one preflight and one exact review-token confirmation', v2Imports.length === 2 &&
      !v2Imports[0].request.reviewToken && Boolean(v2Imports[1].request.reviewToken) &&
      v2Imports[0].request.requestId === v2Imports[1].request.requestId &&
      JSON.stringify(v2Imports[1].request.reviewToken) === JSON.stringify(v2Imports[0].result.capabilityReview.reviewToken));
    const nativeInstallCount = result.evidence.native.requests.filter(method => method === 'plugins.install').length;
    report.nativeInstallCount = nativeInstallCount;
    check('Exactly two native install RPCs exist: one for v1, one for v2, with no RPC replay', nativeInstallCount === 2);
    const outcome = result.extensionImportOutcomes.find(entry => entry.fixture === '11-update-v2');
    check('The real v2 operation result was retained', Boolean(outcome));
    report.v2Result = outcome.result;
    if (expectation === 'recovered') {
      check('034 recovered by retrying only the same low-level publication', attempts.length > 1 && attempts[attempts.length - 1].success === true &&
        attempts.slice(0, -1).every(attempt => attempt.success === false));
      check('Successful publication preserved the copied directory inode', attempts[attempts.length - 1].targetAfter.dev === probe.sourceIdentity.dev &&
        attempts[attempts.length - 1].targetAfter.ino === probe.sourceIdentity.ino);
      check('The native success reached the actual production success UI', result.ok === true && outcome.result.success === true &&
        (outcome.dialogText.includes('扩展 import-probe-update 导入成功') || outcome.dialogText.includes('Extension import-probe-update imported successfully')));
      const inventory = outcome.inventory;
      const parent = inventory.extensions.filter(entry => entry.id === 'import-probe-update');
      check('Native v2 exposes enabled parent version 1.1.0', parent.length === 1 && parent[0].version === '1.1.0' && parent[0].enabled === true);
      const skills = inventory.skills.filter(entry => entry.name.startsWith('import-probe-update-'));
      const mcp = inventory.mcp.filter(entry => entry.providerId === 'import-probe-update');
      const hooks = inventory.hooks.filter(entry => entry.pluginId === 'import-probe-update');
      check('Native v2 exposes exactly two eligible Skills, two enabled MCPs and two loadable Hooks', skills.length === 2 &&
        skills.every(entry => entry.eligible === true && entry.disabled === false) && mcp.length === 2 && mcp.every(entry => entry.enabled === true) &&
        hooks.length === 2 && hooks.every(entry => entry.enabledByConfig === true && entry.loadable === true));
    } else {
      check('The original runner remains false for the real native failure', result.ok === false && outcome.result.success === false);
      check('The production failure dialog retains installing stage and original error', outcome.result.failedStage === 'installing' && outcome.failureUiVerified === true);
      check('The failure is not mislabeled as committed or unconfirmed', outcome.result.installationCommitted !== true && outcome.result.operationUnconfirmed !== true);
      check('No low-level attempt falsely succeeded', attempts.every(attempt => attempt.success === false));
      if (expectation === 'old-runtime-failure') check('The old runtime attempted final publication once', attempts.length === 1);
      else {
        check('034 attempted bounded low-level recovery without replaying installation', attempts.length > 1);
        report.lowLevelRecoveryElapsedMs = attempts[attempts.length - 1].finishedAt - attempts[0].finishedAt;
        check('Low-level recovery stayed within five seconds plus 750ms scheduling allowance', report.lowLevelRecoveryElapsedMs <= 5750);
        check('The helper stayed locked beyond the 5-second recovery budget', probe.releaseRequestedAt - attempts[0].finishedAt >= 7000 &&
          attempts[attempts.length - 1].finishedAt < probe.releaseRequestedAt);
      }
      const inventory = outcome.inventory;
      const parent = inventory.extensions.filter(entry => entry.id === 'import-probe-update');
      check('Native rollback restored enabled parent version 1.0.0', parent.length === 1 && parent[0].version === '1.0.0' && parent[0].enabled === true);
      const skills = inventory.skills.filter(entry => entry.name.startsWith('import-probe-update-'));
      const mcp = inventory.mcp.filter(entry => entry.providerId === 'import-probe-update');
      const hooks = inventory.hooks.filter(entry => entry.pluginId === 'import-probe-update');
      check('Rollback restored exactly one eligible Skill, enabled MCP and loadable Hook', skills.length === 1 && skills[0].eligible === true &&
        skills[0].disabled === false && mcp.length === 1 && mcp[0].enabled === true && hooks.length === 1 &&
        hooks[0].enabledByConfig === true && hooks[0].loadable === true);
      const original = path.join(result.fixturesRoot, 'sources/10-update-v1');
      check('Every original v1 source byte was restored at the canonical directory', files(original).every(source => {
        const target = path.join(probe.target, path.relative(original, source));
        return fs.existsSync(target) && sha256(target) === sha256(source);
      }));
      for (const relative of ['mcp/server-2.cjs', 'skills/import-probe-update-skill-2', 'hooks/events-2']) {
        check(`No v2-only entry remains in the restored v1: ${relative}`, !fs.existsSync(path.join(probe.target, relative)));
      }
    }
    const installRoot = path.dirname(probe.target);
    const entries = fs.readdirSync(installRoot).sort();
    const allowedEntries = expectation === 'recovered' ? ['.openclaw-install-backups'] : ['.openclaw-install-backups', 'import-probe-update'];
    report.finalInstallEntries = entries;
    report.cleanupObservation = 'After the existing UI runner closed the isolated native Gateway; native receipt-bound exit cleanup has completed.';
    check('No unexpected copy stage or rollback artifact remains in the owned installation directory', entries.every(name => allowedEntries.includes(name)));
    const backupRoot = path.join(installRoot, '.openclaw-install-backups');
    check('The native backup parent is absent or empty after settlement', !fs.existsSync(backupRoot) || fs.readdirSync(backupRoot).length === 0);
    const runtime = result.shutdown.native.runtime;
    report.runtime = runtime;
    const runtimeInputs = ['runtime-patch-manifest.json', 'node_modules/@openclaw/fs-safe/dist/guarded-mutation.js',
      'node_modules/@openclaw/fs-safe/dist/move-path.js'];
    const support = 'dist/native-support/plugin-directory-publication.mjs';
    if (expectation !== 'old-runtime-failure') {
      check('The actual tested runtime contains the 034 publication support module', fs.existsSync(path.join(runtime, support)));
      runtimeInputs.push(support);
    }
    report.runtimeDigests = Object.fromEntries(runtimeInputs.map(name => [name, sha256(path.join(runtime, name))]));
    report.expectedFailure = expectation !== 'recovered';
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.stack || String(error);
  } finally {
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  }
  return report;
}

exports.assertPublicationLock = assertPublicationLock;

if (require.main === module) {
  const report = assertPublicationLock(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
