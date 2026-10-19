'use strict';

// Prepare a local package/cache and exercise the actual Main projection and native
// MCP SDK. This script never edits application configuration or user MCP records.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { transformSync } = require('esbuild');

const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, '.agent-tasks/npx-mcp-smoke');
const fixture = path.join(repo, 'tests/openclaw/fixtures/npx-mcp-smoke');
const npmBinDir = path.join(repo, 'node_modules/npm/bin');
const cache = path.join(output, 'npm-cache');
const runtime = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ??
    path.join(repo, 'vendor/openclaw-runtime/current'),
);

const loadSource = (relative, imports) => {
  const code = transformSync(fs.readFileSync(path.join(repo, relative), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    name => imports[name] ?? require(name),
    compiled,
    compiled.exports,
  );
  return compiled.exports;
};

async function main() {
  fs.mkdirSync(output, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = path.join(output, 'state');
  process.env.OPENCLAW_CONFIG_PATH = path.join(output, 'openclaw.json');
  const run = (cli, args, cwd) =>
    execFileSync(process.execPath, [path.join(npmBinDir, cli), ...args], {
      cwd,
      windowsHide: true,
      timeout: 30_000,
      encoding: 'utf8',
    });
  const packed = JSON.parse(
    run(
      'npm-cli.js',
      [
        'pack',
        '--offline',
        '--ignore-scripts',
        '--json',
        `--cache=${cache}`,
        `--pack-destination=${output}`,
      ],
      fixture,
    ),
  );
  const archive = path.join(output, packed[0].filename);
  const args = [
    '--offline',
    '--yes',
    `--cache=${cache.replace(/\\/g, '/')}`,
    `--package=${archive.replace(/\\/g, '/')}`,
    'mcp-npx-smoke',
  ];
  const primed = JSON.parse(run('npx-cli.js', [...args, '--self-check'], output));
  assert.equal(primed.startedByNpx, true);

  const config = { name: 'Npx MCP Smoke', transportType: 'stdio', command: 'npx', args };
  const nodeRuntime = loadSource('src/main/openclaw/runtime/electronNodeRuntime.ts', {
    electron: { app: {} },
    '../../core/network/trustedCertificates': loadSource(
      'src/main/core/network/trustedCertificates.ts',
      {},
    ),
    '../../cowork/coworkLogger': { coworkLog: () => {} },
  });
  const { projectMcpPackageRunner } = loadSource('src/main/openclaw/runtime/mcpPackageRunner.ts', {
    electron: { app: {} },
    './electronNodeRuntime': nodeRuntime,
  });
  // Exercise Unicode and spaces in the Node shim/preload path too.
  const bin = path.join(output, '运行环境 bin');
  fs.mkdirSync(bin, { recursive: true });
  const electronPath =
    process.env.OPENCLAW_TEST_ELECTRON_PATH ??
    path.join(repo, 'node_modules/electron/dist/electron.exe');
  const preloadPath = path.join(bin, 'hide-child-process-windows.cjs');
  fs.writeFileSync(preloadPath, nodeRuntime.buildWindowsChildProcessPreload());
  fs.writeFileSync(
    path.join(bin, 'node.cmd'),
    nodeRuntime.buildElectronNodeShimScripts(electronPath, bin, npmBinDir).nodeCmd,
  );

  const dist = path.join(runtime, 'dist');
  const pattern = /\bresolveMcpTransport as ([\w$]+)/;
  const moduleFile = fs
    .readdirSync(dist)
    .find(
      file =>
        file.startsWith('mcp-transport-') &&
        file.endsWith('.mjs') &&
        pattern.test(fs.readFileSync(path.join(dist, file), 'utf8')),
    );
  if (!moduleFile) throw new Error('Native resolveMcpTransport export not found.');
  const alias = fs.readFileSync(path.join(dist, moduleFile), 'utf8').match(pattern)[1];
  const resolve = (await import(pathToFileURL(path.join(dist, moduleFile)).href))[alias];
  const { Client } = await import(
    pathToFileURL(
      path.join(runtime, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
    ).href
  );
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const launch = projectMcpPackageRunner(
    { ...config, cwd: runtime, env: { [pathKey]: bin + path.delimiter + process.env[pathKey] } },
    { electronPath, npmBinDir, preloadPath },
  );
  const resolved = resolve('npx-smoke', launch);
  assert.equal(resolved?.transportType, 'stdio');
  const client = new Client({ name: 'npx-smoke-check', version: '1' });
  const errors = [];
  client.onerror = error => errors.push(error.message);
  let stderr = '';
  resolved.transport.stderr?.on('data', data => {
    stderr += data.toString();
  });
  let info;
  try {
    await client.connect(resolved.transport, { timeout: 30_000 });
    assert.deepEqual(
      (await client.listTools()).tools.map(tool => tool.name),
      ['npx_smoke_echo', 'npx_smoke_runtime_info'],
    );
    const text = 'npx MCP 验证成功';
    const echo = await client.callTool({ name: 'npx_smoke_echo', arguments: { text } });
    assert.equal(echo.content[0].text, text);
    info = JSON.parse(
      (await client.callTool({ name: 'npx_smoke_runtime_info', arguments: {} })).content[0].text,
    );
    assert.equal(info.startedByNpx, true);
    assert.equal(info.electronNodeMode, true);
    assert.equal(info.windowsHidePreload, true);
    assert.equal(typeof info.electronVersion, 'string');
    await assert.rejects(
      client.callTool({ name: 'npx_smoke_echo', arguments: { text: 123 } }),
      /invalid tool arguments/,
    );
    await client.ping();
    assert.deepEqual(errors, []);
  } catch (error) {
    throw new Error(`${error.message}${stderr ? '\nMCP stderr: ' + stderr.slice(-8000) : ''}`);
  } finally {
    await client.close();
    await resolved.transport.close();
    resolved.detachStderr?.();
  }
  fs.writeFileSync(path.join(output, 'mcp-config.json'), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'args.txt'), args.join('\n') + '\n');
  fs.writeFileSync(
    path.join(output, 'verification.json'),
    JSON.stringify(
      { toolsListed: true, echoMatched: true, runtime: info, protocolErrors: errors },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        config: path.join(output, 'mcp-config.json'),
        args: path.join(output, 'args.txt'),
        verified: info,
      },
      null,
      2,
    ),
  );
}

if (process.platform !== 'win32')
  throw new Error('This manual fixture verifies the Windows Electron npx launcher.');
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
