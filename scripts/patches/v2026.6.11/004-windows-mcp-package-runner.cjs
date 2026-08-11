'use strict';

// Purpose: Allow OpenClaw's native MCP stdio transport to launch commands on
// Windows without opening console windows. npm/npx are invoked through their
// JavaScript entry points because Node 24 cannot spawn .cmd shims directly.
// Chrome MCP imports the upstream stdio transport directly, so patch its npx
// invocation separately and capture stderr before its handshake begins.
// Affected OpenClaw version: v2026.6.11.
// Risk: Diverges from upstream MCP process spawning on Windows and may mask
// spawn behavior changes if the upstream transport is refactored.
// Remove when: OpenClaw's MCP stdio transport uses its Windows spawn resolver.
// Upstream tracking: TODO(openclaw): file issue/PR with Electron Windows MCP
// npm/npx launch reproduction.
// Temporary: yes.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PATCH_MARKER = 'JUSTDO_WINDOWS_MCP_SPAWN';
const CHROME_MCP_PATCH_MARKER = 'JUSTDO_WINDOWS_CHROME_MCP_SPAWN';
const CHROME_MCP_STDERR_MARKER = 'JUSTDO_CHROME_MCP_EARLY_STDERR';
const CHROME_MCP_EMPTY_PAGE_MARKER = 'JUSTDO_CHROME_MCP_EMPTY_PAGE_RECOVERY';
const ORIGINAL_PREPARE_SPAWN =
  'const preparedSpawn = prepareOomScoreAdjustedSpawn(this.serverParams.command, this.serverParams.args ?? [], { env: baseEnv });';
const ORIGINAL_CHROME_MCP_TRANSPORT = `const transport = new StdioClientTransport({
		command: options.command,
		args: buildChromeMcpArgsFromOptions(options),
		stderr: "pipe"
	});`;
const ORIGINAL_CHROME_MCP_LIST_PAGES = `async function listChromeMcpPages(profileName, profileOptions, options = {}) {
	return extractStructuredPages(await callTool(profileName, profileOptions, "list_pages", {}, options));
}`;

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

function findWindowsSpawnModule(filePath) {
  const distDir = path.dirname(filePath);
  const match = fs
    .readdirSync(distDir)
    .find(name => /^windows-spawn-.*\.js$/.test(name));
  if (!match) {
    throw new Error(`Windows spawn helper not found next to ${filePath}`);
  }
  return match;
}

function ensureWindowsSpawnImport(content, filePath) {
  if (content.includes('resolveWindowsSpawnProgram')) return content;
  if (!path.basename(filePath).startsWith('agent-bundle-mcp-runtime-')) {
    throw new Error(`Windows spawn helper is unavailable in ${filePath}`);
  }
  const moduleName = findWindowsSpawnModule(filePath);
  const importLine =
    `import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } ` +
    `from "./${moduleName}";\n`;
  const next = content.replace(/^(import .*?\r?\n)/, `$1${importLine}`);
  if (next === content) {
    throw new Error(`Unable to insert Windows spawn import into ${filePath}`);
  }
  return next;
}

