const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const npmCli = process.env.npm_execpath;
const vitestCli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const electronRebuildScript = path.join(__dirname, '../electron/rebuild-electron-native.cjs');

function runNodeScript(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: { ...process.env },
    stdio: 'inherit',
  });
}

function resultExitCode(result, label) {
  if (result.error) {
    console.error(`${label} failed to start:`, result.error);
    return 1;
  }
  if (result.signal) {
    console.error(`${label} was terminated by ${result.signal}.`);
    return 1;
  }
  return result.status ?? 1;
}

if (!npmCli) {
  console.error('npm_execpath is unavailable. Run tests through `npm test`.');
  process.exit(1);
}

let exitCode = 1;

try {
  console.log('Preparing better-sqlite3 for the host Node.js runtime...');
  const nodeRebuild = runNodeScript(npmCli, ['rebuild', 'better-sqlite3']);
  exitCode = resultExitCode(nodeRebuild, 'Node.js native module rebuild');

  if (exitCode === 0) {
    const testResult = runNodeScript(vitestCli, ['run', ...process.argv.slice(2)]);
    exitCode = resultExitCode(testResult, 'Vitest');
  }
} finally {
  console.log('Restoring better-sqlite3 for the Electron runtime...');
  const electronRebuild = runNodeScript(electronRebuildScript);
  const restoreExitCode = resultExitCode(electronRebuild, 'Electron native module rebuild');
  if (restoreExitCode !== 0) {
    exitCode = restoreExitCode;
  }
}

process.exit(exitCode);
