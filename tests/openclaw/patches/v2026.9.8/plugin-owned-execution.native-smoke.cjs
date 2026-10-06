'use strict';

// Opt-in real Gateway probe. Only its own isolated state, ports and processes
// are used; the installed application and prepared vendor runtime are untouched.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const WebSocket = require('ws');
const runtime = process.env.JUSTDO_EXECUTION_RUNTIME;
const longProbe = process.env.JUSTDO_EXECUTION_LONG === '1';
if (!runtime) throw new Error('Set JUSTDO_EXECUTION_RUNTIME to an isolated prepared prototype.');
const base = path.resolve('.work/plugin-owned-execution-' + Date.now());
const project = path.join(base, 'project');
fs.mkdirSync(project, { recursive: true });
const plugins = path.join(base, 'extensions');
for (const id of ['owned-probe', 'other-probe']) {
  const directory = path.join(plugins, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id, activation: { onStartup: true }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: id, type: 'module', openclaw: { extensions: ['./index.js'] } }));
  fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: ${JSON.stringify(id)}, register(api) {
    for (const operation of ['run', 'describe', 'cancel']) api.registerGatewayMethod(${JSON.stringify(id)} + '.' + operation, async ({ params, respond }) => {
      try {
        if (operation === 'run') {
          const created = await api.runtime.gateway.request('sessions.create', { key: params.key, agentId: 'main', cwd: ${JSON.stringify(project)}, permissionMode: 'full', displayName: 'Execution probe' }, { scopes: ['operator.admin'] });
          const result = await api.runtime.subagent.run({ sessionKey: created.key, message: params.message, disableTools: !['fixture background', 'fixture long'].includes(params.message), timeoutSeconds: params.timeoutSeconds ?? 120, managedToolsLifetime: 'run', idempotencyKey: params.id });
          respond(true, result);
        } else respond(true, await api.runtime.subagent[operation === 'describe' ? 'describeRun' : 'cancelRun']({ runId: params.runId }));
      } catch (error) { respond(false, undefined, { code: 'UNAVAILABLE', message: String(error) }); }
    }, { scope: 'operator.admin' });
  } };`);
}
let modelCalls = 0;
const pendingResponses = new Set();
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    modelCalls++;
    const input = JSON.parse(body || '{}');
    fs.writeFileSync(path.join(base, 'provider-input-' + modelCalls + '.json'), JSON.stringify(input, null, 2));
    const content = JSON.stringify(input.messages || []);
    if (content.includes('fixture hold')) {
      pendingResponses.add(res);
      res.on('close', () => pendingResponses.delete(res));
      return;
    }
    const long = content.includes('fixture long');
    const toolMessages = (input.messages || []).filter(m => m.role === 'tool');
    const background = (content.includes('fixture background') || long) && !toolMessages.length;
    if (content.includes('fixture background') && !background) {
      for (let i = 0; i < 50 && !fs.existsSync(path.join(project, 'owned-probe.pid')); i++) await delay(100);
    }
    let tool = { id: 'exec-background', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ command: long
      ? 'node -e "require(\'fs\').writeFileSync(\'long-start.pid\',String(process.pid));setTimeout(()=>require(\'fs\').writeFileSync(\'long-done.txt\',String(Date.now())),3700000)"'
      : 'node -e "require(\'fs\').writeFileSync(\'owned-probe.pid\',String(process.pid));setInterval(()=>{},1000)"', workdir: project, background: true, timeoutSeconds: long ? 4000 : 120 }) } };
    let callsTool = background;
    if (long && !background && !fs.existsSync(path.join(project, 'long-done.txt'))) {
      const session = JSON.stringify(toolMessages).match(/session ([a-zA-Z0-9_-]+), pid/);
      if (!session) throw new Error('Missing owned long-process identity.');
      await delay(25000);
      tool = { id: 'poll-' + modelCalls, type: 'function', function: { name: 'process', arguments: JSON.stringify({ action: 'poll', sessionId: session[1], timeout: 30000 }) } };
      callsTool = true;
    }
    const message = callsTool ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: 'Probe complete.' };
    const finish = callsTool ? 'tool_calls' : 'stop';
    if (input.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'probe-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: callsTool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : message, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'probe-' + modelCalls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'probe-' + modelCalls, object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let socket;
let log = '';
const config = {
  logging: { file: path.join(base, 'native-gateway.log'), level: 'debug', consoleLevel: 'info' },
  gateway: { mode: 'local', port: 43241, bind: 'loopback', auth: { mode: 'token', token: 'isolated-owned-execution-probe' } },
  agents: { defaults: { workspace: project, skipBootstrap: true, timeoutSeconds: longProbe ? 7200 : 120, model: { primary: 'fixture/fixture' } } },
  tools: { exec: { host: 'gateway', security: 'full', ask: 'off' } },
  models: { mode: 'replace', providers: { fixture: { baseUrl: 'http://127.0.0.1:43242/v1', apiKey: 'fixture-only', api: 'openai-completions', agentRuntime: { id: 'openclaw' }, request: { allowPrivateNetwork: true }, models: [{ id: 'fixture', name: 'fixture', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  plugins: { allow: ['owned-probe', 'other-probe'], entries: { 'owned-probe': { enabled: true }, 'other-probe': { enabled: true } } },
};
fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify(config));
const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(base, 'state'), OPENCLAW_CONFIG_PATH: path.join(base, 'config.json'), OPENCLAW_BUNDLED_PLUGINS_DIR: plugins, OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1', VITEST: 'true', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1' };
function launch() {
  const launcher = process.env.JUSTDO_EXECUTION_BUNDLE === '1' ? [path.join(runtime, 'gateway-launcher.cjs')] : [path.join(runtime, 'openclaw.mjs'), '--openclaw-node-host-child'];
  child = spawn(process.execPath, [...launcher, 'gateway', 'run', '--allow-unconfigured', '--port', '43241', '--bind', 'loopback'], { env, cwd: base, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
}
async function connect(attempt = 0) {
  await delay(attempt ? 500 : 12000);
  let challenge;
  for (let i = 0; i < 60; i++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://127.0.0.1:43241');
        challenge = new Promise((ready, failed) => {
          const timer = setTimeout(() => failed(new Error('Gateway challenge timed out.')), 20000);
          ws.once('message', raw => { clearTimeout(timer); const event = JSON.parse(raw); event.event === 'connect.challenge' ? ready(event) : failed(new Error('Missing native challenge.')); });
          ws.once('error', error => { clearTimeout(timer); failed(error); });
        });
        challenge.catch(() => {});
        ws.once('open', () => resolve(ws)); ws.once('error', reject);
      });
      break;
    } catch { if (child.exitCode !== null) throw new Error('Isolated Gateway exited: ' + child.exitCode); await delay(1000); }
  }
  if (!socket) throw new Error('Isolated Gateway startup timed out.');
  await challenge;
  let sequence = 0;
  const pending = new Map();
  socket.on('close', (code, reason) => {
    for (const value of pending.values()) value.reject(Object.assign(new Error('Gateway socket closed: ' + code + ' ' + String(reason)), { startupPending: code === 1013 }));
    pending.clear();
  });
  socket.on('message', raw => {
    const event = JSON.parse(raw);
    if (event.type !== 'res') return;
    const request = pending.get(event.id);
    if (request) { pending.delete(event.id); event.ok ? request.resolve(event.payload) : request.reject(Object.assign(new Error(JSON.stringify(event.error)), { startupPending: event.error?.retryable === true && event.error?.details?.reason === 'startup-sidecars' })); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timed out: ' + method)); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  const rpc = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try { return await request(method, params); }
      catch (error) { if (method === 'connect' || !error.startupPending || attempt >= 20) throw error; await delay(500); }
    }
  };
  try {
    await rpc('connect', { minProtocol: 4, maxProtocol: 4, client: { id: 'cli', version: 'probe', platform: 'win32', mode: 'cli' }, role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'], auth: { token: 'isolated-owned-execution-probe' } });
  } catch (error) {
    if (!error.startupPending || attempt >= 20) throw error;
    socket.close(); return connect(attempt + 1);
  }
  return rpc;
}
async function until(rpc, runId, predicate) {
  for (let i = 0; i < 40; i++) { const state = await rpc('owned-probe.describe', { runId }); if (predicate(state)) return state; await delay(500); }
  throw new Error('Exact execution evidence did not converge: ' + runId);
}
async function stop() {
  socket?.close(); socket = undefined;
  if (child && child.exitCode === null) {
    const ownedChild = child;
    await new Promise(resolve => {
      ownedChild.once('exit', resolve);
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(ownedChild.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else ownedChild.kill();
    });
  }
}
(async () => {
  try {
    await new Promise(resolve => provider.listen(43242, '127.0.0.1', resolve));
    launch();
    let rpc = await connect();
    const run = async (name, message, timeoutSeconds) => rpc('owned-probe.run', { key: 'agent:main:subagent:owned-probe-' + name, message, timeoutSeconds, id: 'owned-probe-' + name });
    const first = await run('plain', 'fixture normal');
    const complete = await until(rpc, first.runId, s => s.state === 'settled');
    assert.equal(complete.executionSettled, true); assert.equal(complete.cleanupSettled, true);
    await assert.rejects(rpc('other-probe.describe', { runId: first.runId }), /does not own/);
    console.log('PASS durable tool-free settlement and cross-plugin ownership');
    const background = await run('background', 'fixture background');
    const backgroundState = await until(rpc, background.runId, s => s.state === 'settled');
    if (!fs.existsSync(path.join(project, 'owned-probe.pid'))) {
      fs.writeFileSync(path.join(base, 'background-history.json'), JSON.stringify(await rpc('chat.history', { sessionKey: background.sessionKey ?? 'agent:main:subagent:owned-probe-background', limit: 10 }), null, 2));
      throw new Error('Background command did not start: ' + JSON.stringify(backgroundState));
    }
    const pid = Number(fs.readFileSync(path.join(project, 'owned-probe.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0));
    console.log('PASS background process extinction before cleanup settlement');
    const held = await run('cancel', 'fixture hold cancel');
    await until(rpc, held.runId, s => s.state === 'running');
    assert.equal((await rpc('owned-probe.cancel', { runId: held.runId })).accepted, true);
    const cancelled = await until(rpc, held.runId, s => s.state === 'settled');
    assert.equal(cancelled.cancelled, true);
    console.log('PASS exact cancellation convergence');
    const interrupted = await run('restart', 'fixture hold restart');
    await until(rpc, interrupted.runId, s => s.state === 'running');
    await stop();
    for (const response of pendingResponses) response.destroy();
    launch(); rpc = await connect();
    assert.equal((await rpc('owned-probe.describe', { runId: first.runId })).state, 'settled');
    assert.equal((await rpc('owned-probe.describe', { runId: interrupted.runId })).state, 'unknown');
    await assert.rejects(rpc('owned-probe.cancel', { runId: interrupted.runId }), /uncertain/);
    console.log('PASS durable evidence and unknown interrupted execution after restart');
    if (longProbe) {
      const started = Date.now();
      const long = await rpc('owned-probe.run', { key: 'agent:main:subagent:owned-probe-long', id: 'owned-probe-long', message: 'fixture long', timeoutSeconds: 7200 });
      let observed;
      for (let i = 0; i < 440; i++) {
        observed = await rpc('owned-probe.describe', { runId: long.runId });
        if (observed.state === 'settled') break;
        if (i % 30 === 0) console.log('LONG running ' + Math.round((Date.now() - started) / 1000) + 's');
        await delay(10000);
      }
      assert.equal(observed.state, 'settled');
      assert.equal(observed.outcome, 'ok');
      assert.equal(observed.cleanupSettled, true);
      assert.ok(Date.now() - started > 3600000);
      assert.ok(fs.existsSync(path.join(project, 'long-done.txt')));
      fs.writeFileSync(path.join(base, 'long-result.json'), JSON.stringify({ elapsedMs: Date.now() - started, observed }, null, 2));
      console.log('PASS real >1-hour native execution and cleanup');
    }
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ complete, cancelled, modelCalls, passed: true }, null, 2));
  } catch (error) { console.error(String(error)); console.error(log.slice(-7000)); if (fs.existsSync(path.join(base, 'native-gateway.log'))) console.error(fs.readFileSync(path.join(base, 'native-gateway.log'), 'utf8').slice(-8000)); process.exitCode = 1; }
  finally { await stop(); for (const response of pendingResponses) response.destroy(); provider.close(); fs.writeFileSync(path.join(base, 'gateway.log'), log); console.log('FIXTURE ' + base); }
})().catch(error => { console.error(error); process.exitCode = 1; });
