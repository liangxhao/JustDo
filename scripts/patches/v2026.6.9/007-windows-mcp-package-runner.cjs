'use strict';

// Purpose: Allow OpenClaw's native MCP stdio transport to launch npm/npx on
// Windows. Node 24 cannot spawn .cmd shims directly with shell:false, while
// user-authored MCP config conventionally uses command: "npx". Resolve npm and
// npx to their JavaScript entry points so no console-host process is created.
// Affected OpenClaw version: v2026.6.9.
// Risk: Low. Only npm/npx MCP commands on Windows are resolved through the
// Electron Node runtime and npm package bundled by JustDo.
// Remove when: OpenClaw's MCP stdio transport uses its existing Windows command
// invocation resolver.
// Upstream tracking: TODO(openclaw): upstream Windows MCP stdio command fix.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function walkJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  if (
    path.basename(filePath).startsWith('agent-bundle-mcp-runtime-') &&
    !content.includes('from "./windows-spawn-')
  ) {
    content = content.replace(
      /^(import .*?\r?\n)/,
      '$1import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } from "./windows-spawn-C3eNecff.js";\n',
    );
  }

  content = content.replace(
    /const preparedSpawn = prepareOomScoreAdjustedSpawn\(this\.serverParams\.command, this\.serverParams\.args \?\? \[\], \{ env: baseEnv \}\);/g,
    [
      'const rawCommand = this.serverParams.command;',
      'const rawArgs = this.serverParams.args ?? [];',
      'const isWindowsPackageRunner = process.platform === "win32" && /^(?:npm|npx)(?:\\.cmd)?$/i.test(rawCommand);',
      'const packageRunnerName = rawCommand.toLowerCase().replace(/\\.cmd$/, "");',
      'const packageRunnerCli = `${process.env.JUSTDO_NPM_BIN_DIR}\\\\${packageRunnerName}-cli.js`;',
      'const packageRunnerEnv = {',
      '  ...baseEnv,',
      '  JUSTDO_ELECTRON_PATH: process.env.JUSTDO_ELECTRON_PATH,',
      '  JUSTDO_NPM_BIN_DIR: process.env.JUSTDO_NPM_BIN_DIR,',
      '  ELECTRON_RUN_AS_NODE: "1",',
      '};',
      'const preparedSpawn = isWindowsPackageRunner',
      '  ? prepareOomScoreAdjustedSpawn(process.env.JUSTDO_ELECTRON_PATH, [packageRunnerCli, ...rawArgs], { env: packageRunnerEnv })',
      '  : prepareOomScoreAdjustedSpawn(rawCommand, rawArgs, { env: baseEnv });',
    ].join('\n'),
  );

  content = content.replace(
    /(const windowsSpawnEnv = \{[\s\S]*?JUSTDO_NPM_BIN_DIR: (process\d*)\.env\.JUSTDO_NPM_BIN_DIR,\r?\n)(?!\s*NODE_OPTIONS:)/g,
    (_match, prefix, processName) =>
      `${prefix}  NODE_OPTIONS: [${processName}.env.NODE_OPTIONS, ${processName}.env.JUSTDO_WINDOWS_HIDE_PRELOAD ? \`--require="\${${processName}.env.JUSTDO_WINDOWS_HIDE_PRELOAD}"\` : ""].filter(Boolean).join(" "),\n`,
  );

  content = content.replace(
    /const windowsInvocation = (process\d*)\.platform === "win32" \? materializeWindowsSpawnProgram\(resolveWindowsSpawnProgram\(\{ command: rawCommand, env: windowsSpawnEnv, execPath: \1\.env\.JUSTDO_ELECTRON_PATH, allowShellFallback: true \}\), rawArgs\) : null;/g,
    (_match, processName) =>
      [
        'const justDoPackageRunnerName = /^(?:npm|npx)(?:\\.cmd)?$/i.test(rawCommand) ? rawCommand.toLowerCase().replace(/\\.cmd$/, "") : null;',
        `const justDoPackageRunnerCli = justDoPackageRunnerName ? \`${'${'}${processName}.env.JUSTDO_NPM_BIN_DIR}\\\\${'${'}justDoPackageRunnerName}-cli.js\` : null;`,
        `const windowsInvocation = ${processName}.platform === "win32" ? justDoPackageRunnerCli ? { command: ${processName}.env.JUSTDO_ELECTRON_PATH, argv: [justDoPackageRunnerCli, ...rawArgs], shell: false, windowsHide: true } : materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({ command: rawCommand, env: windowsSpawnEnv, execPath: ${processName}.env.JUSTDO_ELECTRON_PATH, allowShellFallback: true }), rawArgs) : null;`,
      ].join('\n'),
  );

  content = content.replace(
    /const packageRunnerName = rawCommand\.toLowerCase\(\)\.replace\(\/\\\.cmd\$\/, ""\);[\s\S]*?const preparedSpawn = isWindowsPackageRunner\s*\?\s*prepareOomScoreAdjustedSpawn\((process\d*)\.env\.JUSTDO_ELECTRON_PATH, \[packageRunnerCli, \.\.\.rawArgs\], \{ env: packageRunnerEnv \}\)\s*:\s*prepareOomScoreAdjustedSpawn\(rawCommand, rawArgs, \{ env: baseEnv \}\);/g,
    (_match, processName) =>
      [
        'const windowsSpawnEnv = {',
        '  ...baseEnv,',
        `  JUSTDO_ELECTRON_PATH: ${processName}.env.JUSTDO_ELECTRON_PATH,`,
        `  JUSTDO_NPM_BIN_DIR: ${processName}.env.JUSTDO_NPM_BIN_DIR,`,
        `  NODE_OPTIONS: [${processName}.env.NODE_OPTIONS, ${processName}.env.JUSTDO_WINDOWS_HIDE_PRELOAD ? \`--require="\${${processName}.env.JUSTDO_WINDOWS_HIDE_PRELOAD}"\` : ""].filter(Boolean).join(" "),`,
        '  ELECTRON_RUN_AS_NODE: "1"',
        '};',
        `const windowsInvocation = ${processName}.platform === "win32" ? materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({ command: rawCommand, env: windowsSpawnEnv, execPath: ${processName}.env.JUSTDO_ELECTRON_PATH, allowShellFallback: true }), rawArgs) : null;`,
        'const preparedSpawn = windowsInvocation ? prepareOomScoreAdjustedSpawn(windowsInvocation.command, windowsInvocation.argv, { env: windowsSpawnEnv }) : prepareOomScoreAdjustedSpawn(rawCommand, rawArgs, { env: baseEnv });',
      ].join('\n'),
  );

  content = content.replace(
    /const windowsInvocation = (process\d*)\.platform === "win32" \? materializeWindowsSpawnProgram\(resolveWindowsSpawnProgram\(\{ command: rawCommand, env: windowsSpawnEnv, execPath: \1\.env\.JUSTDO_ELECTRON_PATH, allowShellFallback: true \}\), rawArgs\) : null;/g,
    (_match, processName) =>
      [
        'const justDoPackageRunnerName = /^(?:npm|npx)(?:\\.cmd)?$/i.test(rawCommand) ? rawCommand.toLowerCase().replace(/\\.cmd$/, "") : null;',
        `const justDoPackageRunnerCli = justDoPackageRunnerName ? \`${'${'}${processName}.env.JUSTDO_NPM_BIN_DIR}\\\\${'${'}justDoPackageRunnerName}-cli.js\` : null;`,
        `const windowsInvocation = ${processName}.platform === "win32" ? justDoPackageRunnerCli ? { command: ${processName}.env.JUSTDO_ELECTRON_PATH, argv: [justDoPackageRunnerCli, ...rawArgs], shell: false, windowsHide: true } : materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({ command: rawCommand, env: windowsSpawnEnv, execPath: ${processName}.env.JUSTDO_ELECTRON_PATH, allowShellFallback: true }), rawArgs) : null;`,
      ].join('\n'),
  );

  if (content.includes('const windowsInvocation =')) {
    content = content.replace(
      /shell: false,\r?\n(\s*)stdio:/g,
      'shell: windowsInvocation?.shell ?? false,\n$1stdio:',
    );
  }

  // Upgrade runtimes that were already patched before the JustDo shim
  // environment forwarding was added.
  content = content.replace(
    /const packageRunnerCommand = rawCommand\.toLowerCase\(\)\.endsWith\("\.cmd"\) \? rawCommand : `\$\{rawCommand\}\.cmd`;\r?\n(\s*)const preparedSpawn = isWindowsPackageRunner\r?\n\s*\? prepareOomScoreAdjustedSpawn\((process\d*)\.env\.ComSpec \|\| "cmd\.exe", \["\/d", "\/s", "\/c", \[packageRunnerCommand, \.\.\.rawArgs\]\.map\(quoteWindowsArg\)\.join\(" "\)\], \{ env: baseEnv \}\)/g,
    (_match, indent, processName) =>
      [
        'const packageRunnerCommand = rawCommand.toLowerCase().endsWith(".cmd") ? rawCommand : `${rawCommand}.cmd`;',
        `${indent}const packageRunnerEnv = {`,
        `${indent}  ...baseEnv,`,
        `${indent}  JUSTDO_ELECTRON_PATH: ${processName}.env.JUSTDO_ELECTRON_PATH,`,
        `${indent}  JUSTDO_NPM_BIN_DIR: ${processName}.env.JUSTDO_NPM_BIN_DIR,`,
        `${indent}};`,
        `${indent}const preparedSpawn = isWindowsPackageRunner`,
        `${indent}  ? prepareOomScoreAdjustedSpawn(${processName}.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [packageRunnerCommand, ...rawArgs].map(quoteWindowsArg).join(" ")], { env: packageRunnerEnv })`,
      ].join('\n'),
  );

  // Upgrade the earlier cmd.exe-based compatibility patch. Directly invoking
  // npx-cli.js prevents a visible console window for every MCP connection.
  content = content.replace(
    /const quoteWindowsArg = \(value\) => \{[\s\S]*?const packageRunnerCommand = rawCommand\.toLowerCase\(\)\.endsWith\("\.cmd"\) \? rawCommand : `\$\{rawCommand\}\.cmd`;\r?\n(\s*)const packageRunnerEnv = \{[\s\S]*?\1\};\r?\n\1const preparedSpawn = isWindowsPackageRunner(?:\r?\n\1\s*)? \? prepareOomScoreAdjustedSpawn\((process\d*)\.env\.ComSpec \|\| "cmd\.exe",[\s\S]*?\{ env: packageRunnerEnv \}\)(?:\r?\n\1\s*)? : prepareOomScoreAdjustedSpawn\(rawCommand, rawArgs, \{ env: baseEnv \}\);/g,
    (_match, indent, processName) =>
      [
        'const packageRunnerName = rawCommand.toLowerCase().replace(/\\.cmd$/, "");',
        `${indent}const packageRunnerCli = \`${'${'}${processName}.env.JUSTDO_NPM_BIN_DIR}\\\\${'${'}packageRunnerName}-cli.js\`;`,
        `${indent}const packageRunnerEnv = {`,
        `${indent}  ...baseEnv,`,
        `${indent}  JUSTDO_ELECTRON_PATH: ${processName}.env.JUSTDO_ELECTRON_PATH,`,
        `${indent}  JUSTDO_NPM_BIN_DIR: ${processName}.env.JUSTDO_NPM_BIN_DIR,`,
        `${indent}  ELECTRON_RUN_AS_NODE: "1"`,
        `${indent}};`,
        `${indent}const preparedSpawn = isWindowsPackageRunner ? prepareOomScoreAdjustedSpawn(${processName}.env.JUSTDO_ELECTRON_PATH, [packageRunnerCli, ...rawArgs], { env: packageRunnerEnv }) : prepareOomScoreAdjustedSpawn(rawCommand, rawArgs, { env: baseEnv });`,
      ].join('\n'),
  );

  content = content.replace(
    /const packageRunnerCommand = rawCommand\.toLowerCase\(\)\.endsWith\("\.cmd"\) \? rawCommand : `\$\{rawCommand\}\.cmd`;\r?\n(\s*)const preparedSpawn = isWindowsPackageRunner \? prepareOomScoreAdjustedSpawn\((process\d*)\.env\.ComSpec \|\| "cmd\.exe", \["\/d", "\/s", "\/c", \[packageRunnerCommand, \.\.\.rawArgs\]\.map\(quoteWindowsArg\)\.join\(" "\)\], \{ env: baseEnv \}\) : prepareOomScoreAdjustedSpawn\(rawCommand, rawArgs, \{ env: baseEnv \}\);/g,
    (_match, indent, processName) =>
      [
        'const packageRunnerCommand = rawCommand.toLowerCase().endsWith(".cmd") ? rawCommand : `${rawCommand}.cmd`;',
        `${indent}const packageRunnerEnv = {`,
        `${indent}  ...baseEnv,`,
        `${indent}  JUSTDO_ELECTRON_PATH: ${processName}.env.JUSTDO_ELECTRON_PATH,`,
        `${indent}  JUSTDO_NPM_BIN_DIR: ${processName}.env.JUSTDO_NPM_BIN_DIR`,
        `${indent}};`,
        `${indent}const preparedSpawn = isWindowsPackageRunner ? prepareOomScoreAdjustedSpawn(${processName}.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [packageRunnerCommand, ...rawArgs].map(quoteWindowsArg).join(" ")], { env: packageRunnerEnv }) : prepareOomScoreAdjustedSpawn(rawCommand, rawArgs, { env: baseEnv });`,
      ].join('\n'),
  );

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, all) => fs.existsSync(filePath) && all.indexOf(filePath) === index);

  const patched = [];
  for (const filePath of candidates) {
    if (patchFile(filePath)) {
      patched.push(path.relative(runtimeDir, filePath));
    }
  }

  const label = options.label || 'patch-openclaw-windows-mcp-package-runner';
  if (patched.length > 0) {
    console.log(`[${label}] Patched Windows MCP package runners: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No Windows MCP package runner patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
