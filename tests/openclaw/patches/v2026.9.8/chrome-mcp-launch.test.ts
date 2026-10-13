import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const {
  applyPatch,
  verifyPatch,
  __testing,
} = require('../../../../scripts/patches/v2026.9.8/003-windows-chrome-mcp-launch.cjs');
const { resolveJustDoChromeMcpLaunch: resolveLaunch, WINDOWS_HELPER } = __testing;
const electronPath = 'C:\\App With Spaces\\electron.exe';
const serverPath =
  'C:\\Runtime With Spaces\\node_modules\\chrome-devtools-mcp\\build\\src\\bin\\chrome-devtools-mcp.js';
const environment = {
  JUSTDO_ELECTRON_PATH: electronPath.replace(/\\/g, '/'),
  JUSTDO_NPM_BIN_DIR: 'C:\\runtime\\npm',
  JUSTDO_WINDOWS_HIDE_PRELOAD: 'C:\\app\\hide-child-process-windows.cjs',
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
};

test('runs the bundled direct Chrome MCP server in Electron Node mode while preserving native arguments and environment', () => {
  const args = [serverPath, '--experimentalVision', '--autoConnect', '--no-usage-statistics'];
  expect(resolveLaunch(electronPath, args, 'win32', environment)).toEqual({
    command: electronPath,
    args,
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require="C:\\app\\hide-child-process-windows.cjs"',
    },
  });
});

test('supports the bundled direct server without an npm installation', () => {
  expect(
    resolveLaunch(electronPath, [serverPath], 'win32', {
      JUSTDO_ELECTRON_PATH: electronPath,
    }).env,
  ).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
});

test('preserves caller Node options and does not duplicate the validated preload', () => {
  const env = { ...environment, NODE_OPTIONS: '--use-system-ca' };
  const first = resolveLaunch(electronPath, [serverPath], 'win32', env);
  expect(first.env.NODE_OPTIONS).toBe(
    '--use-system-ca --require="C:\\app\\hide-child-process-windows.cjs"',
  );
  expect(resolveLaunch(electronPath, [serverPath], 'win32', first.env).env.NODE_OPTIONS).toBe(
    first.env.NODE_OPTIONS,
  );
});

test.each([
  ['C:\\node\\node.exe', [serverPath], 'win32'],
  [electronPath, ['C:\\other-server.js'], 'win32'],
  [electronPath, [serverPath], 'linux'],
])('preserves unrelated native commands and platforms: %s %s %s', (command, args, platform) => {
  expect(resolveLaunch(command, args, platform, environment)).toEqual({
    command,
    args,
    env: undefined,
  });
});

test('retains Windows npm runner support', () => {
  expect(resolveLaunch('npx.cmd', ['chrome-devtools-mcp'], 'win32', environment)).toMatchObject({
    command: environment.JUSTDO_ELECTRON_PATH,
    args: ['C:\\runtime\\npm\\npx-cli.js', 'chrome-devtools-mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
});

const nativeDist = path.resolve('vendor/openclaw-runtime/current/dist');
const nativeChromeModule = fs.existsSync(nativeDist)
  ? fs
      .readdirSync(nativeDist)
      .find(
        name =>
          /^chrome-mcp-[^.]+\.mjs$/.test(name) &&
          fs
            .readFileSync(path.join(nativeDist, name), 'utf8')
            .includes('async function ensureChromeMcpAvailable('),
      )
  : undefined;

test.skipIf(process.platform !== 'win32' || !nativeChromeModule)(
  'completes a real bundled MCP handshake and process cleanup under Electron without requesting Chrome access',
  () => {
    const electron = require('electron') as string;
    const nativeUrl = pathToFileURL(path.join(nativeDist, nativeChromeModule!)).href;
    const optionsModule = fs
      .readdirSync(nativeDist)
      .find(name => /^chrome-mcp-options-.*\.mjs$/.test(name))!;
    const optionsUrl = pathToFileURL(path.join(nativeDist, optionsModule)).href;
    const patchPath = path.resolve('scripts/patches/v2026.9.8/003-windows-chrome-mcp-launch.cjs');
    const script = `
      import { createRequire } from 'node:module';
      import { n as ensure, O as close, k as pid } from ${JSON.stringify(nativeUrl)};
      import { r as normalize } from ${JSON.stringify(optionsUrl)};
      const require = createRequire(import.meta.url);
      const resolve = require(${JSON.stringify(patchPath)}).__testing.resolveJustDoChromeMcpLaunch;
      const options = normalize({});
      const launch = resolve(options.command, options.args, process.platform, {
        ...options.env, JUSTDO_ELECTRON_PATH: process.execPath
      });
      Object.assign(options, launch);
      try {
        await ensure('chrome-mcp-launch-test', options);
        if (!pid('chrome-mcp-launch-test')) throw new Error('Missing native MCP subprocess');
        console.log('handshake-ok');
      } finally {
        await close('chrome-mcp-launch-test');
        if (pid('chrome-mcp-launch-test')) throw new Error('MCP process retained after cleanup');
        console.log('cleanup-ok');
      }
    `;
    const output = execFileSync(electron, ['--input-type=module', '-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 25_000,
    });
    expect(output).toContain('handshake-ok');
    expect(output).toContain('cleanup-ok');
  },
  30_000,
);

test('patches both pristine runtime shapes and rejects historical helpers without rewriting them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mcp-launch-'));
  const shared = path.join(root, 'dist', 'chrome-mcp.mjs');
  const worker = path.join(root, 'dist', 'worker', 'worker.mjs');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(
    shared,
    `async function createRealSession(options) {
    const transport = new StdioClientTransport({command: options.command, args: options.args, env: options.env, stderr: "pipe"});
    const stderr = drainStderr(transport); await client.connect(transport);
    throw new Error("Chrome MCP attach failed for profile");
  }`,
  );
  fs.writeFileSync(
    worker,
    'async function createRealSession(A){const B=new StdioClientTransport({command:A.command,args:A.args,env:A.env,stderr:`pipe`});const C=drainStderr(B);await D.connect(B);throw Error("Chrome MCP attach failed for profile")}',
  );
  try {
    expect(applyPatch(root)).toHaveLength(2);
    expect(verifyPatch(root)).toBe(true);
    expect(applyPatch(root)).toEqual([]);
    const historical = fs
      .readFileSync(shared, 'utf8')
      .replace(
        WINDOWS_HELPER,
        WINDOWS_HELPER.replace("['ELECTRON_RUN_AS_NODE', '1']", "['ELECTRON_RUN_AS_NODE', '0']"),
      );
    fs.writeFileSync(shared, historical);
    expect(() => applyPatch(root)).toThrow('historical or partially applied');
    expect(() => verifyPatch(root)).toThrow('historical or partially applied');
    expect(fs.readFileSync(shared, 'utf8')).toBe(historical);
  } finally {
    const resolvedRoot = path.resolve(root);
    const tempRoot = path.resolve(os.tmpdir());
    const relative = path.relative(tempRoot, resolvedRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Invalid fixture cleanup path');
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
});