function buildReplacement(processName) {
  return [
    `/* ${PATCH_MARKER} */`,
    'const rawCommand = this.serverParams.command;',
    'const rawArgs = this.serverParams.args ?? [];',
    `const isWindowsPackageRunner = ${processName}.platform === "win32" && /^(?:npm|npx)(?:\\.cmd)?$/i.test(rawCommand);`,
    'const packageRunnerName = isWindowsPackageRunner ? rawCommand.toLowerCase().replace(/\\.cmd$/, "") : null;',
    `const packageRunnerCli = packageRunnerName && ${processName}.env.JUSTDO_NPM_BIN_DIR ? \`${'${'}${processName}.env.JUSTDO_NPM_BIN_DIR}\\\\${'${'}packageRunnerName}-cli.js\` : null;`,
    'const packageRunnerEnv = isWindowsPackageRunner ? {',
    '  ...baseEnv,',
    `  JUSTDO_ELECTRON_PATH: ${processName}.env.JUSTDO_ELECTRON_PATH || ${processName}.execPath,`,
    `  JUSTDO_NPM_BIN_DIR: ${processName}.env.JUSTDO_NPM_BIN_DIR || "",`,
    `  NODE_OPTIONS: [${processName}.env.NODE_OPTIONS, ${processName}.env.JUSTDO_WINDOWS_HIDE_PRELOAD ? \`--require="\${${processName}.env.JUSTDO_WINDOWS_HIDE_PRELOAD}"\` : ""].filter(Boolean).join(" "),`,
    '  ELECTRON_RUN_AS_NODE: "1"',
    '} : baseEnv;',
    `const windowsInvocation = ${processName}.platform === "win32" ? packageRunnerCli && ${processName}.env.JUSTDO_ELECTRON_PATH`,
    `  ? { command: ${processName}.env.JUSTDO_ELECTRON_PATH, argv: [packageRunnerCli, ...rawArgs], shell: false, windowsHide: true }`,
    `  : materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({ command: rawCommand, env: baseEnv, execPath: ${processName}.env.JUSTDO_ELECTRON_PATH, allowShellFallback: true }), rawArgs)`,
    '  : null;',
    'const preparedSpawn = windowsInvocation',
    '  ? prepareOomScoreAdjustedSpawn(windowsInvocation.command, windowsInvocation.argv, { env: packageRunnerEnv })',
    '  : prepareOomScoreAdjustedSpawn(rawCommand, rawArgs, { env: baseEnv });',
  ].join('\n');
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;
  const alreadyPatched = content.includes(PATCH_MARKER);

  if (!alreadyPatched) {
    const prepareIndex = content.indexOf(ORIGINAL_PREPARE_SPAWN);
    if (prepareIndex < 0) return false;

    const preceding = content.slice(Math.max(0, prepareIndex - 2_000), prepareIndex);
    const processMatches = [...preceding.matchAll(/(process\d*)\.platform/g)];
    const processName = processMatches.at(-1)?.[1] || 'process';

    content = ensureWindowsSpawnImport(content, filePath);
    const adjustedPrepareIndex = content.indexOf(ORIGINAL_PREPARE_SPAWN);
    content =
      content.slice(0, adjustedPrepareIndex) +
      buildReplacement(processName) +
      content.slice(adjustedPrepareIndex + ORIGINAL_PREPARE_SPAWN.length);
  } else if (content.includes('const packageRunnerEnv = packageRunnerCli ? {')) {
    const processName =
      content.match(/NODE_OPTIONS: \[(process\d*|process)\.env\.NODE_OPTIONS/)?.[1] || 'process';
    content = content.replace(
      'const packageRunnerEnv = packageRunnerCli ? {\n  ...baseEnv,\n',
      [
        'const packageRunnerEnv = isWindowsPackageRunner ? {',
        '  ...baseEnv,',
        `  JUSTDO_ELECTRON_PATH: ${processName}.env.JUSTDO_ELECTRON_PATH || ${processName}.execPath,`,
        `  JUSTDO_NPM_BIN_DIR: ${processName}.env.JUSTDO_NPM_BIN_DIR || "",`,
        '',
      ].join('\n'),
    );
  }

  const markerIndex = content.indexOf(PATCH_MARKER);
  const childSpawnIndex = content.indexOf('const child = spawn', markerIndex);
  const spawnBlockEnd = content.indexOf('});', childSpawnIndex);
  if (childSpawnIndex < 0 || spawnBlockEnd < 0) {
    throw new Error(`MCP spawn options block not found in ${filePath}`);
  }
  const spawnRegion = content.slice(childSpawnIndex, spawnBlockEnd);
  let patchedSpawnRegion = spawnRegion.replace(
    /shell: false,\r?\n(\s*)stdio:/,
    'shell: windowsInvocation?.shell ?? false,\n$1stdio:',
  );
  if (
    !patchedSpawnRegion.includes('shell: windowsInvocation?.shell ?? false')
  ) {
    throw new Error(`MCP spawn shell option not found in ${filePath}`);
  }
  const windowsHideMatches = patchedSpawnRegion.match(/\bwindowsHide\s*:/g) ?? [];
  if (windowsHideMatches.length === 0) {
    patchedSpawnRegion = patchedSpawnRegion.replace(
      /(shell: windowsInvocation\?\.shell \?\? false,\r?\n)(\s*)/,
      '$1$2windowsHide: windowsInvocation?.windowsHide ?? false,\n$2',
    );
  } else if (windowsHideMatches.length > 1) {
    patchedSpawnRegion = patchedSpawnRegion.replace(
      /^\s*windowsHide: windowsInvocation\?\.windowsHide \?\? false,\r?\n/m,
      '',
    );
  }
  content =
    content.slice(0, childSpawnIndex) + patchedSpawnRegion + content.slice(spawnBlockEnd);

  if ((content.match(new RegExp(PATCH_MARKER, 'g')) || []).length !== 1) {
    throw new Error(`Unexpected MCP patch marker count in ${filePath}`);
  }
  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  const syntaxCheck = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (syntaxCheck.status !== 0) {
    fs.writeFileSync(filePath, original, 'utf8');
    throw new Error(
      `Patched MCP runtime is invalid (${filePath}): ${syntaxCheck.stderr.trim()}`,
    );
  }
  return true;
}

function patchChromeMcpFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  if (!content.includes(CHROME_MCP_PATCH_MARKER)) {
    if (!content.includes(ORIGINAL_CHROME_MCP_TRANSPORT)) return false;
    const replacement = `/* ${CHROME_MCP_PATCH_MARKER} */
	const chromeMcpArgs = buildChromeMcpArgsFromOptions(options);
	const isWindowsNpx = process.platform === "win32" && /^npx(?:\\.cmd)?$/i.test(options.command);
	const chromeMcpNpxCli = isWindowsNpx && process.env.JUSTDO_NPM_BIN_DIR
		? path.join(process.env.JUSTDO_NPM_BIN_DIR, "npx-cli.js")
		: void 0;
	const chromeMcpElectron = chromeMcpNpxCli && process.env.JUSTDO_ELECTRON_PATH;
	const chromeMcpEnv = chromeMcpElectron
		? {
			...Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string")),
			ELECTRON_RUN_AS_NODE: "1",
			NODE_OPTIONS: [process.env.NODE_OPTIONS, process.env.JUSTDO_WINDOWS_HIDE_PRELOAD
				? \`--require="\${process.env.JUSTDO_WINDOWS_HIDE_PRELOAD}"\`
				: ""].filter(Boolean).join(" ")
		}
		: void 0;
	const transport = new StdioClientTransport({
		command: chromeMcpElectron || options.command,
		args: chromeMcpElectron ? [chromeMcpNpxCli, ...chromeMcpArgs] : chromeMcpArgs,
		env: chromeMcpEnv,
		stderr: "pipe"
	});`;
    content = content.replace(ORIGINAL_CHROME_MCP_TRANSPORT, replacement);
  }

  if (!content.includes(CHROME_MCP_STDERR_MARKER)) {
    const originalStderr = `let getStderr = () => "";
	const ready = (async () => {`;
    const replacementStderr = `let getStderr = () => "";
	/* ${CHROME_MCP_STDERR_MARKER} */
	getStderr = drainStderr(transport);
	const ready = (async () => {`;
    if (!content.includes(originalStderr)) {
      throw new Error(`Chrome MCP stderr initialization was not found in ${filePath}`);
    }
    content = content.replace(originalStderr, replacementStderr);
    content = content.replace('\n\t\t\t\tgetStderr = drainStderr(transport);', '');
  }

  if (!content.includes(CHROME_MCP_EMPTY_PAGE_MARKER)) {
    if (!content.includes(ORIGINAL_CHROME_MCP_LIST_PAGES)) {
      throw new Error(`Chrome MCP page listing implementation was not found in ${filePath}`);
    }
    const replacementListPages = `async function listChromeMcpPages(profileName, profileOptions, options = {}) {
	try {
		return extractStructuredPages(await callTool(profileName, profileOptions, "list_pages", {}, options));
	} catch (err) {
		/* ${CHROME_MCP_EMPTY_PAGE_MARKER} */
		if (!(err instanceof Error) || err.message !== "No page selected") throw err;
		return extractStructuredPages(await callTool(profileName, profileOptions, "new_page", {
			url: "about:blank",
			timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS
		}, options));
	}
}`;
    content = content.replace(ORIGINAL_CHROME_MCP_LIST_PAGES, replacementListPages);
  }

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  const syntaxCheck = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (syntaxCheck.status !== 0) {
    fs.writeFileSync(filePath, original, 'utf8');
    throw new Error(
      `Patched Chrome MCP runtime is invalid (${filePath}): ${syntaxCheck.stderr.trim()}`,
    );
  }
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, all) => fs.existsSync(filePath) && all.indexOf(filePath) === index);

  const targetFiles = candidates.filter(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes(ORIGINAL_PREPARE_SPAWN) || content.includes(PATCH_MARKER);
  });
  if (targetFiles.length === 0) {
    throw new Error('OpenClaw MCP stdio spawn implementation was not found');
  }

  const chromeMcpFiles = candidates.filter(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return (
      content.includes(ORIGINAL_CHROME_MCP_TRANSPORT) ||
      content.includes(CHROME_MCP_PATCH_MARKER)
    );
  });
  if (chromeMcpFiles.length === 0) {
    throw new Error('OpenClaw Chrome MCP transport implementation was not found');
  }

  const patched = Array.from(
    new Set([
      ...targetFiles.filter(patchFile),
      ...chromeMcpFiles.filter(patchChromeMcpFile),
    ]),
  ).map(filePath => path.relative(runtimeDir, filePath));
  const label = options.label || 'patch-openclaw-windows-mcp-package-runner';
  if (patched.length > 0) {
    console.log(`[${label}] Patched Windows MCP spawning: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] Windows MCP spawning is already patched.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    'const isWindowsPackageRunner =',
    'JUSTDO_ELECTRON_PATH:',
    'JUSTDO_NPM_BIN_DIR:',
    'materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({',
    'const preparedSpawn = windowsInvocation',
    'shell: windowsInvocation?.shell ?? false',
    'windowsHide: process',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) {
    throw new Error(`Windows MCP package runner patch is incomplete: ${missing.join(', ')}`);
  }
  const chromeMcpFiles = walkJsFiles(path.join(runtimeDir, 'dist')).filter(filePath => {
    if (!path.basename(filePath).startsWith('chrome-mcp-')) return false;
    return fs.readFileSync(filePath, 'utf8').includes('async function listChromeMcpPages');
  });
  if (
    chromeMcpFiles.length === 0 ||
    !chromeMcpFiles.every(filePath => {
      const chromeMcpContent = fs.readFileSync(filePath, 'utf8');
      return (
        chromeMcpContent.includes(CHROME_MCP_PATCH_MARKER) &&
        chromeMcpContent.includes(CHROME_MCP_STDERR_MARKER) &&
        chromeMcpContent.includes(CHROME_MCP_EMPTY_PAGE_MARKER)
      );
    })
  ) {
    throw new Error('Windows Chrome MCP package runner patch is incomplete');
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
