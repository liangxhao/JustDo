import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, onTestFinished, test, vi } from 'vitest';

import { BrowserMode } from '../../../src/shared/browser/browser';
vi.mock('electron', () => ({
  app: { getName: () => 'fixture', getPath: () => '', isPackaged: false },
}));
import {
  buildManagedOpenClawConnectivityConfig,
  projectManagedOpenClawBrowserConfig,
} from '../../../src/main/openclaw/config/openclawConfigBuilders';
import {
  buildElectronNodeShimScripts,
  buildWindowsChildProcessPreload,
} from '../../../src/main/openclaw/runtime/launch/electronNodeRuntime';
import { projectMcpPackageRunner } from '../../../src/main/openclaw/runtime/mcpPackageRunner';

const runtimeRoot = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);
const nativeDist = path.join(runtimeRoot, 'dist');
const electronPath =
  process.env.OPENCLAW_TEST_ELECTRON_PATH ??
  path.join(runtimeRoot, 'node-runtime', 'node.exe');
const nativeModule = (name: string, signature: string) =>
  fs.existsSync(nativeDist)
    ? fs
        .readdirSync(nativeDist)
        .find(
          file =>
            file.startsWith(name + '-') &&
            file.endsWith('.mjs') &&
            fs.readFileSync(path.join(nativeDist, file), 'utf8').includes(signature),
        )
    : undefined;
const exportAlias = (file: string, name: string): string => {
  const alias = fs
    .readFileSync(path.join(nativeDist, file), 'utf8')
    .match(new RegExp(`\\b${name} as ([\\w$]+)\\b`))?.[1];
  if (!alias) throw new Error(`Missing native export ${name}`);
  return alias;
};
const stdioModule = nativeModule(
  'mcp-client-lifecycle',
  'OpenClawStdioClientTransport already started',
);
const chromeModule = nativeModule('chrome-mcp', 'async function ensureChromeMcpAvailable(');
const chromeOptionsModule = nativeModule(
  'chrome-mcp-options',
  'function normalizeChromeMcpOptions(',
);
const browserConfigModule = path.join(nativeDist, 'extensions', 'browser', 'browser-config.js');

test.skipIf(
  process.platform !== 'win32' || !chromeOptionsModule || !fs.existsSync(browserConfigModule),
)(
  'implicit user profiles in other modes resolve to the application launcher through the native browser resolver',
  () => {
    const configs = [BrowserMode.Isolated, BrowserMode.Extension].map(mode =>
      projectManagedOpenClawBrowserConfig(buildManagedOpenClawConnectivityConfig(mode)),
    );
    const script = `
      import assert from 'node:assert/strict';
      import { resolveBrowserConfig, resolveProfile } from ${JSON.stringify(pathToFileURL(browserConfigModule).href)};
      import { ${exportAlias(chromeOptionsModule!, 'normalizeChromeMcpOptions')} as normalize } from ${JSON.stringify(pathToFileURL(path.join(nativeDist, chromeOptionsModule!)).href)};
      for (const config of ${JSON.stringify(configs)}) {
        const resolved = resolveBrowserConfig(config.browser, config);
        const user = resolveProfile(resolved, 'user');
        assert.equal(resolved.defaultProfile, config.browser.defaultProfile);
        assert.equal(user.driver, 'existing-session');
        assert.equal(normalize(user).command, 'chrome-mcp.cmd');
      }
      console.log('implicit-profiles-ok');`;
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      }),
    ).toContain('implicit-profiles-ok');
  },
  20000,
);

test.skipIf(process.platform !== 'win32' || !stdioModule || !fs.existsSync(electronPath))(
  'application and native package runners preserve the trusted preload without batch diagnostics',
  () => {
    const output = execFileSync(
      process.execPath,
      [path.resolve('tests/openclaw/fixtures/windows-mcp-package-runner-control.cjs')],
      {
        env: {
          ...process.env,
          OPENCLAW_TEST_NATIVE_RUNTIME_DIR: runtimeRoot,
          OPENCLAW_TEST_ELECTRON_PATH: electronPath,
        },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    const results = output
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.connected).toBe(true);
      expect(result.tools).toEqual(['ping']);
      expect(JSON.parse(result.call[0].text)).toEqual({
        nodeMode: '1',
        preload: 'hiddenWindowsSpawn',
      });
      expect(result.errors).toEqual([]);
      expect(result.stderr).toBe('');
    }
  },
  125_000,
);

