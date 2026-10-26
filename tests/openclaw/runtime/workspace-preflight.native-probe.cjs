'use strict';

// Actual Main loader/capture functions and native error-correlation owners.
// No socket, Gateway, user database, model request, or native ABI rebuild.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../../..');
const expectedVersion = `v${require('../../../package.json').openclaw.version.replace(/^v/u, '')}`;
const runtime = fs.realpathSync(process.argv[2]);
const source = fs.realpathSync(process.argv[3]);
const { targetContract, hostTarget } = require('../../../scripts/runtime/setup-node-runtime.cjs');
const manifest = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs')
  .verifyOpenClawPatchManifest(runtime, { repoRoot: root, version: expectedVersion });
const manifestSha256 = require('node:crypto').createHash('sha256')
  .update(fs.readFileSync(path.join(runtime, 'runtime-patch-manifest.json'))).digest('hex');
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(runtime, 'node-runtime', targetContract(hostTarget()).executable)));
assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version, expectedVersion.slice(1));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-preflight-native-'));
for (const name of Object.keys(process.env))
  if (/^OPENCLAW_/i.test(name) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(name)) delete process.env[name];
Object.assign(process.env, { OPENCLAW_HOME: fixture, OPENCLAW_STATE_DIR: path.join(fixture, 'state'),
  OPENCLAW_CONFIG_PATH: path.join(fixture, 'openclaw.json') });

function functions(file, names) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const found = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(found.length, 1, `Exactly one current function ${name} is required.`);
    return found[0].getText(tree);
  }).join('\n');
}
function compile(code) {
  const module = { exports: {} };
  const compiled = esbuild.transformSync(code, { loader: 'ts', format: 'cjs', target: 'node24' }).code;
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  return module.exports;
}
const connectionFile = path.join(root, 'src/main/engine/openclaw/runtimeGatewayConnection.ts');
const managerFile = path.join(root, 'src/main/openclaw/runtime/openclawEngineManager.ts');
const managerTree = ts.createSourceFile(managerFile, fs.readFileSync(managerFile, 'utf8'), ts.ScriptTarget.Latest, true);
const manager = managerTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'OpenClawEngineManager');
const resolver = manager.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(managerTree) === 'findGatewayClientEntryFromDistRoot');
assert.equal(resolver.length, 1);
const resolverFunction = 'function ' + resolver[0].getText(managerTree).replace(/^private\s+/, '');
const main = compile(`const fs=require('node:fs'),path=require('node:path');\n${resolverFunction}\n${functions(connectionFile,
  ['gatewayClientConstructor', 'loadGatewayClientCtor', 'captureGatewayResponseContext'])}\nmodule.exports={findGatewayClientEntryFromDistRoot,loadGatewayClientCtor,captureGatewayResponseContext};`);
const admission = compile(functions(path.join(source, 'src/state/agent-database-admission.ts'),
  ['createAgentDatabaseAdmissionErrorShape']));

