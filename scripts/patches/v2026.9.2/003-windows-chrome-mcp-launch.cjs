'use strict';

// Capability: launch Chrome MCP through Electron's embedded Node on Windows without showing the
// nested npm command shell.
// Target: pristine openclaw@2026.9.2, which already captures stderr before connecting but still
// launches the configured npm/npx command shim directly.
// Scope: adapts only npm/npx Chrome MCP launch arguments. Native commands and non-Windows hosts
// retain the upstream transport path and diagnostics.
// Safety: only app-provided executable/bin/preload paths are consumed; the preload path is
// constrained to the expected absolute hide-child-process-windows.cjs filename.
// Remove when: upstream provides an Electron-safe Windows Chrome MCP package runner.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

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
  const windowsHidePreloadCandidate = environment?.JUSTDO_WINDOWS_HIDE_PRELOAD?.trim() ?? '';
  const windowsHidePreload =
    /^(?:[A-Za-z]:[\\/]|\\\\)[^"\r\n]+[\\/]hide-child-process-windows\.cjs$/i.test(
      windowsHidePreloadCandidate,
    )
      ? windowsHidePreloadCandidate
      : '';
  return {
    command: electronPath,
    args: [`${normalizedBinDir}\\${runnerName}-cli.js`, ...args],
    env: Object.fromEntries([
      ...Object.entries(environment).filter(entry => typeof entry[1] === 'string'),
      ['ELECTRON_RUN_AS_NODE', '1'],
      ...(windowsHidePreload ? [['NODE_OPTIONS', `--require="${windowsHidePreload}"`]] : []),
    ]),
  };
}

const CONTRACT = 'JUSTDO_WINDOWS_CHROME_MCP_LAUNCH_V2026_9_2';
const SESSION_ANCHOR = 'async function createRealSession(';
const NATIVE_TRANSPORT_PATTERN =
  /new StdioClientTransport\(\{\s*command:\s*([A-Za-z_$][\w$]*)\.command,\s*args:\s*\1\.args,\s*stderr:\s*(["'`])pipe\2\s*\}\)/;
const PATCHED_TRANSPORT_PATTERN =
  /new StdioClientTransport\(buildJustDoChromeMcpTransportOptions\(([A-Za-z_$][\w$]*)\)\)/;
const PATCHED_TRANSPORT_DECLARATION_PATTERN =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new StdioClientTransport\(buildJustDoChromeMcpTransportOptions\(([A-Za-z_$][\w$]*)\)\)/;
const WINDOWS_HELPER = `// ${CONTRACT}
${resolveJustDoChromeMcpLaunch.toString()}
function buildJustDoChromeMcpTransportOptions(options) {
\tconst launch = resolveJustDoChromeMcpLaunch(
\t\toptions.command,
\t\toptions.args,
\t\tprocess.platform,
\t\tprocess.env
\t);
\treturn {
\t\tcommand: launch.command,
\t\targs: launch.args,
\t\t...(launch.env ? { env: launch.env } : {}),
\t\tstderr: "pipe"
\t};
}`;

function targets(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'Chrome MCP attach failed for profile',
    SESSION_ANCHOR,
    'new StdioClientTransport(',
    'drainStderr(',
  ]);
  if (files.length !== 2) {
    throw new Error(`Chrome MCP Windows launch target count is ${files.length}, expected 2`);
  }
  return files;
}

function applyPatch(runtimeDir) {
  const changes = targets(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    const hasHelper = original.includes('function resolveJustDoChromeMcpLaunch(');
    const hasPatchedTransport = PATCHED_TRANSPORT_PATTERN.test(original);
    let updated = original;
    if (!hasHelper && !hasPatchedTransport) {
      updated = replaceUnique(
        updated,
        SESSION_ANCHOR,
        `${WINDOWS_HELPER}\n${SESSION_ANCHOR}`,
        'Chrome MCP Windows package runner helper',
      );
      updated = replaceUniquePattern(
        updated,
        NATIVE_TRANSPORT_PATTERN,
        (_match, options) =>
          `new StdioClientTransport(buildJustDoChromeMcpTransportOptions(${options}))`,
        'Chrome MCP Windows package runner transport',
      );
    } else if (!hasHelper || !hasPatchedTransport) {
      throw new Error(`historical or partially applied Chrome MCP launch contract: ${filePath}`);
    }
    return { filePath, original, updated };
  });
  const changed = changes
    .filter(change => writeIfChanged(change.filePath, change.original, change.updated))
    .map(change => path.relative(runtimeDir, change.filePath));
  verifyPatch(runtimeDir);
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const filePath of targets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const contract of [
      CONTRACT,
      'function resolveJustDoChromeMcpLaunch(',
      'JUSTDO_NPM_BIN_DIR',
      'JUSTDO_ELECTRON_PATH',
      'JUSTDO_WINDOWS_HIDE_PRELOAD',
      "['ELECTRON_RUN_AS_NODE', '1']",
      'buildJustDoChromeMcpTransportOptions(',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`missing Chrome MCP Windows launch contract in ${filePath}: ${contract}`);
      }
    }
    if (NATIVE_TRANSPORT_PATTERN.test(content)) {
      throw new Error(`native direct Chrome MCP package launch remains: ${filePath}`);
    }
    const declaration = PATCHED_TRANSPORT_DECLARATION_PATTERN.exec(content);
    if (!declaration) {
      throw new Error(`patched Chrome MCP transport declaration is missing: ${filePath}`);
    }
    const sessionIndex = content.indexOf(SESSION_ANCHOR);
    const transportVariable = declaration[1];
    const stderrIndex = content.indexOf(`drainStderr(${transportVariable})`, sessionIndex);
    const connectIndex = content.indexOf(`.connect(${transportVariable})`, sessionIndex);
    if (stderrIndex < 0 || connectIndex < 0 || stderrIndex > connectIndex) {
      throw new Error(`upstream Chrome MCP stderr capture is no longer early: ${filePath}`);
    }
  }
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    CONTRACT,
    NATIVE_TRANSPORT_PATTERN,
    PATCHED_TRANSPORT_DECLARATION_PATTERN,
    PATCHED_TRANSPORT_PATTERN,
    WINDOWS_HELPER,
    resolveJustDoChromeMcpLaunch,
  },
};
