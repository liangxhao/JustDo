'use strict';

// Capability: start npm/npx-backed MCP servers under Electron's embedded Node on Windows
// without exposing the nested npm command shell as a visible console window.
// Target: pristine openclaw@2026.7.1-2, which directly spawns Windows command shims.
// Scope: rewrites only npm/npx launch preparation, sets ELECTRON_RUN_AS_NODE, and loads the
// app-owned child-process preload after OpenClaw's MCP environment sanitizer removes NODE_OPTIONS.
// Safety: non-Windows and non-package-runner commands continue through the native spawn path.
// Remove when: OpenClaw ships an Electron-safe Windows package runner with hidden nested shells.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const NATIVE_PREPARE =
  'const preparedSpawn = prepareOomScoreAdjustedSpawn(this.serverParams.command, this.serverParams.args ?? [], { env: baseEnv });';
const WINDOWS_PREPARE = `const rawCommand = this.serverParams.command;
\t\t\tconst rawArgs = this.serverParams.args ?? [];
\t\t\tconst packageRunner = process.platform === "win32" && /^(npm|npx)(?:\\.cmd)?$/i.exec(rawCommand);
\t\t\tconst packageRunnerCli = packageRunner && process.env.JUSTDO_NPM_BIN_DIR && process.env.JUSTDO_ELECTRON_PATH ? \`${'${'}process.env.JUSTDO_NPM_BIN_DIR}\\\\${'${'}packageRunner[1].toLowerCase()}-cli.js\` : void 0;
\t\t\tconst spawnCommand = packageRunnerCli ? process.env.JUSTDO_ELECTRON_PATH : rawCommand;
\t\t\tconst spawnArgs = packageRunnerCli ? [packageRunnerCli, ...rawArgs] : rawArgs;
\t\t\tconst windowsHidePreloadCandidate = typeof process.env.JUSTDO_WINDOWS_HIDE_PRELOAD === "string" ? process.env.JUSTDO_WINDOWS_HIDE_PRELOAD.trim() : "";
\t\t\tconst windowsHidePreload = /^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)[^"\\r\\n]+[\\\\/]hide-child-process-windows\\.cjs$/i.test(windowsHidePreloadCandidate) ? windowsHidePreloadCandidate : "";
\t\t\tconst spawnEnv = packageRunnerCli ? {
\t\t\t\t...baseEnv,
\t\t\t\tELECTRON_RUN_AS_NODE: "1",
\t\t\t\t...(windowsHidePreload ? { NODE_OPTIONS: \`--require="${'${'}windowsHidePreload}"\` } : {})
\t\t\t} : baseEnv;
\t\t\tconst preparedSpawn = prepareOomScoreAdjustedSpawn(spawnCommand, spawnArgs, { env: spawnEnv });`;

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, 'OpenClawStdioClientTransport already started');
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(`MCP stdio transport target count is ${files.length}, expected ${expected}`);
  const changes = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    if (updated.includes(NATIVE_PREPARE))
      updated = replaceUnique(
        updated,
        NATIVE_PREPARE,
        WINDOWS_PREPARE,
        'Windows MCP package runner',
      );
    else if (!(
      updated.includes('const packageRunnerCli = packageRunner &&') &&
      updated.includes('.env.JUSTDO_NPM_BIN_DIR') &&
      updated.includes('JUSTDO_WINDOWS_HIDE_PRELOAD') &&
      updated.includes('NODE_OPTIONS:')
    ))
      throw new Error(`unknown MCP stdio transport shape: ${filePath}`);
    return { filePath, original, updated };
  });
  return changes
    .filter(change => writeIfChanged(change.filePath, change.original, change.updated))
    .map(change => path.relative(runtimeDir, change.filePath));
}

function verifyPatch(runtimeDir) {
  const bundle = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  for (const contract of [
    'JUSTDO_NPM_BIN_DIR',
    'JUSTDO_ELECTRON_PATH',
    'JUSTDO_WINDOWS_HIDE_PRELOAD',
    'ELECTRON_RUN_AS_NODE: "1"',
    'NODE_OPTIONS:',
  ]) {
    if (!bundle.includes(contract)) throw new Error(`missing Windows MCP contract: ${contract}`);
  }
  if (!/windowsHide:\s*process\w*\.platform === "win32"/.test(bundle)) {
    throw new Error('missing Windows MCP contract: native windowsHide');
  }
  if (bundle.includes(NATIVE_PREPARE)) throw new Error('native direct npm/npx spawn remains');
}

module.exports = { applyPatch, verifyPatch, __testing: { NATIVE_PREPARE, WINDOWS_PREPARE } };
