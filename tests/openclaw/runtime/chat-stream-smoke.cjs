// Offline integration: real Gateway/worker execution against a loopback-only model fixture.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
(async () => {
  const root = path.resolve(process.argv[2] || 'vendor/openclaw-runtime/current');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-chat-stream-smoke-'));
  const workspace = path.join(state, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'read-fixture.txt'), 'native-tool-read-evidence');
  const token = randomBytes(24).toString('hex');
  const events = []; let requests = 0; let toolRequested = false; let toolResultSeen = false;
  const provider = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests++;
    const toolResult = parsed.messages?.find(message => message.role === 'tool');
    toolResultSeen ||= Boolean(toolResult && JSON.stringify(toolResult).includes('native-tool-read-evidence'));
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = delta => response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'review-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    send({ role: 'assistant' });
    const tools = parsed.tools?.map(tool => tool.function?.name) || [];
    if (!toolResult && tools.length) {
      if (!tools.includes('read')) throw new Error('Native read missing from model tools: ' + tools.join(','));
      toolRequested = true;
      send({ reasoning_content: 'Inspecting the isolated fixture before answering.' });
      await new Promise(resolve => setTimeout(resolve, 100));
      send({ content: 'Reading the fixture now.' });
      send({ tool_calls: [{ index: 0, id: 'fixture-read-call', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(workspace, 'read-fixture.txt') }) } }] });
      response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else {
      send({ reasoning_content: 'The file was checked.' });
      send({ content: 'Fixture verified: native-tool-read-evidence.' });
      response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const modelPort = provider.address().port;
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    models: { catalogRefresh: { enabled: false }, mode: 'replace', providers: { fixture: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'isolated-fixture-key', models: [{ id: 'review-model', name: 'Fixture', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 1024 }] } } },
    agents: { entries: { main: {} }, defaults: { workspace, model: { primary: 'fixture/review-model' }, thinkingDefault: 'high', verboseDefault: 'full', systemAgent: { agentId: 'main' } } },
    tools: { codeMode: { enabled: false } },
    plugins: { allow: ['memory-core'], entries: { 'memory-core': { enabled: true } } },
  };
  fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify(config));
  const env = { ...process.env, OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'), OPENCLAW_NO_RESPAWN: '1' };
  Object.assign(process.env, { OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json') });
  let output = ''; let client;
  const child = spawn(process.execPath, [path.join(root, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port)], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const waitFor = async (predicate, label, timeout = 60000) => { const deadline = Date.now() + timeout; while (!predicate()) { if (child.exitCode !== null) throw new Error('Gateway exited: '+child.exitCode); if (Date.now() > deadline) throw new Error(label+' timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } };
  const deadline = setTimeout(() => child.kill(), 150000);
  try {
    const file = fs.readdirSync(path.join(root, 'dist')).find(name => /^client-.*\.mjs$/.test(name) && fs.readFileSync(path.join(root, 'dist', name), 'utf8').includes('GatewayClient as t'));
    const { t: GatewayClient } = await import(pathToFileURL(path.join(root, 'dist', file)).href);
    let connected = false;
    client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, clientName: 'gateway-client', mode: 'backend', caps: ['tool-events'], scopes: ['operator.admin'], onHelloOk: () => connected = true, onEvent: event => events.push(event) });
    client.start(); await waitFor(() => connected, 'connect');
    const key = 'agent:main:justdo:stream-smoke';
    await client.request('sessions.create', { key, cwd: workspace, permissionMode: 'guarded' });
    await client.request('sessions.messages.subscribe', { key });
    const runId = 'fixture-run-' + randomBytes(6).toString('hex');
    await client.request('chat.send', { sessionKey: key, message: 'Read read-fixture.txt and confirm its exact contents.', idempotencyKey: runId });
    await waitFor(() => events.some(event => event.event === 'chat' && event.payload?.runId === runId && ['final','error','aborted'].includes(event.payload.state)), 'terminal');
    const terminal = events.find(event => event.event === 'chat' && event.payload?.runId === runId && ['final', 'error', 'aborted'].includes(event.payload.state));
    assert.equal(terminal.payload.state, 'final', JSON.stringify(terminal.payload));
    const streams = new Set(events.filter(event => event.event === 'agent' && event.payload?.runId === runId).map(event => event.payload.stream));
    assert.ok(toolRequested && toolResultSeen, 'native read must execute and return fixture bytes');
    assert.ok(streams.has('thinking'), 'live Thinking'); assert.ok(streams.has('tool') || events.some(event => event.event === 'session.tool' && event.payload?.runId === runId), 'live Tool'); assert.ok(streams.has('assistant'), 'live Content');
    const history = await client.request('chat.history', { sessionKey: key, limit: 50 });
    assert.ok(JSON.stringify(history.messages).includes('native-tool-read-evidence'), 'persisted history');
    console.log(JSON.stringify({ ok: true, requests, streams: [...streams], nativeRead: toolResultSeen, liveSessionTool: events.some(event => event.event === 'session.tool' && event.payload?.runId === runId), historyMessages: history.messages.length, state }));
  } finally {
    clearTimeout(deadline); if(client) await client.stopAndWait().catch(() => client.stop()); child.kill(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<fixture-token>')); console.log('Smoke log: '+path.join(state, 'smoke.log'));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