(async () => {
  let client;
  try {
    const dist = path.join(runtime, 'dist');
    const entry = main.findGatewayClientEntryFromDistRoot(dist);
    assert.ok(entry, 'The actual Main resolver must select its native client.');
    const Ctor = await main.loadGatewayClientCtor(entry);
    client = new Ctor({ url: 'ws://127.0.0.1:1', env: process.env, sharedStateMode: 'read-only', deviceIdentity: null });
    const owner = { gatewayClient: client, gatewayClientGeneration: 1, gatewayClientEntryPath: entry };
    const capture = () => main.captureGatewayResponseContext.call(owner);
    const context = capture();
    assert.ok(context, 'The actual Main capture must find a facade bound to the selected constructor.');
    const facades = fs.readdirSync(dist).filter(name => /^client(?:-.*)?\.m?js$/.test(name))
      .filter(name => fs.readFileSync(path.join(dist, name), 'utf8').includes('isGatewayProtocolResponseError'))
      .map(name => ({ file: name, value: require(path.join(dist, name)) }))
      .filter(({ value }) => value.GatewayClient === Ctor && typeof value.isGatewayProtocolResponseError === 'function');
    assert.ok(facades.length > 0);
    const facade = facades[0].value;
    const protocolOwners = fs.readdirSync(dist).filter(name => /^protocol-request-.*\.mjs$/.test(name))
      .map(name => require(path.join(dist, name)))
      .flatMap(module => Object.values(module))
      .filter(value => typeof value === 'function' && value.name === 'retainGatewayResponsePayload');
    assert.equal(protocolOwners.length, 1, 'The native correlation owner must be unique.');
    const pending = (correlated = true) => {
      const error = new facade.GatewayClientRequestError(admission.createAgentDatabaseAdmissionErrorShape({
        agentId: 'main', paths: [], reason: 'controlled pending inspection', repairHint: 'controlled hint',
        code: 'agent-database-inspection-pending',
      }));
      if (correlated) protocolOwners[0](error, undefined);
      return error;
    };
    assert.equal(context.isResponseError(pending(false)), false, 'A native class with the same shape is not a received response.');
    assert.equal(context.isResponseError(pending()), true, 'The actual Main facade must share the native correlation WeakSet.');
    const serviceModule = { exports: {} };
    const serviceCode = esbuild.buildSync({ entryPoints: [path.join(root, 'src/main/plugins/mcp/workspaceAppSession.ts')],
      bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
    new Function('require', 'module', 'exports', serviceCode)(require, serviceModule, serviceModule.exports);
    const { WorkspaceAppSessions } = serviceModule.exports;
    async function scenario(kind) {
      const rows = new Map();
      let creates = 0, reads = 0;
      const failure = pending(kind !== 'uncorrelated');
      const workspaces = new WorkspaceAppSessions({
        getStore: () => ({ getConfig: () => ({ workingDirectory: fixture, permissionMode: 'auto' }), getAgent: () => ({ enabled: true }) }),
        captureResponseContext: async () => capture(),
        request: async (method, params, options) => {
          options?.assertBeforeSend?.();
          if (method === 'sessions.describe') {
            if (++reads === 1 && kind !== 'after-create') throw failure;
            return { session: rows.get(params.key) ?? null };
          }
          assert.equal(method, 'sessions.create'); creates++;
          if (kind === 'after-create') throw failure;
          const row = { sessionId: 'controlled-native-id', lifecycleRevision: 'revision', sessionRoot: fixture, permissionMode: 'workspace' };
          rows.set(params.key, row);
          return { key: params.key, sessionId: row.sessionId, entry: row, runStarted: false };
        },
      });
      const window = Object.assign(new EventEmitter(), { isDestroyed: () => false });
      const input = { requestId: require('node:crypto').randomUUID(), cwd: fixture, agentId: 'main' };
      await assert.rejects(() => workspaces.prepare(window, input), error => error === failure);
      if (kind === 'read-pending') {
        assert.equal(creates, 0);
        await workspaces.prepare(window, input);
        assert.equal(creates, 1);
      } else {
        await assert.rejects(() => workspaces.prepare(window, input), error => error === failure);
        assert.equal(creates, kind === 'after-create' ? 1 : 0);
      }
      return { kind, reads, creates };
    }
    const scenarios = [];
    for (const kind of ['read-pending', 'uncorrelated', 'after-create']) scenarios.push(await scenario(kind));
    owner.gatewayClientGeneration++;
    assert.equal(context.isCurrent(), false);
    await client.stopAndWait(); client = undefined;
    console.log('WORKSPACE_PREFLIGHT_NATIVE=' + JSON.stringify({ version: manifest.openclawVersion, manifestSha256,
      scope: 'actual Main resolver/loader/capture and native correlation owner; no network response or Gateway execution',
      selectedEntry: path.basename(entry), facade: facades.map(value => value.file), scenarios }));
    fs.rmSync(fixture, { recursive: true, force: true });
  } finally {
    if (client) await client.stopAndWait();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
