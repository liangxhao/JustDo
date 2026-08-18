'use strict';

// Capability: launch Chrome MCP safely on Windows and capture handshake stderr immediately.
// Target: pristine openclaw@2026.7.1-2, which drains stderr only after connection succeeds.
// Scope: adapts npm/npx launch arguments and moves stderr draining before the connection attempt.
// Safety: native commands/channels retain their existing behavior and duplicate drain setup is removed.
// Remove when: upstream provides Electron-safe Chrome MCP launch plus early failure diagnostics.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

function resolveJustDoChromeMcpLaunch(command, args, platform, environment) {
  const packageRunner =
    platform === 'win32' && typeof command === 'string'
      ? /^(npm|npx)(?:\.cmd)?$/i.exec(command)
      : null;
  const npmBinDir = environment?.JUSTDO_NPM_BIN_DIR;
  const electronPath = environment?.JUSTDO_ELECTRON_PATH;
  if (!packageRunner || !npmBinDir || !electronPath) {
    return { command, args, env: undefined };
  }
  const runnerName = packageRunner[1].toLowerCase();
  const normalizedBinDir = npmBinDir.replace(/[\\/]+$/, '');
  return {
    command: electronPath,
    args: [`${normalizedBinDir}\\${runnerName}-cli.js`, ...args],
    env: Object.fromEntries([
      ...Object.entries(environment).filter(entry => typeof entry[1] === 'string'),
      ['ELECTRON_RUN_AS_NODE', '1'],
    ]),
  };
}

const NATIVE_COMMAND = `const transport = new StdioClientTransport({
\t\tcommand: options.command,
\t\targs: buildChromeMcpArgsFromOptions(options),`;
const WINDOWS_COMMAND = `${resolveJustDoChromeMcpLaunch.toString()}
\tconst justDoChromeMcpLaunch = resolveJustDoChromeMcpLaunch(
\t\toptions.command,
\t\tbuildChromeMcpArgsFromOptions(options),
\t\tprocess.platform,
\t\tprocess.env
\t);
\tconst transport = new StdioClientTransport({
\t\tcommand: justDoChromeMcpLaunch.command,
\t\targs: justDoChromeMcpLaunch.args,
\t\tenv: justDoChromeMcpLaunch.env,`;
const LATE_STDERR = `let getStderr = () => "";`;
const EARLY_STDERR = `const getStderr = drainStderr(transport);`;
const LATE_ASSIGNMENT = `\n\t\t\t\tgetStderr = drainStderr(transport);`;

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, 'Chrome MCP attach failed for profile');
  const expected = 1;
  if (files.length !== expected)
    throw new Error(`Chrome MCP launch target count is ${files.length}, expected ${expected}`);
  const changes = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    if (updated.includes(NATIVE_COMMAND))
      updated = replaceUnique(
        updated,
        NATIVE_COMMAND,
        WINDOWS_COMMAND,
        'Chrome MCP Windows package runner',
      );
    else if (!updated.includes('function resolveJustDoChromeMcpLaunch('))
      throw new Error(`unknown Chrome MCP command shape: ${filePath}`);
    if (updated.includes(LATE_STDERR)) {
      updated = replaceUnique(
        updated,
        LATE_STDERR,
        EARLY_STDERR,
        'Chrome MCP early stderr capture',
      );
      updated = replaceUnique(updated, LATE_ASSIGNMENT, '', 'Chrome MCP late stderr assignment');
    } else if (!updated.includes(EARLY_STDERR) || updated.includes(LATE_ASSIGNMENT))
      throw new Error(`unknown Chrome MCP stderr shape: ${filePath}`);
    return { filePath, original, updated };
  });
  return changes
    .filter(change => writeIfChanged(change.filePath, change.original, change.updated))
    .map(change => path.relative(runtimeDir, change.filePath));
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, 'Chrome MCP attach failed for profile');
  if (files.length !== 1) throw new Error('patched Chrome MCP companion is missing');
  const bundle = fs.readFileSync(files[0], 'utf8');
  for (const contract of [
    'function resolveJustDoChromeMcpLaunch(',
    '/^(npm|npx)(?:\\.cmd)?$/i.exec(command)',
    '${runnerName}-cli.js',
    'env: justDoChromeMcpLaunch.env',
    'const getStderr = drainStderr(transport);',
    "['ELECTRON_RUN_AS_NODE', '1']",
  ]) {
    if (!bundle.includes(contract))
      throw new Error(`missing Chrome MCP launch contract: ${contract}`);
  }
  if (bundle.includes(LATE_STDERR) || bundle.includes(LATE_ASSIGNMENT))
    throw new Error('Chrome MCP still starts stderr capture after connect');
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    NATIVE_COMMAND,
    WINDOWS_COMMAND,
    LATE_STDERR,
    EARLY_STDERR,
    resolveJustDoChromeMcpLaunch,
  },
};
