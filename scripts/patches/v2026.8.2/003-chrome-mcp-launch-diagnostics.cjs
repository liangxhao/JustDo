'use strict';

// Capability: launch Chrome MCP safely on Windows and capture handshake stderr immediately.
// Target: pristine openclaw@2026.8.2, which drains stderr only after connection succeeds.
// Scope: adapts npm/npx launch arguments and moves stderr draining before the connection attempt.
// Safety: native commands/channels retain their existing behavior and duplicate drain setup is removed.
// Remove when: upstream provides Electron-safe Chrome MCP launch plus early failure diagnostics.

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

const CONTRACT = 'JUSTDO_CHROME_MCP_LAUNCH_DIAGNOSTICS_V2026_8_2';
const SESSION_ANCHOR = 'async function createRealSession(';
const NATIVE_TRANSPORT_PATTERN =
  /\b(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new StdioClientTransport\(\{\s*command:\s*([A-Za-z_$][\w$]*)\.command,\s*args:\s*buildChromeMcpArgsFromOptions\(\3\),\s*stderr:\s*(["'`])pipe\4\s*\}\)/;
const WINDOWS_COMMAND = `// ${CONTRACT}
${resolveJustDoChromeMcpLaunch.toString()}
function buildJustDoChromeMcpTransportOptions(options) {
\tconst launch = resolveJustDoChromeMcpLaunch(
\t\toptions.command,
\t\tbuildChromeMcpArgsFromOptions(options),
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
const EMPTY_STDERR_PATTERN = /getStderr\s*=\s*\(\)\s*=>\s*(["'`])\1/;

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, 'Chrome MCP attach failed for profile');
  // Chrome MCP is a lazy runtime companion and is intentionally excluded from
  // the gateway bundle. The package chunk and worker are the complete target set.
  const expected = 2;
  if (files.length !== expected)
    throw new Error(`Chrome MCP launch target count is ${files.length}, expected ${expected}`);
  const changes = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    let transportVariable;
    const nativeTransport = NATIVE_TRANSPORT_PATTERN.exec(updated);
    if (nativeTransport) {
      transportVariable = nativeTransport[2];
      if (!updated.includes(CONTRACT)) {
        updated = replaceUnique(
          updated,
          SESSION_ANCHOR,
          `${WINDOWS_COMMAND}\n${SESSION_ANCHOR}`,
          'Chrome MCP Windows package runner helper',
        );
      }
      updated = replaceUniquePattern(
        updated,
        NATIVE_TRANSPORT_PATTERN,
        (_match, declaration, variable, options) =>
          `${declaration} ${variable} = new StdioClientTransport(buildJustDoChromeMcpTransportOptions(${options}))`,
        'Chrome MCP Windows package runner call',
      );
    } else if (!updated.includes(CONTRACT)) {
      throw new Error(`unknown Chrome MCP command shape: ${filePath}`);
    } else {
      const match =
        /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new StdioClientTransport\(buildJustDoChromeMcpTransportOptions/.exec(
          updated,
        );
      transportVariable = match?.[1];
    }
    if (!transportVariable)
      throw new Error(`Chrome MCP transport variable is unknown: ${filePath}`);
    const lateSourcePattern = new RegExp(
      `\\n\\s*getStderr\\s*=\\s*drainStderr\\(${transportVariable.replace(/[$]/g, '\\$&')}\\);`,
    );
    const lateWorkerPattern = new RegExp(
      `,getStderr=drainStderr\\(${transportVariable.replace(/[$]/g, '\\$&')}\\),`,
    );
    if (lateSourcePattern.test(updated)) {
      updated = replaceUnique(
        updated,
        lateSourcePattern.exec(updated)[0],
        '',
        'Chrome MCP late stderr assignment',
      );
    } else if (lateWorkerPattern.test(updated)) {
      updated = replaceUniquePattern(
        updated,
        lateWorkerPattern,
        ',',
        'Chrome MCP worker late stderr assignment',
      );
    }
    if (EMPTY_STDERR_PATTERN.test(updated)) {
      updated = replaceUniquePattern(
        updated,
        EMPTY_STDERR_PATTERN,
        `getStderr = drainStderr(${transportVariable})`,
        'Chrome MCP early stderr capture',
      );
    } else if (!updated.includes(`getStderr = drainStderr(${transportVariable})`)) {
      throw new Error(`unknown Chrome MCP stderr shape: ${filePath}`);
    }
    return { filePath, original, updated };
  });
  return changes
    .filter(change => writeIfChanged(change.filePath, change.original, change.updated))
    .map(change => path.relative(runtimeDir, change.filePath));
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, 'Chrome MCP attach failed for profile');
  const expected = 2;
  if (files.length !== expected)
    throw new Error('patched Chrome MCP companion targets are missing');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const contract of [
      'function resolveJustDoChromeMcpLaunch(',
      '/^(npm|npx)(?:\\.cmd)?$/i.exec(command)',
      '${runnerName}-cli.js',
      'buildJustDoChromeMcpTransportOptions(',
      'getStderr = drainStderr(',
      "['ELECTRON_RUN_AS_NODE', '1']",
      "['NODE_OPTIONS'",
    ]) {
      if (!content.includes(contract))
        throw new Error(`missing Chrome MCP launch contract in ${filePath}: ${contract}`);
    }
    const sessionIndex = content.indexOf(SESSION_ANCHOR);
    const connectIndex = content.indexOf('.connect(', sessionIndex);
    const stderrIndex = content.indexOf('getStderr = drainStderr(', sessionIndex);
    if (stderrIndex < 0 || connectIndex < 0 || stderrIndex > connectIndex)
      throw new Error(`Chrome MCP still starts stderr capture after connect: ${filePath}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    CONTRACT,
    NATIVE_TRANSPORT_PATTERN,
    WINDOWS_COMMAND,
    resolveJustDoChromeMcpLaunch,
  },
};