test.skipIf(process.platform !== 'win32' || !stdioModule || !fs.existsSync(electronPath))(
  'real npx package bins preserve the trusted preload when nested batch scripts invoke bare node',
  () => {
    const output = execFileSync(
      process.execPath,
      [path.resolve('scripts/test/prepare-npx-mcp-smoke.cjs')],
      {
        env: {
          ...process.env,
          OPENCLAW_TEST_NATIVE_RUNTIME_DIR: runtimeRoot,
          OPENCLAW_TEST_ELECTRON_PATH: electronPath,
        },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(JSON.parse(output).verified).toMatchObject({
      startedByNpx: true,
      electronNodeMode: true,
      windowsHidePreload: true,
      platform: 'win32',
    });
  },
  65_000,
);

test('Chrome launcher owns Node mode, pinned server, vision and child-window suppression', () => {
  const source = buildElectronNodeShimScripts(
    'C:\\App With Spaces\\electron.exe',
    'C:\\User Data\\cowork\\bin',
    undefined,
    'C:\\Runtime With Spaces\\chrome-devtools-mcp.js',
  ).chromeMcpCmd!;
  expect(source).toContain('set ELECTRON_RUN_AS_NODE=1');
  expect(source).toContain('CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1');
  expect(source).toContain(
    '--require "C:\\User Data\\cowork\\bin\\hide-child-process-windows.cjs"',
  );
  expect(source).toContain(
    '"C:\\Runtime With Spaces\\chrome-devtools-mcp.js" --experimentalVision %*',
  );
});

test.skipIf(
  process.platform !== 'win32' ||
    !stdioModule ||
    !chromeModule ||
    !chromeOptionsModule ||
    !fs.existsSync(electronPath),
)(
  'native MCP and Chrome transports handshake and clean up with application shims after environment filtering',
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MCP launch 中文 '));
    onTestFinished(() => {
      const relative = path.relative(os.tmpdir(), root);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Invalid fixture cleanup path');
      fs.rmSync(root, { recursive: true, force: true });
    });
    const npmBin = path.join(root, 'npm');
    fs.mkdirSync(npmBin);
    const server = path.join(root, 'server.cjs');
    const serverSource = `
        const assert = require('node:assert/strict');
        assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(require('node:child_process').spawn.name, 'hiddenWindowsSpawn');
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          const result = request.method === 'initialize'
            ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
            : {tools:[{name:'list_pages',inputSchema:{type:'object',properties:{}}}]};
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');
        });`;
    fs.writeFileSync(server, serverSource);
    for (const name of ['npm', 'npx'])
      fs.writeFileSync(path.join(npmBin, `${name}-cli.js`), serverSource);
    const shims = buildElectronNodeShimScripts(electronPath, root, npmBin, server);
    fs.writeFileSync(path.join(root, 'node.cmd'), shims.nodeCmd);
    fs.writeFileSync(
      path.join(root, 'hide-child-process-windows.cjs'),
      buildWindowsChildProcessPreload(),
    );
    fs.writeFileSync(path.join(root, 'chrome-mcp.cmd'), shims.chromeMcpCmd!);
    const pinnedServer = path.join(
      runtimeRoot,
      'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    );
    expect(fs.existsSync(pinnedServer)).toBe(true);
    fs.writeFileSync(
      path.join(root, 'chrome-pinned.cmd'),
      buildElectronNodeShimScripts(electronPath, root, undefined, pinnedServer).chromeMcpCmd!,
    );
    for (const name of ['npm', 'npx'] as const)
      fs.writeFileSync(path.join(root, `${name}.cmd`), shims.packageCmd(name));
    const stdioUrl = pathToFileURL(path.join(nativeDist, stdioModule!)).href;
    const chromeUrl = pathToFileURL(path.join(nativeDist, chromeModule!)).href;
    const optionsUrl = pathToFileURL(path.join(nativeDist, chromeOptionsModule!)).href;
    const packageLaunches = ['npm', 'npx'].map(command =>
      projectMcpPackageRunner(
        { command, args: [], env: {} },
        {
          electronPath,
          npmBinDir: npmBin,
          preloadPath: path.join(root, 'hide-child-process-windows.cjs'),
        },
      ),
    );
    const script = `
        import { ${exportAlias(stdioModule!, 'OpenClawStdioClientTransport')} as Transport } from ${JSON.stringify(stdioUrl)};
        import { ${exportAlias(chromeModule!, 'ensureChromeMcpAvailable')} as ensure,
          ${exportAlias(chromeModule!, 'closeChromeMcpSession')} as close,
          ${exportAlias(chromeModule!, 'getChromeMcpPid')} as pid } from ${JSON.stringify(chromeUrl)};
        import { ${exportAlias(chromeOptionsModule!, 'normalizeChromeMcpOptions')} as normalize } from ${JSON.stringify(optionsUrl)};
        import assert from 'node:assert/strict';
        for (const launch of ${JSON.stringify(packageLaunches)}) {
          const transport = new Transport({...launch, stderr:'pipe'});
          let stderr = '';
          transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
          const received = new Promise((resolve,reject) => {
            transport.onmessage=resolve; transport.onerror=reject;
            transport.onexit=exit => reject(new Error('Synthetic MCP exit: '+JSON.stringify(exit)+' '+stderr));
          });
          await transport.start();
          await transport.send({jsonrpc:'2.0',id:1,method:'initialize',params:{}});
          assert.equal((await received).result.serverInfo.name, 'fixture');
          await transport.close();
        }
        try {
          await ensure('launcher-fixture', normalize({mcpCommand:'chrome-mcp.cmd'}));
          assert.ok(pid('launcher-fixture'));
        } finally { await close('launcher-fixture'); assert.equal(pid('launcher-fixture'), null); }
        try {
          await ensure('pinned-launcher-fixture', normalize({mcpCommand:'chrome-pinned.cmd'}));
          assert.ok(pid('pinned-launcher-fixture'));
        } finally { await close('pinned-launcher-fixture'); assert.equal(pid('pinned-launcher-fixture'), null); }
        console.log('handshake-and-cleanup-ok');`;
    const output = execFileSync(electronPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PATH: root + path.delimiter + process.env.PATH,
        Path: root + path.delimiter + process.env.PATH,
        JUSTDO_ELECTRON_PATH: electronPath,
        OPENCLAW_STATE_DIR: path.join(root, 'state'),
        OPENCLAW_CONFIG_PATH: path.join(root, 'config.json'),
      },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 45_000,
    });
    expect(output).toContain('handshake-and-cleanup-ok');
  },
  50_000,
);
