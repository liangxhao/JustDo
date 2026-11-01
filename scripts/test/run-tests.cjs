const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { discoverAppPluginTestSuites } = require('./app-plugin-test-suites.cjs');
const { prepareSqliteTestModule } = require('./sqlite-test-module.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const vitestCli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const dependencyPatchScript = path.join(__dirname, '../runtime/patch-http-mitm-proxy.cjs');
let testEnv = { ...process.env };

function runNodeScript(script, args = [], cwd = projectRoot) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: testEnv,
    stdio: 'inherit',
    windowsHide: true,
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

if (!process.env.npm_execpath) {
  console.error('npm_execpath is unavailable. Run tests through `npm test`.');
  process.exit(1);
}

let exitCode = 1;
let sqlite;

try {
  exitCode = resultExitCode(runNodeScript(dependencyPatchScript), 'Test dependency patch preparation');

  if (exitCode === 0) {
    console.log('Preparing an isolated SQLite module for Node.js tests...');
    sqlite = prepareSqliteTestModule(projectRoot, testEnv);
    testEnv = { ...testEnv, SQLITE_TEST_MODULE: sqlite.modulePath, APP_PLUGIN_TEST_SQLITE_MODULE: sqlite.modulePath };
    const testResult = runNodeScript(vitestCli, ['run', ...process.argv.slice(2)]);
    exitCode = resultExitCode(testResult, 'Vitest');
    if (process.argv.length === 2) {
      for (const suite of discoverAppPluginTestSuites(projectRoot)) {
        const pluginResult = runNodeScript(vitestCli, ['run', '--config', suite.config], suite.root);
        const pluginExit = resultExitCode(pluginResult, `App plugin tests (${path.basename(suite.root)})`);
        if (pluginExit !== 0) exitCode = pluginExit;
      }
    }
  }
} catch (error) {
  console.error('Test preparation or execution failed:', error);
  exitCode = 1;
} finally {
  try {
    sqlite?.dispose();
  } catch (error) {
    console.error('SQLite test dependency cleanup failed:', error);
    exitCode = 1;
  }
}

process.exit(exitCode);
