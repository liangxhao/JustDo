import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { applyPatch } = require('../scripts/patches/v2026.6.11/004-windows-mcp-package-runner.cjs') as {
  applyPatch: (runtimeDir: string) => string[];
};

const temporaryDirectories: string[] = [];

const createRuntime = (content: string): string => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mcp-patch-'));
  temporaryDirectories.push(runtimeDir);
  fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), content, 'utf8');
  return runtimeDir;
};

const runtimeFixture = `
const resolveWindowsSpawnProgram = () => ({});
const materializeWindowsSpawnProgram = () => ({});
function unrelatedCommand(command, args) {
  return spawn(command, args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
class StdioTransport {
  start() {
    if (process10.platform === "win32") {}
    const baseEnv = {};
    const preparedSpawn = prepareOomScoreAdjustedSpawn(this.serverParams.command, this.serverParams.args ?? [], { env: baseEnv });
    const child = spawn18(preparedSpawn.command, preparedSpawn.args, {
      cwd: this.serverParams.cwd,
      detached: process10.platform !== "win32",
      env: preparedSpawn.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return child;
  }
}
async function createRealSession(options) {
  const transport = new StdioClientTransport({
		command: options.command,
		args: buildChromeMcpArgsFromOptions(options),
		stderr: "pipe"
	});
  const client = new Client();
  let getStderr = () => "";
	const ready = (async () => {
    await client.connect(transport);
				getStderr = drainStderr(transport);
  })();
  return { transport, client, ready, getStderr };
}
async function listChromeMcpPages(profileName, profileOptions, options = {}) {
	return extractStructuredPages(await callTool(profileName, profileOptions, "list_pages", {}, options));
}
`;

const runtimeFixtureWithWindowsHide = runtimeFixture.replace(
  '      stdio: ["pipe", "pipe", "pipe"]',
  '      stdio: ["pipe", "pipe", "pipe"],\n      windowsHide: process10.platform === "win32"',
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows MCP runtime patch', () => {
  it('patches only the MCP spawn block and forwards windowsHide', () => {
    const runtimeDir = createRuntime(runtimeFixture);

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain('/* JUSTDO_WINDOWS_MCP_SPAWN */');
    expect(patched).toContain('windowsHide: windowsInvocation?.windowsHide ?? false');
    expect(patched).toContain('function unrelatedCommand(command, args)');
    expect(patched).toMatch(
      /function unrelatedCommand[\s\S]*?shell: false,\s*stdio:[\s\S]*?class StdioTransport/,
    );
  });

  it('keeps Electron-specific environment variables out of generic MCP commands', () => {
    const runtimeDir = createRuntime(runtimeFixture);

    applyPatch(runtimeDir);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain('const packageRunnerEnv = isWindowsPackageRunner ? {');
    expect(patched).toContain('} : baseEnv;');
    expect(patched).toContain('command: rawCommand, env: baseEnv');
  });

  it('provides the Electron path when npm bin discovery falls back to npx.cmd', () => {
    const runtimeDir = createRuntime(runtimeFixture);

    applyPatch(runtimeDir);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain(
      'JUSTDO_ELECTRON_PATH: process10.env.JUSTDO_ELECTRON_PATH || process10.execPath',
    );
    expect(patched).toContain(
      'JUSTDO_NPM_BIN_DIR: process10.env.JUSTDO_NPM_BIN_DIR || ""',
    );
    expect(patched).toContain(
      'prepareOomScoreAdjustedSpawn(windowsInvocation.command, windowsInvocation.argv, { env: packageRunnerEnv })',
    );
  });

  it('launches Chrome MCP npx through the managed Electron Node runtime', () => {
    const runtimeDir = createRuntime(runtimeFixture);

    applyPatch(runtimeDir);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain('/* JUSTDO_WINDOWS_CHROME_MCP_SPAWN */');
    expect(patched).toContain('path.join(process.env.JUSTDO_NPM_BIN_DIR, "npx-cli.js")');
    expect(patched).toContain('command: chromeMcpElectron || options.command');
    expect(patched).toContain(
      'args: chromeMcpElectron ? [chromeMcpNpxCli, ...chromeMcpArgs] : chromeMcpArgs',
    );
  });

  it('captures Chrome MCP stderr before the handshake can fail', () => {
    const runtimeDir = createRuntime(runtimeFixture);

    applyPatch(runtimeDir);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    const stderrCapture = patched.indexOf('/* JUSTDO_CHROME_MCP_EARLY_STDERR */');
    const connect = patched.indexOf('await client.connect(transport)');
    expect(stderrCapture).toBeGreaterThan(0);
    expect(stderrCapture).toBeLessThan(connect);
    expect(patched.match(/getStderr = drainStderr\(transport\)/g)).toHaveLength(1);
  });

  it('creates a selectable page when Chrome auto-connect exposes no initial page', () => {
    const runtimeDir = createRuntime(runtimeFixture);

    applyPatch(runtimeDir);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain('/* JUSTDO_CHROME_MCP_EMPTY_PAGE_RECOVERY */');
    expect(patched).toContain('err.message !== "No page selected"');
    expect(patched).toContain('callTool(profileName, profileOptions, "new_page"');
    expect(patched).toContain('url: "about:blank"');
  });

  it('keeps OpenClaw native windowsHide without adding a duplicate key', () => {
    const runtimeDir = createRuntime(runtimeFixtureWithWindowsHide);

    applyPatch(runtimeDir);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    const spawnOptions = patched.slice(
      patched.indexOf('const child = spawn'),
      patched.indexOf('});', patched.indexOf('const child = spawn')),
    );
    expect(spawnOptions.match(/\bwindowsHide\s*:/g)).toHaveLength(1);
    expect(spawnOptions).toContain('windowsHide: process10.platform === "win32"');
  });

  it('is idempotent', () => {
    const runtimeDir = createRuntime(runtimeFixture);

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const first = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(applyPatch(runtimeDir)).toEqual([]);
    expect(fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8')).toBe(first);
  });

  it('fails when the expected MCP implementation is absent', () => {
    const runtimeDir = createRuntime('export const value = 1;\n');

    expect(() => applyPatch(runtimeDir)).toThrow(
      'OpenClaw MCP stdio spawn implementation was not found',
    );
  });
});
