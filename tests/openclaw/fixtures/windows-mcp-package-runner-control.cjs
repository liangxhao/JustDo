'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { transformSync } = require('esbuild');

const repo = path.resolve(__dirname, '../../..');
const runtime = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ??
    path.join(repo, 'vendor/openclaw-runtime/current'),
);
const dist = path.join(runtime, 'dist');
const moduleSource = (prefix, name) => {
  const exportPattern = new RegExp(`\\b${name} as ([\\w$]+)`);
  const filename = fs
    .readdirSync(dist)
    .find(
      file =>
        file.startsWith(prefix + '-') &&
        file.endsWith('.mjs') &&
        exportPattern.test(fs.readFileSync(path.join(dist, file), 'utf8')),
    );
  if (!filename) throw new Error(`Missing native ${name}`);
  const source = fs.readFileSync(path.join(dist, filename), 'utf8');
  const alias = source.match(exportPattern)?.[1];
  if (!alias) throw new Error(`Missing native export ${name}`);
  return { url: pathToFileURL(path.join(dist, filename)).href, alias, source };
};
const lifecycle = moduleSource('mcp-client-lifecycle', 'OpenClawStdioClientTransport');
if (lifecycle.source.includes('prepareJustDoWindowsMcpSpawn'))
  throw new Error('This test requires a pristine rebuild without 002');
const resolver = moduleSource('mcp-transport', 'resolveMcpTransport');

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
const nodeRuntime = loadSource('src/main/openclaw/runtime/launch/electronNodeRuntime.ts', {
  electron: { app: {} },
  '../../../core/network/trustedCertificates': loadSource(
    'src/main/core/network/trustedCertificates.ts',
    {},
  ),
  '../../../cowork/coworkLogger': { coworkLog: () => {} },
});
const { projectMcpPackageRunner } = loadSource('src/main/openclaw/runtime/mcpPackageRunner.ts', {
  electron: { app: {} },
  './launch/electronNodeRuntime': nodeRuntime,
});
const { buildElectronNodeShimScripts, buildWindowsChildProcessPreload } = nodeRuntime;
const electron =
  process.env.OPENCLAW_TEST_ELECTRON_PATH ??
  path.join(repo, 'node_modules/electron/dist/electron.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-package 中文 '));
try {
  const npm = path.join(root, 'npm');
  fs.mkdirSync(npm);
  const server = `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      let result;
      if (request.method === 'initialize') result = {
        protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'},
      };
      else if (request.method === 'tools/list') result = {
        tools:[{name:'ping',inputSchema:{type:'object',properties:{}}}],
      };
      else result = {content:[{type:'text',text:JSON.stringify({
        nodeMode:process.env.ELECTRON_RUN_AS_NODE,
        preload:require('node:child_process').spawn.name,
      })}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    });`;
  const serverPath = path.join(root, 'server.cjs');
  fs.writeFileSync(serverPath, server);
  for (const name of ['npm', 'npx']) fs.writeFileSync(path.join(npm, `${name}-cli.js`), server);
  const preloadPath = path.join(root, 'hide-child-process-windows.cjs');
  fs.writeFileSync(preloadPath, buildWindowsChildProcessPreload());
  const sdkURL = pathToFileURL(
    path.join(runtime, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
  ).href;
  for (const runner of ['fixture', 'real']) {
    const npmBinDir = runner === 'fixture' ? npm : path.join(repo, 'node_modules/npm/bin');
    const shims = buildElectronNodeShimScripts(electron, root, npmBinDir);
    fs.writeFileSync(path.join(root, 'node.cmd'), shims.nodeCmd);
    for (const name of ['npm', 'npx'])
      fs.writeFileSync(path.join(root, `${name}.cmd`), shims.packageCmd(name));
    for (const mode of ['application', 'batch']) {
      const configs = ['npm', 'npx'].map(command => {
        const call = 'node.cmd server.cjs';
        const args =
          runner === 'fixture'
            ? []
            : command === 'npm'
              ? ['exec', '--offline', '--yes=false', '--call', call]
              : ['--offline', '--yes=false', '--call', call];
        const config = {
          command,
          args,
          cwd: root,
          env: { NODE_OPTIONS: '--require untrusted-fixture.cjs' },
        };
        return {
          command,
          launch:
            mode === 'application'
              ? projectMcpPackageRunner(config, { electronPath: electron, npmBinDir, preloadPath })
              : config,
        };
      });
      const script = `
        const { ${resolver.alias}:resolve } = await import(${JSON.stringify(resolver.url)});
        const { Client } = await import(${JSON.stringify(sdkURL)});
        for (const {command,launch} of ${JSON.stringify(configs)}) {
          const errors=[];
          const client=new Client({name:'control',version:'1'});
          client.onerror=error=>errors.push(error.message);
          // Use native config normalization too, so unsafe NODE_OPTIONS is
          // dropped before startup and the explicit trusted preload must work.
          const resolved=resolve('fixture',launch);
          if(!resolved || resolved.transportType!=='stdio')throw new Error('Missing native stdio transport');
          const transport=resolved.transport;
          let stderr='';transport.stderr?.on('data',data=>stderr+=data.toString());
          const outcome={runner:${JSON.stringify(runner)},mode:${JSON.stringify(mode)},command};
          try {
            await client.connect(transport,{timeout:20000});
            outcome.connected=true;
            outcome.tools=(await client.listTools()).tools.map(tool=>tool.name);
            outcome.call=(await client.callTool({name:'ping',arguments:{}})).content;
          } catch(error) { outcome.connected=false;outcome.error=error.message; }
          finally {
            await client.close().catch(error=>errors.push('close: '+error.message));
            await transport.close().catch(error=>errors.push('transport-close: '+error.message));
            resolved.detachStderr?.();
          }
          outcome.errors=errors;outcome.stderr=stderr;
          console.log(JSON.stringify(outcome));
        }`;
      const output = execFileSync(electron, ['--input-type=module', '-e', script], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PATH: root + path.delimiter + process.env.PATH,
          Path: root + path.delimiter + process.env.PATH,
          OPENCLAW_STATE_DIR: path.join(root, 'state'),
          OPENCLAW_CONFIG_PATH: path.join(root, 'config.json'),
        },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 50_000,
      });
      process.stdout.write(output);
    }
  }
} finally {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid fixture cleanup path');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
