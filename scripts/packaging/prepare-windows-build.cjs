'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { verifyOpenClawPatchManifest } = require('../openclaw/verify-openclaw-runtime-patches.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const RESOURCE_TASKS = Object.freeze(['python', 'git', 'speech']);

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(process.execPath, args, {
      cwd: options.repoRoot || PROJECT_ROOT,
      env: options.env || process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Build process failed (${signal || `exit ${code}`}): ${args.join(' ')}`));
    });
  });
}

async function prepareOpenClawRuntime(options = {}) {
  const repoRoot = options.repoRoot || PROJECT_ROOT;
  const env = options.env || process.env;
  const verify = options.verify || verifyOpenClawPatchManifest;
  const log = options.log || console.log;
  const started = Date.now();
  if (env.OPENCLAW_FORCE_INSTALL === '1') {
    log('[prepare-windows-build] OPENCLAW_FORCE_INSTALL=1 requests a full pristine runtime rebuild.');
  }
  if (env.OPENCLAW_FORCE_INSTALL !== '1') {
    try {
      const manifest = verify(path.join(repoRoot, 'vendor/openclaw-runtime/current'), {
        repoRoot,
        expectedTarget: 'win-x64',
      });
      log(`[prepare-windows-build] Reused verified win-x64 runtime (${manifest.patches.length} patches, ${((Date.now() - started) / 1000).toFixed(1)}s).`);
      return { reused: true };
    } catch (error) {
      log(`[prepare-windows-build] Runtime requires a pristine rebuild: ${error.message}`);
    }
  }
  const npmCli = options.npmCli || env.npm_execpath;
  if (!npmCli) throw new Error('Runtime preparation must be launched through npm.');
  // A stale/partial runtime is replaced from the locked package, never patched in place.
  await runNode([npmCli, 'run', 'openclaw:runtime:win-x64'], {
    ...options,
    repoRoot,
    env: { ...env, OPENCLAW_FORCE_INSTALL: '1' },
  });
  verify(path.join(repoRoot, 'vendor/openclaw-runtime/current'), { repoRoot, expectedTarget: 'win-x64' });
  return { reused: false };
}

async function prepareWindowsResources(options = {}) {
  const log = options.log || console.log;
  // These processes write separate resource roots. Wait for every process even
  // on failure, so a failed build never leaves a sibling writing in the background.
  const results = await Promise.allSettled(RESOURCE_TASKS.map(async task => {
    const started = Date.now();
    log(`[prepare-windows-build] Preparing ${task} in a separate process...`);
    await runNode([__filename, '--resource', task], options);
    log(`[prepare-windows-build] Prepared ${task} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`${RESOURCE_TASKS[index]}: ${result.reason.message}`, { cause: result.reason })]
    : []);
  if (failures.length) throw new AggregateError(failures, `Windows resource preparation failed: ${failures.map(error => error.message).join('; ')}`);
}

async function prepareResource(task) {
  if (task === 'python') {
    const { ensurePortablePythonRuntime, checkRuntimeHealth } = require('../runtime/setup-python-runtime.js');
    await ensurePortablePythonRuntime({ required: true });
    const health = checkRuntimeHealth(path.join(PROJECT_ROOT, 'build/runtimes/python-win'), { requirePip: true });
    if (!health.ok) throw new Error(`Portable Python runtime health check failed: ${health.missing.join(', ')}`);
  } else if (task === 'git') {
    await require('../runtime/setup-mingit.js').ensurePortableGit({ required: true });
  } else if (task === 'speech') {
    await require('../runtime/setup-local-tts.js').ensureLocalTts();
  } else {
    throw new Error(`Unknown Windows resource task: ${task}`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const work = args.length === 0 ? prepareOpenClawRuntime()
    : args.length === 2 && args[0] === '--resource' ? prepareResource(args[1])
      : Promise.reject(new Error('Usage: prepare-windows-build.cjs [--resource python|git|speech]'));
  work.catch(error => { console.error('[prepare-windows-build]', error); process.exitCode = 1; });
}

module.exports = { prepareOpenClawRuntime, prepareWindowsResources };
