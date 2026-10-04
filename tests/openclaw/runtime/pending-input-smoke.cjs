// Offline native pending-input protocol: loopback SSE, paging, reconnect, Stop and canonical consumption.
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
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-pending-input-smoke-'));
  const workspace = path.join(state, 'workspace'); fs.mkdirSync(workspace);
  const token = randomBytes(24).toString('hex');
  const events = []; let requests = 0; const held = []; let hold = true;
  const provider = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    JSON.parse(body); requests++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = delta => response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'review-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    send({ role: 'assistant', content: 'Synthetic local response. ' });
    const finish = () => {
      if (response.destroyed || response.writableEnded) return;
      send({ content: 'Complete.' });
      response.write('data: ' + JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    };
    if (hold) held.push(finish); else finish();
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
    messages: { queue: { mode: 'followup', cap: 40 } },
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
    const key = 'agent:main:justdo:pending-smoke';
    await client.request('sessions.create', { key, cwd: workspace, permissionMode: 'guarded' });
    await client.request('sessions.messages.subscribe', { key });
    const active = 'active-' + randomBytes(6).toString('hex');
    await client.request('chat.send', { sessionKey: key, message: 'Hold this synthetic response.', idempotencyKey: active });
    await waitFor(() => held.length === 1, 'model held');
    const runIds = [];
    for (let index = 0; index < 21; index++) {
      const runId = 'pending-' + index + '-' + randomBytes(4).toString('hex'); runIds.push(runId);
      await client.request('chat.send', { sessionKey: key, message: 'Queued synthetic input ' + index, queueMode: 'followup', idempotencyKey: runId });
    }
    const page = await client.request('chat.history', { sessionKey: key, limit: 20, inputRunIds: runIds });
    assert.equal(page.pendingInputs.total, 21);
    assert.equal(page.pendingInputs.items.length, 20);
    const observedQueuedCount = page.pendingInputs.queuedCount;
    assert.ok(page.pendingInputs.items.every(item => item.state === 'queued'));
    assert.ok(page.pendingInputs.nextBefore);
    assert.equal(page.inputReceipts.length, 21);
    assert.ok(page.inputReceipts.every(item => item.state === 'pending'));
    const older = await client.request('chat.history', { sessionKey: key, limit: 20, pendingBefore: page.pendingInputs.nextBefore });
    assert.equal(older.pendingInputs.items.length, 1);
    const ids = [...page.pendingInputs.items, ...older.pendingInputs.items].map(item => item.id);
    assert.equal(new Set(ids).size, 21);
    assert.deepEqual(new Set([...page.pendingInputs.items, ...older.pendingInputs.items].map(item => item.runId)), new Set(runIds));
    // A fresh transport must recover accepted inputs solely from native history.
    await client.stopAndWait(); connected = false;
    client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, clientName: 'gateway-client', mode: 'backend', scopes: ['operator.admin'], onHelloOk: () => connected = true, onEvent: event => events.push(event) });
    client.start(); await waitFor(() => connected, 'reconnect');
    const restored = await client.request('chat.history', { sessionKey: key, inputRunIds: runIds });
    assert.equal(restored.pendingInputs.total, 21);
    await client.request('sessions.abort', { key, clearQueued: true });
    const stopped = await client.request('chat.history', { sessionKey: key, inputRunIds: runIds });
    assert.equal(stopped.pendingInputs.queuedCount, 0);
    assert.equal(stopped.pendingInputs.total, 21);
    assert.equal(stopped.inputReceipts.length, 21);
    assert.ok(stopped.inputReceipts.every(item => item.state === 'pending' && item.cancelled === true));
    const consumeKey = 'agent:main:justdo:consume-smoke';
    await client.request('sessions.create', { key: consumeKey, cwd: workspace, permissionMode: 'guarded' });
    await client.request('sessions.messages.subscribe', { key: consumeKey });
    await client.request('chat.send', { sessionKey: consumeKey, message: 'Hold another response.', idempotencyKey: 'consume-active' });
    await waitFor(() => held.length >= 2, 'second model held');
    const consumedRun = 'consume-next';
    await client.request('chat.send', { sessionKey: consumeKey, message: 'Consume this exact queued input.', queueMode: 'followup', idempotencyKey: consumedRun });
    const before = await client.request('chat.history', { sessionKey: consumeKey, inputRunIds: [consumedRun] });
    assert.equal(before.inputReceipts[0].state, 'pending');
    hold = false; held[held.length - 1]();
    let consumed;
    const canonicalInput = message => message.role === 'user' &&
      (message.idempotencyKey === consumedRun + ':user' || message.__openclaw?.idempotencyKey === consumedRun + ':user');
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      consumed = await client.request('chat.history', { sessionKey: consumeKey, inputRunIds: [consumedRun], limit: 50 });
      if (consumed.messages.some(canonicalInput) && !consumed.pendingInputs.items.some(item => item.runId === consumedRun)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const canonical = consumed.messages.filter(canonicalInput);
    assert.equal(canonical.length, 1, 'Consumed input appears exactly once in native history');
    assert.equal(canonical[0].content, 'Consume this exact queued input.');
    assert.ok(canonical[0].__openclaw?.id, 'Native canonical message identity');
    assert.ok(!consumed.pendingInputs.items.some(item => item.runId === consumedRun));
    const receipt = consumed.inputReceipts.find(item => item.runId === consumedRun);
    if (receipt) {
      assert.equal(receipt.state, 'consumed');
      assert.equal(receipt.consumedByEventId, canonical[0].__openclaw.id);
      assert.ok(consumed.inputConsumptions.some(item => item.runId === consumedRun && item.consumedByEventId === receipt.consumedByEventId));
    }
    console.log(JSON.stringify({ ok: true, state, requests, accepted: 21, observedQueuedCount,
      pageSizes: [20, 1], reconnect: true, stopRetainedCancelled: stopped.pendingInputs.total,
      consumedReceiptState: receipt?.state ?? 'absent', inputConsumptions: consumed.inputConsumptions.length,
      canonicalDedup: true, canonicalIdentity: { id: canonical[0].__openclaw.id,
        idempotencyKey: canonical[0].__openclaw.idempotencyKey, rawSeq: canonical[0].__openclaw.transcriptPosition?.rawSeq } }));
  } finally {
    clearTimeout(deadline); if(client) await client.stopAndWait().catch(() => client.stop()); child.kill(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<fixture-token>')); console.log('Smoke log: '+path.join(state, 'smoke.log'));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
