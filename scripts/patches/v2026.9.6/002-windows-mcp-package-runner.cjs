'use strict';

// Capability: start npm/npx-backed MCP servers under Electron's embedded Node on Windows
// without exposing the nested npm command shell as a visible console window.
// Target: pristine openclaw@2026.9.6, which directly spawns Windows command shims.
// Scope: rewrites only npm/npx launch preparation, sets ELECTRON_RUN_AS_NODE, and loads the
// app-owned child-process preload after OpenClaw's MCP environment sanitizer removes NODE_OPTIONS.
// Safety: non-Windows and non-package-runner commands continue through the native spawn path.
// Remove when: OpenClaw ships an Electron-safe Windows package runner with hidden nested shells.

const fs = require('fs');
const path = require('path');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  isGatewayBundlePath,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_WINDOWS_MCP_PACKAGE_RUNNER_V2026_9_6';
const NATIVE_PREPARE_PATTERN = /createOwnedStdioProcess\(\{/g;
const PATCHED_PREPARE_PATTERN = /createOwnedStdioProcess\(prepareJustDoWindowsMcpSpawn\(\{/;
const CLASS_PATTERN = /(?:var\s+)?OpenClawStdioClientTransport\s*=\s*class/;
const WINDOWS_PREPARE = `// ${CONTRACT}
function prepareJustDoWindowsMcpSpawn(options) {
 const [command, ...args] = options.argv;
 const baseEnv = options.env;
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
\treturn { ...options, argv: [spawnCommand, ...spawnArgs], env: spawnEnv };
}`;

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, 'OpenClawStdioClientTransport already started');
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 4 : 3;
  if (files.length !== expected)
    throw new Error(`MCP stdio transport target count is ${files.length}, expected ${expected}`);
  const changes = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    assertCurrentPatchContract(updated, CONTRACT, filePath, false);
    const hasPatchedHelper = /function\s+prepareJustDoWindowsMcpSpawn\(/.test(updated);
    const hasPatchedCall = PATCHED_PREPARE_PATTERN.test(updated);
    if (!hasPatchedHelper && !hasPatchedCall) {
      updated = replaceUniquePattern(
        updated,
        CLASS_PATTERN,
        match => `${WINDOWS_PREPARE}\n${match}`,
        'Windows MCP package runner helper',
      );
      const anchor = /createOwnedStdioProcess\(\{/g;
      const matches = [...updated.matchAll(anchor)];
      if (matches.length !== 1) throw new Error('Owned MCP process anchor is ambiguous');
      const bodyStart = matches[0].index + matches[0][0].length - 1;
      const bodyEnd = require('./_patch-utils.js').findMatchingDelimiter(updated, bodyStart, '{', '}', filePath);
      updated = updated.slice(0, bodyEnd + 1) + ')' + updated.slice(bodyEnd + 1);
      updated = updated.replace(anchor, 'createOwnedStdioProcess(prepareJustDoWindowsMcpSpawn({');
    } else if (!hasPatchedHelper || !hasPatchedCall) {
      throw new Error(
        `historical or partially applied Windows MCP package runner contract: ${filePath}`,
      );
    } else {
      assertCurrentPatchContract(updated, CONTRACT, filePath, !isGatewayBundlePath(filePath));
    }
    return { filePath, original, updated };
  });
  return changes
    .filter(change => writeIfChanged(change.filePath, change.original, change.updated))
    .map(change => path.relative(runtimeDir, change.filePath));
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 4 : 3;
  if (files.length !== expected) throw new Error('patched MCP stdio transport targets are missing');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    assertCurrentPatchContract(content, CONTRACT, filePath, !isGatewayBundlePath(filePath));
    for (const contract of [
      'JUSTDO_NPM_BIN_DIR',
      'JUSTDO_ELECTRON_PATH',
      'JUSTDO_WINDOWS_HIDE_PRELOAD',
      'ELECTRON_RUN_AS_NODE: "1"',
      'NODE_OPTIONS:',
      'createOwnedStdioProcess(prepareJustDoWindowsMcpSpawn({',
    ]) {
      if (!content.includes(contract))
        throw new Error(`missing Windows MCP contract in ${filePath}: ${contract}`);
    }
    if (NATIVE_PREPARE_PATTERN.test(content))
      throw new Error(`native direct npm/npx spawn remains: ${filePath}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { CONTRACT, NATIVE_PREPARE_PATTERN, PATCHED_PREPARE_PATTERN, WINDOWS_PREPARE },
};
