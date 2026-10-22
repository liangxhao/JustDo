import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import CA from 'http-mitm-proxy/dist/lib/ca';
import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getName: () => 'fixture', getPath: () => '', isPackaged: false },
}));
import {
  appendNodeRequireOption,
  buildElectronNodeShimScripts,
  buildWindowsChildProcessPreload,
} from '../../openclaw/runtime/launch/electronNodeRuntime';
import { projectMcpPackageRunner } from '../../openclaw/runtime/mcpPackageRunner';
import {
  applyTrustedCertificateEnv,
  buildOutboundHeaderTrustedCaBundle,
} from './trustedCertificates';

const electronPath = require('electron') as string;
const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      windowsVerbatimArguments: command.toLowerCase().endsWith('cmd.exe'),
    });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('TLS child timed out'));
    }, 15_000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

async function createServer(directory: string) {
  const ca = await new Promise<CA>((resolve, reject) =>
    CA.create(directory, (error: Error | null, instance: CA) =>
      error ? reject(error) : resolve(instance),
    ),
  );
  const certificate = await new Promise<{ cert: string; key: string }>(resolve =>
    ca.generateServerCertificateKeys('127.0.0.1', (cert: string, key: string) =>
      resolve({ cert, key }),
    ),
  );
  const server = https.createServer(certificate, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback TLS server did not start');
  return {
    server,
    url: 'https://127.0.0.1:' + address.port,
    caFile: path.join(directory, 'certs', 'ca.pem'),
  };
}

test.runIf(process.platform === 'win32' && fs.existsSync(electronPath))(
  'Electron Unicode CA trust preserves SDK MCP isolation and verifies TLS through managed Node entries',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Node TLS 中文 空格-'));
    const trusted = await createServer(path.join(root, 'trusted'));
    const unrelated = await createServer(path.join(root, 'unrelated'));
    const results: Array<Record<string, unknown>> = [];
    try {
      const bundlePath = buildOutboundHeaderTrustedCaBundle(root, trusted.caFile)!;
      const shimDir = path.join(root, 'cowork', 'bin');
      fs.mkdirSync(shimDir, { recursive: true });
      const preload = path.join(shimDir, 'hide-child-process-windows.cjs');
      fs.writeFileSync(preload, buildWindowsChildProcessPreload());
      const npmBinDir = path.resolve('node_modules/npm/bin');
      const scripts = buildElectronNodeShimScripts(electronPath, shimDir, npmBinDir);
      fs.writeFileSync(path.join(shimDir, 'node.cmd'), scripts.nodeCmd);
      fs.writeFileSync(path.join(shimDir, 'npm.cmd'), scripts.packageCmd('npm'));
      const guard = path.join(root, 'loopback-only.cjs');
      fs.writeFileSync(
        guard,
        `const net = require('node:net'); const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) { let options = args[0]; while (Array.isArray(options)) options = options[0]; const host = typeof options === 'object' ? (options.host || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost'); if (!['127.0.0.1','::1','localhost'].includes(host)) throw new Error('External network blocked: ' + host); return connect.apply(this,args); };
const threads = require('node:worker_threads'), NativeWorker = threads.Worker;
threads.Worker = class extends NativeWorker {
  constructor(filename, options) {
    if (!Array.isArray(options?.execArgv)) { super(filename, options); return; }
    super(filename, {...options,execArgv:['--require=' + __filename,...options.execArgv]});
  }
};
require('node:module').syncBuiltinESMExports();
// Observe the actual npm parent after its production --require preload ran.
// This diagnostic never changes its CA store or supplies an additional CA.
if (process.env.PROBE_MCP === '1' && process.argv[1] === ${JSON.stringify(path.join(npmBinDir, 'npm-cli.js'))}) setImmediate(() => {
  const tls = require('node:tls');
  const snapshot = {
    preserved: tls.getCACertificates('system').every(cert => tls.getCACertificates('default').some(value => value.trim() === cert.trim())),
    systemRoots: tls.getCACertificates('system').length,
    extraCa: process.env.NODE_EXTRA_CA_CERTS ?? null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    proxyKeys: Object.keys(process.env).filter(key => /^(https?|all)_proxy$/i.test(key)),
  };
  const emit = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'trust/npm-parent',params:{...snapshot,...result}}) + '\\n');
  require('node:https').get(process.env.PROBE_URL, response => {response.resume();emit({ok:true,authorized:response.socket.authorized});}).on('error', error => emit({ok:false,code:error.code}));
});`,
      );
      const client = path.join(root, 'tls-client.cjs');
      fs.writeFileSync(
        client,
        `const https=require('node:https'),tls=require('node:tls');
      const preserved = tls.getCACertificates('system').every(cert => tls.getCACertificates('default').some(value => value.trim() === cert.trim()));
      if(process.env.PROBE_WORKER) {
        const {Worker}=require('node:worker_threads');
        const options = {eval:true,workerData:process.env.PROBE_URL};
        if (!process.env.PROBE_WORKER.startsWith('default')) options.execArgv = [];
        if (process.env.PROBE_WORKER.endsWith('clear-env')) options.env = {};
        const worker = new Worker('const {parentPort,workerData}=require("node:worker_threads"),tls=require("node:tls"); const preserved=tls.getCACertificates("system").every(cert=>tls.getCACertificates("default").some(value=>value.trim()===cert.trim())); require("node:https").get(workerData, response => { response.resume(); parentPort.postMessage({ok:true,authorized:response.socket.authorized,preserved}); }).on("error", error => parentPort.postMessage({ok:false,code:error.code,preserved}));', options); worker.once('message', result => process.stdout.write(JSON.stringify({...result})));
      } else https.get(process.env.PROBE_URL,response=>{ response.resume(); process.stdout.write(JSON.stringify({ok:true,authorized:response.socket.authorized,preserved,node:process.versions.node})); }).on('error',error=>process.stdout.write(JSON.stringify({ok:false,code:error.code,preserved})));`,
      );
      const base: NodeJS.ProcessEnv = {
        ...getDefaultEnvironment(),
        ELECTRON_RUN_AS_NODE: '1',
        PROBE_URL: trusted.url,
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_strict_ssl: 'true',
        npm_config_cache: path.join(root, 'npm-cache'),
        npm_config_logs_dir: path.join(root, 'npm-logs'),
        npm_config_userconfig: path.join(root, 'user.npmrc'),
        npm_config_globalconfig: path.join(root, 'global.npmrc'),
      };
      fs.writeFileSync(base.npm_config_userconfig!, '');
      fs.writeFileSync(base.npm_config_globalconfig!, '');
      delete base.NODE_TLS_REJECT_UNAUTHORIZED;
      delete base.PROBE_WORKER;
      for (const key of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ])
        delete base[key];
      applyTrustedCertificateEnv(base, bundlePath);
      const checked = async (
        channel: string,
        command: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        expected: boolean,
        npm = false,
      ) => {
        const result = await run(command, args, env);
        results.push({ channel, ...result });
        if (npm) {
          expect(result.status, result.stderr).toBe(expected ? 0 : 1);
        } else {
          expect(result.status, result.stderr).toBe(0);
          const response = JSON.parse(result.stdout.trim());
          expect(response.ok, result.stderr).toBe(expected);
          expect(response.preserved).toBe(true);
          if (expected) expect(response.authorized).toBe(true);
          else expect(response.code).toMatch(/CERT|SIGNATURE|ISSUER/);
        }
      };
      const gatewayEnv = {
        ...base,
        NODE_OPTIONS: appendNodeRequireOption(
          appendNodeRequireOption(base.NODE_OPTIONS, guard),
          preload,
        ),
      };
      await checked('gateway-trusted', electronPath, [client], gatewayEnv, true);
      await checked(
        'gateway-untrusted',
        electronPath,
        [client],
        { ...gatewayEnv, PROBE_URL: unrelated.url },
        false,
      );
      await checked(
        'gateway-worker-explicit-empty-execArgv',
        electronPath,
        [client],
        { ...gatewayEnv, PROBE_WORKER: '1' },
        true,
      );
      await checked(
        'gateway-worker-native-argv-inheritance',
        electronPath,
        ['--max-old-space-size=256', client],
        { ...gatewayEnv, PROBE_WORKER: 'default' },
        true,
      );
      const directPreloadEnv = { ...base, NODE_OPTIONS: undefined, PROBE_WORKER: 'default' };
      await checked(
        'managed-worker-native-argv-inheritance',
        electronPath,
        ['--max-old-space-size=256', '--require', guard, '--require', preload, client],
        directPreloadEnv,
        true,
      );
      await checked(
        'managed-worker-cleared-env-retains-system-only',
        electronPath,
        ['--max-old-space-size=256', '--require', guard, '--require', preload, client],
        { ...directPreloadEnv, PROBE_WORKER: 'default-clear-env' },
        false,
      );
      const cleanupDirectory = path.join(root, 'runtime-cleanup');
      fs.mkdirSync(cleanupDirectory);
      const {
        ensureWindowsRuntimePreload,
      } = require('../../openclaw/runtime/openclawGatewayBundleLauncher.cjs');
      const cleanupPreload = ensureWindowsRuntimePreload(cleanupDirectory).preloadPath;
      await checked(
        'gateway-with-cleanup-worker',
        electronPath,
        [client],
        {
          ...gatewayEnv,
          NODE_OPTIONS: appendNodeRequireOption(gatewayEnv.NODE_OPTIONS, cleanupPreload),
          PROBE_WORKER: '1',
        },
        true,
      );
      await checked(
        'gateway-with-cleanup-worker-native-argv-inheritance',
        electronPath,
        ['--max-old-space-size=256', client],
        {
          ...gatewayEnv,
          NODE_OPTIONS: appendNodeRequireOption(gatewayEnv.NODE_OPTIONS, cleanupPreload),
          PROBE_WORKER: 'default',
        },
        true,
      );
      const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
      const shimEnv = { ...base, NODE_OPTIONS: appendNodeRequireOption(undefined, guard) };
      await checked(
        'node-shim-trusted',
        command,
        ['/d', '/s', '/v:off', '/c', '""' + path.join(shimDir, 'node.cmd') + '" "' + client + '""'],
        shimEnv,
        true,
      );
      await checked(
        'node-shim-untrusted',
        command,
        ['/d', '/s', '/v:off', '/c', '""' + path.join(shimDir, 'node.cmd') + '" "' + client + '""'],
        { ...shimEnv, PROBE_URL: unrelated.url },
        false,
      );
      const npmArgs = [
        'ping',
        '--registry=' + trusted.url,
        '--fetch-retries=0',
        '--fetch-timeout=3000',
      ];
      await checked(
        'npm-shim-trusted',
        command,
        [
          '/d',
          '/s',
          '/v:off',
          '/c',
          '""' + path.join(shimDir, 'npm.cmd') + '" ' + npmArgs.join(' ') + '"',
        ],
        shimEnv,
        true,
        true,
      );
      await checked(
        'npm-shim-untrusted',
        command,
        [
          '/d',
          '/s',
          '/v:off',
          '/c',
          '""' +
            path.join(shimDir, 'npm.cmd') +
            '" ' +
            npmArgs.map(value => value.replace(trusted.url, unrelated.url)).join(' ') +
            '"',
        ],
        shimEnv,
        false,
        true,
      );
      // Use the actual SDK transport rather than a hand-merged parent env. Its
      // safe default projection deliberately drops NODE_* and proxy authority.
      expect(getDefaultEnvironment()).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
      expect(getDefaultEnvironment()).not.toHaveProperty('NODE_OPTIONS');
      const mcpDirectory = path.join(root, 'mcp-server');
      fs.mkdirSync(mcpDirectory);
      const mcpServer = path.join(mcpDirectory, 'server.cjs');
      fs.writeFileSync(
        mcpServer,
        `
const tls = require('node:tls');
const snapshot = {
  preserved: tls.getCACertificates('system').every(cert => tls.getCACertificates('default').some(value => value.trim() === cert.trim())),
  systemRoots: tls.getCACertificates('system').length,
  extraCa: process.env.NODE_EXTRA_CA_CERTS ?? null,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  proxyKeys: Object.keys(process.env).filter(key => /^(https?|all)_proxy$/i.test(key)),
};
const emit = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'trust/probe',params:{...snapshot,...result}}) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
if (process.env.PROBE_WORKER === '1') {
  const {Worker} = require('node:worker_threads');
  const worker = new Worker('const {parentPort}=require("node:worker_threads"); require("node:https").get(process.env.PROBE_URL, response => { response.resume(); parentPort.postMessage({ok:true,authorized:response.socket.authorized}); }).on("error", error => parentPort.postMessage({ok:false,code:error.code}));', {eval:true,execArgv:[]});
  worker.once('message', emit);
} else {
  require('node:https').get(process.env.PROBE_URL, response => {response.resume();emit({ok:true,authorized:response.socket.authorized});}).on('error', error => emit({ok:false,code:error.code}));
}
`,
      );
      fs.writeFileSync(
        path.join(mcpDirectory, 'package.json'),
        JSON.stringify({
          private: true,
          scripts: {
            probe: 'node --require "' + guard + '" "' + mcpServer + '"',
          },
        }),
      );
      const mcp = async (channel: string, url: string, explicitCa: boolean, worker = false) => {
        const env: Record<string, string> = {
          PATH: shimDir + path.delimiter + (getDefaultEnvironment().PATH || ''),
          PROBE_URL: url,
          PROBE_MCP: '1',
          PROBE_WORKER: worker ? '1' : '0',
          npm_config_update_notifier: 'false',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_strict_ssl: 'true',
          npm_config_cache: base.npm_config_cache!,
          npm_config_logs_dir: base.npm_config_logs_dir!,
          npm_config_userconfig: base.npm_config_userconfig!,
          npm_config_globalconfig: base.npm_config_globalconfig!,
        };
        if (explicitCa) env.NODE_EXTRA_CA_CERTS = bundlePath;
        const projected = projectMcpPackageRunner(
          {
            command: 'npm',
            args: ['--silent', 'run', '--prefix', mcpDirectory, 'probe'],
            env,
          },
          { electronPath, npmBinDir, preloadPath: preload },
        );
        expect(projected.env).not.toHaveProperty('NODE_OPTIONS');
        const transport = new StdioClientTransport({
          command: projected.command as string,
          args: ['--require', guard, ...(projected.args as string[])],
          env: projected.env as Record<string, string>,
          stderr: 'pipe',
        });
        let stderr = '';
        transport.stderr?.on('data', chunk => {
          stderr += chunk;
        });
        let timer: NodeJS.Timeout | undefined;
        const responses = new Map<string, Record<string, unknown>>();
        const response = new Promise<Map<string, Record<string, unknown>>>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('SDK MCP TLS probe timed out: ' + stderr)),
            15_000,
          );
          transport.onerror = reject;
          transport.onclose = () => {
            if (responses.size !== 2)
              reject(new Error('SDK MCP process closed before TLS response: ' + stderr));
          };
          transport.onmessage = message => {
            if (
              'method' in message &&
              ['trust/probe', 'trust/npm-parent'].includes(message.method)
            ) {
              responses.set(message.method, message.params as Record<string, unknown>);
              if (responses.size === 2) resolve(responses);
            }
          };
        });
        try {
          await transport.start();
          for (const [stage, value] of await response) {
            results.push({ channel, stage, ...value, stderr });
            expect(value.extraCa).toBe(explicitCa ? bundlePath : null);
            expect(value.nodeOptions).toBe(null);
            expect(value.proxyKeys).toEqual([]);
            expect(value.preserved).toBe(true);
            expect(value.systemRoots).toBeGreaterThan(0);
            const expected = explicitCa && url === trusted.url;
            expect(value.ok, stderr).toBe(expected);
            if (expected) expect(value.authorized).toBe(true);
            else expect(value.code).toMatch(/CERT|SIGNATURE|ISSUER/);
          }
        } finally {
          clearTimeout(timer);
          await transport.close();
        }
      };
      await mcp('mcp-sdk-default-rejects-private-ca', trusted.url, false);
      await mcp('mcp-sdk-default-worker-rejects-private-ca', trusted.url, false, true);
      await mcp('mcp-sdk-explicit-ca-trusted', trusted.url, true);
      await mcp('mcp-sdk-explicit-ca-untrusted', unrelated.url, true);
      await mcp('mcp-sdk-explicit-ca-worker-trusted', trusted.url, true, true);
    } finally {
      await Promise.all(
        [trusted, unrelated].map(
          ({ server }) => new Promise<void>(resolve => server.close(() => resolve())),
        ),
      );
      const report = process.env.RUNTIME_TRUST_TEST_REPORT;
      if (report) {
        fs.mkdirSync(path.dirname(report), { recursive: true });
        fs.writeFileSync(
          report,
          JSON.stringify({ root, externalNetworkBlocked: true, results }, null, 2),
        );
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
