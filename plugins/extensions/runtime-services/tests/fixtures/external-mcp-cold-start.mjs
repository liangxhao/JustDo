import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [bundle, cwd, server, manifestFile] = process.argv.slice(2);
// Only the native SDK boundary is replaced. The bundled plugin registry,
// schema validator, MCP protocol client and stdio transport are production code.
globalThis.externalMcpColdSession = {
  sessionId: 'native',
  lifecycleRevision: 'one',
  sessionRoot: cwd,
  permissionMode: 'workspace',
};
const { registerExternalMcp } = await import(pathToFileURL(bundle).href);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const methods = new Map();
const services = [];
let policy;
let factory;
let cleanup;
const api = {
  runtime: { state: { resolveStateDir: () => cwd }, config: { current: () => ({}) } },
  registerGatewayMethod(name, handler, options) {
    methods.set(name, { handler, options });
  },
  registerService(service) {
    services.push(service);
  },
  lifecycle: {
    registerRuntimeLifecycle(value) {
      cleanup = value;
    },
  },
  registerTrustedToolPolicy(value) {
    assert.ok(manifest.contracts.trustedToolPolicies.includes(value.id));
    policy = value;
  },
  registerTool(value, options) {
    assert.ok(manifest.contracts.tools.includes(options.name));
    factory = value;
  },
};
const context = {
  sessionKey: 'agent:main:external-cold',
  sessionId: 'native',
  assertInvocationCurrent() {},
};
const request = {
  leaseId: 'cold',
  sessionKey: context.sessionKey,
  sessionId: context.sessionId,
  cwd,
  servers: [
    {
      name: 'fixture',
      command: process.execPath,
      args: [server],
      env: [{ name: 'EXTERNAL_MCP_FIXTURE', value: 'cold' }],
    },
  ],
};
const controller = new AbortController();
const rpc = async (name, params) => {
  let response;
  await methods.get(name).handler({
    params,
    client: {
      connect: { scopes: ['operator.admin', 'operator.read', 'operator.write'] },
      connectionSignal: controller.signal,
    },
    hasCurrentClientAuthority: () => true,
    respond(...args) {
      response = args;
    },
  });
  assert.equal(response[0], true, JSON.stringify(response));
  return response[1];
};

try {
  registerExternalMcp(api);
  assert.equal(factory.contextVersion, 2);
  assert.equal(factory.create(context), null);
  assert.equal(typeof cleanup.cleanup, 'function');
  assert.deepEqual(methods.get('runtimeServices.externalMcp.open').options, {
    scope: 'operator.write',
    profileAccess: 'required',
    sessionAccess: { mode: 'write' },
  });
  assert.deepEqual(await rpc('runtimeServices.externalMcp.open', request), {
    ok: true,
    leaseId: 'cold',
    serverCount: 1,
    toolCount: 1,
  });
  // A separately registered native factory instance must see the same lease.
  registerExternalMcp(api);
  assert.equal(factory.create({ ...context, sessionId: 'other' }), null);
  const tool = factory.create(context);
  assert.equal(tool.name, 'external_mcp');
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'call']);
  const listed = await tool.execute('list', { action: 'list' });
  assert.equal(listed.details.tools[0].inputSchema.properties.value.$ref, '#/$defs/text');
  assert.deepEqual(listed.details.tools[0].inputSchema.$defs.text, { type: 'string' });
  const input = {
    action: 'call',
    server: 'fixture',
    tool: 'echo',
    arguments: { value: 'cold value' },
  };
  const policyContext = { ...context, runId: 'run', toolCallId: 'call' };
  const invalid = { ...input, arguments: { value: 1 } };
  assert.equal(
    policy.evaluate({ toolName: tool.name, params: invalid }, policyContext).allow,
    false,
  );
  await assert.rejects(tool.execute('call', invalid), /arguments/);
  await assert.rejects(tool.execute('call', input), /approval/);
  const approval = policy.evaluate({ toolName: tool.name, params: input }, policyContext);
  assert.deepEqual(approval.requireApproval.allowedDecisions, ['allow-once', 'deny']);
  approval.requireApproval.onResolution('allow-once');
  const result = await tool.execute('call', input);
  assert.deepEqual(result.content, [{ type: 'text', text: 'cold value' }]);
  assert.equal(result.details.structuredContent.custom, 'cold');
  assert.equal(result.details.structuredContent.leakedToken, false);
  const normalize = value =>
    process.platform === 'win32' ? fs.realpathSync(value).toLowerCase() : fs.realpathSync(value);
  assert.equal(normalize(result.details.structuredContent.cwd), normalize(cwd));
  const pid = result.details.structuredContent.pid;
  assert.ok(Number.isInteger(pid));
  await assert.rejects(tool.execute('call', input), /approval/);
  assert.deepEqual(await rpc('runtimeServices.externalMcp.close', request), { ok: true });
  assert.equal(factory.create(context), null);
  assert.throws(
    () => process.kill(pid, 0),
    error => error.code === 'ESRCH',
  );
  assert.equal(fs.existsSync(path.join(path.dirname(bundle), 'node_modules')), false);
  process.stdout.write('registered schema-approved stdio-called closed\n');
} finally {
  controller.abort();
  await Promise.all(services.map(service => service.stop()));
}
