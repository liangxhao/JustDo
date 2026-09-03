'use strict';

// Capability: start npm/npx-backed MCP servers under Electron's embedded Node on Windows
// without exposing the nested npm command shell as a visible console window.
// Target: pristine openclaw@2026.8.2, which directly spawns Windows command shims.
// Scope: rewrites only npm/npx launch preparation, sets ELECTRON_RUN_AS_NODE, and loads the
// app-owned child-process preload after OpenClaw's MCP environment sanitizer removes NODE_OPTIONS.
// Safety: non-Windows and non-package-runner commands continue through the native spawn path.
// Remove when: OpenClaw ships an Electron-safe Windows package runner with hidden nested shells.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_WINDOWS_MCP_PACKAGE_RUNNER_V2026_8_2';
const NATIVE_PREPARE_PATTERN =
  /prepareOomScoreAdjustedSpawn\(this\.serverParams\.command,\s*this\.serverParams\.args\s*\?\?\s*\[\],\s*\{\s*env:\s*([A-Za-z_$][\w$]*)\s*\}\)/;
const PATCHED_PREPARE_PATTERN =
  /prepareJustDoWindowsMcpSpawn\(this\.serverParams\.command,\s*this\.serverParams\.args\s*\?\?\s*\[\],\s*([A-Za-z_$][\w$]*)\)/;
const CLASS_PATTERN = /(?:var\s+)?OpenClawStdioClientTransport\s*=\s*class/;
const WINDOWS_PREPARE = `// ${CONTRACT}
function prepareJustDoWindowsMcpSpawn(command, args, baseEnv) {
\tconst packageRunner = process.platform === "win32" && /^(npm|npx)(?:\\.cmd)?$/i.exec(command);
\tconst packageRunnerCli = packageRunner && process.env.JUSTDO_NPM_BIN_DIR && process.env.JUSTDO_ELECTRON_PATH ? \`${'${'}process.env.JUSTDO_NPM_BIN_DIR}\\\\${'${'}packageRunner[1].toLowerCase()}-cli.js\` : void 0;
\tconst spawnCommand = packageRunnerCli ? process.env.JUSTDO_ELECTRON_PATH : command;
\tconst spawnArgs = packageRunnerCli ? [packageRunnerCli, ...args] : args;
\tconst windowsHidePreloadCandidate = typeof process.env.JUSTDO_WINDOWS_HIDE_PRELOAD === "string" ? process.env.JUSTDO_WINDOWS_HIDE_PRELOAD.trim() : "";
\tconst windowsHidePreload = /^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)[^"\\r\\n]+[\\\\/]hide-child-process-windows\\.cjs$/i.test(windowsHidePreloadCandidate) ? windowsHidePreloadCandidate : "";
\tconst spawnEnv = packageRunnerCli ? {
\t\t...baseEnv,
\t\tELECTRON_RUN_AS_NODE: "1",
\t\t...(windowsHidePreload ? { NODE_OPTIONS: \`--require="${'${'}windowsHidePreload}"\` } : {})
\t} : baseEnv;
\treturn prepareOomScoreAdjustedSpawn(spawnCommand, spawnArgs, { env: spawnEnv });
}`;

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, 'OpenClawStdioClientTransport already started');
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
  if (files.length !== expected)
    throw new Error(`MCP stdio transport target count is ${files.length}, expected ${expected}`);
  const changes = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    const hasPatchedHelper = /function\s+prepareJustDoWindowsMcpSpawn\(/.test(updated);
    const hasPatchedCall = PATCHED_PREPARE_PATTERN.test(updated);
    if (!hasPatchedHelper && !hasPatchedCall) {
      updated = replaceUniquePattern(
        updated,
        CLASS_PATTERN,
        match => `${WINDOWS_PREPARE}\n${match}`,
        'Windows MCP package runner helper',
      );
      updated = replaceUniquePattern(
        updated,
        NATIVE_PREPARE_PATTERN,
        (_match, baseEnv) =>
          `prepareJustDoWindowsMcpSpawn(this.serverParams.command, this.serverParams.args ?? [], ${baseEnv})`,
        'Windows MCP package runner call',
      );
    } else if (!hasPatchedHelper || !hasPatchedCall) {
      throw new Error(
        `historical or partially applied Windows MCP package runner contract: ${filePath}`,
      );
    }
    return { filePath, original, updated };
  });
  return changes
    .filter(change => writeIfChanged(change.filePath, change.original, change.updated))
    .map(change => path.relative(runtimeDir, change.filePath));
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
  if (files.length !== expected) throw new Error('patched MCP stdio transport targets are missing');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const contract of [
      'JUSTDO_NPM_BIN_DIR',
      'JUSTDO_ELECTRON_PATH',
      'JUSTDO_WINDOWS_HIDE_PRELOAD',
      'ELECTRON_RUN_AS_NODE: "1"',
      'NODE_OPTIONS:',
      'prepareJustDoWindowsMcpSpawn(this.serverParams.command',
    ]) {
      if (!content.includes(contract))
        throw new Error(`missing Windows MCP contract in ${filePath}: ${contract}`);
    }
    if (!/windowsHide:\s*process(?:\$?\d+)?\.platform\s*===\s*["'`]win32/.test(content))
      throw new Error(`missing native windowsHide contract: ${filePath}`);
    if (NATIVE_PREPARE_PATTERN.test(content))
      throw new Error(`native direct npm/npx spawn remains: ${filePath}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { CONTRACT, NATIVE_PREPARE_PATTERN, PATCHED_PREPARE_PATTERN, WINDOWS_PREPARE },
};
