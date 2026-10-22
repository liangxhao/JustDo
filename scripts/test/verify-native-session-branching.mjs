// Opt-in, model-free storage/Gateway proof against the prepared runtime. Synthetic state only.
// Usage: node scripts/test/verify-native-session-branching.mjs [runtime-directory]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = path.resolve(process.argv[2] ?? path.join(root, 'vendor/openclaw-runtime/current'));
const artifacts = path.join(root, '.agent-tasks/runtime/session-branching');
await fs.mkdir(artifacts, { recursive: true });
const state = await fs.mkdtemp(path.join(artifacts, 'probe-'));
for (const name of Object.keys(process.env)) {
  if (name.toUpperCase().startsWith('OPENCLAW_')) delete process.env[name];
}
Object.assign(process.env, {
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
  OPENCLAW_NO_RESPAWN: '1',
});
await fs.writeFile(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    agents: { ownership: 'explicit', entries: { main: {} } },
    plugins: { enabled: false, allow: [], entries: {} },
    update: { checkOnStart: false, auto: { enabled: false } },
  }),
);
const dist = path.join(runtime, 'dist');
const files = (await fs.readdir(dist)).filter(file => file.endsWith('.mjs'));
async function native(prefix, symbol) {
  const matches = [];
  for (const file of files.filter(name => name.startsWith(prefix))) {
    const source = await fs.readFile(path.join(dist, file), 'utf8');
    if (!source.includes(`function ${symbol}(`)) continue;
    const exports = source.slice(source.lastIndexOf('\nexport {'));
    const alias = exports.match(new RegExp(`\\b${symbol}(?: as (\\w+))?\\s*[,}]`));
    if (alias) matches.push({ file, alias: alias[1] ?? symbol });
  }
  assert.equal(matches.length, 1, `one pinned native export: ${symbol}`);
  return (await import(pathToFileURL(path.join(dist, matches[0].file)).href))[matches[0].alias];
}
const checks = [];
async function verifyGateway(scope) {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = randomBytes(24).toString('hex');
  const config = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
  Object.assign(config, {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    models: {
      catalogRefresh: { enabled: false },
      providers: {
        fixture: {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          apiKey: 'synthetic',
          models: [
            { id: 'offline', name: 'Offline fixture', contextWindow: 32768, maxTokens: 128 },
          ],
        },
      },
    },
  });
  config.agents.defaults = { workspace: state, model: { primary: 'fixture/offline' } };
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const require = createRequire(import.meta.url);
  const { buildSync } = require('esbuild');
  const compiled = path.join(state, 'branching-reader.cjs');
  const lifecycle = path.join(state, 'host-lifecycle.cjs');
  for (const [input, output] of [
    ['src/main/ipc/cowork/sessionBranching.ts', compiled],
    ['src/main/openclaw/runtime/launch/openclawLauncher.ts', lifecycle],
  ])
    buildSync({
      entryPoints: [path.join(root, input)],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
  const { readSessionBranchRunIds } = require(compiled);
  const { ensureGatewayShutdownPreload, OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } = require(lifecycle);
  const { GATEWAY_READY_MESSAGE } = require(
    path.join(root, 'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'),
  );
  const { GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js'))
  );
  const child = spawn(
    process.execPath,
    [
      '--require',
      ensureGatewayShutdownPreload(state),
      path.join(runtime, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
    ],
    { cwd: state, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let output = '';
  let client;
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', data => {
      output += data;
    });
  try {
    const deadline = Date.now() + 180000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Isolated Gateway exited: ${child.exitCode}`);
      try {
        ready = (
          await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, 'isolated Gateway ready');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Isolated Gateway handshake timed out')),
        60000,
      );
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        scopes: ['operator.admin'],
        requestTimeoutMs: 90000,
        onHelloOk: () => {
          clearTimeout(timer);
          resolve();
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.start();
    });
    child.send(GATEWAY_READY_MESSAGE);
    const rpc = (method, params) => client.request(method, params);
    const copied = await rpc('sessions.create', {
      key: 'agent:main:justdo:gateway-copy',
      parentSessionKey: scope.sessionKey,
      fork: true,
      cwd: state,
      permissionMode: 'guarded',
    });
    assert.deepEqual(
      await readSessionBranchRunIds(rpc, copied.key, copied.sessionId),
      new Set(['run-1', 'run-2']),
    );
    checks.push(
      'real Gateway copy and stable history cursor preserve exact native timing membership',
    );
    const branch = await rpc('sessions.fork', {
      sessionKey: scope.sessionKey,
      entryId: 'answer-1',
      includeEntry: true,
      targetKey: 'agent:main:justdo:gateway-branch',
    });
    const described = await rpc('sessions.describe', { key: branch.sessionKey });
    assert.deepEqual(
      await readSessionBranchRunIds(
        rpc,
        branch.sessionKey,
        described.session.sessionId,
        'answer-1',
      ),
      new Set(['run-1']),
    );
    await assert.rejects(
      rpc('sessions.fork', {
        sessionKey: scope.sessionKey,
        entryId: 'answer-2',
        includeEntry: true,
        targetKey: branch.sessionKey,
      }),
      /already exists/,
    );
    assert.equal(
      (await rpc('sessions.describe', { key: branch.sessionKey })).session.sessionId,
      described.session.sessionId,
    );
    checks.push(
      'real Gateway assistant cut excludes later runs and rejects target collisions without replacement',
    );
  } finally {
    await client?.stop();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.send(OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
      const timer = setTimeout(() => child.kill(), 90000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    await fs.writeFile(
      path.join(state, 'gateway.log'),
      output.replaceAll(token, '<fixture-token>'),
    );
    assert.equal(child.exitCode, 0, 'clean isolated Gateway shutdown');
  }
}
try {
  const upsert = await native('session-accessor.sqlite-entry-', 'upsertSessionEntryCore');
  const append = await native('session-accessor.sqlite-transcript-write-', 'appendTranscriptEvent');
  const appendMessage = await native(
    'session-accessor.sqlite-transcript-write-',
    'appendTranscriptMessage',
  );
  const load = await native('session-accessor-', 'loadTranscriptEvents');
  const fork = await native('session-accessor-', 'forkSessionAtMessage');
  const copy = await native('session-fork-', 'prepareSessionForkFromParent');
  const scope = {
    agentId: 'main',
    sessionKey: 'agent:main:fixture:source',
    sessionId: 'physical-source',
  };
  const parentEntry = {
    sessionId: scope.sessionId,
    lifecycleRevision: 'source-generation',
    updatedAt: Date.now(),
    permissionMode: 'guarded',
    sessionRoot: state,
  };
  await upsert(scope, parentEntry);
  const events = [
    { type: 'session', id: scope.sessionId, version: 3, cwd: state },
    { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'first' } },
    {
      type: 'message',
      id: 'tool-call',
      parentId: 'user-1',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'call-1', name: 'exec', arguments: {} }],
      },
    },
    {
      type: 'custom',
      id: 'store-1',
      parentId: 'tool-call',
      customType: 'openclaw.code-mode-store',
      data: {
        set: { report: { count: 1, text: '中文' } },
        delete: [],
        networkContent: { report: false },
      },
    },
    {
      type: 'message',
      id: 'tool-result',
      parentId: 'store-1',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: 'saved' }],
      },
    },
    {
      type: 'message',
      id: 'answer-1',
      parentId: 'tool-result',
      message: { role: 'assistant', content: 'first answer', stopReason: 'stop' },
    },
    {
      type: 'message',
      id: 'user-2',
      parentId: 'answer-1',
      message: { role: 'user', content: 'second' },
    },
    {
      type: 'custom',
      id: 'store-2',
      parentId: 'user-2',
      customType: 'openclaw.code-mode-store',
      data: { set: { report: { count: 2 } }, delete: [], networkContent: { report: false } },
    },
    {
      type: 'message',
      id: 'answer-2',
      parentId: 'store-2',
      message: { role: 'assistant', content: 'second answer', stopReason: 'stop' },
    },
  ].map((event, index) => ({
    timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    ...event,
  }));
  for (const event of events) {
    if (event.type === 'message') {
      await appendMessage(scope, {
        eventId: event.id,
        parentId: event.parentId,
        now: Date.parse(event.timestamp),
        message: { ...event.message, runId: event.id.endsWith('-2') ? 'run-2' : 'run-1' },
      });
    } else {
      await append(scope, event);
    }
  }
  const before = await load(scope);
  const copied = await copy({
    agentId: scope.agentId,
    parentEntry,
    parentSessionKey: scope.sessionKey,
    sessionKey: 'agent:main:justdo:copy-probe',
  });
  assert.equal(copied.status, 'prepared');
  assert.deepEqual(
    copied.events.filter(event => event.type !== 'session').map(event => event.id),
    events.slice(1).map(event => event.id),
  );
  assert.deepEqual(copied.events.find(event => event.id === 'store-2').data.set.report, {
    count: 2,
  });
  checks.push('whole copy preserves current branch, tool pairs and latest Code Mode store');

  for (const [entryId, expectedIds] of [
    ['answer-1', events.slice(1, 6).map(event => event.id)],
    ['answer-2', events.slice(1).map(event => event.id)],
  ]) {
    const targetKey = `agent:main:justdo:branch-${entryId}`;
    const result = await fork({ ...scope, entryId, targetKey, includeEntry: true }, parentEntry);
    assert.equal(result.status, 'created');
    assert.equal(result.key, targetKey);
    assert.notEqual(result.entry.sessionId, scope.sessionId);
    assert.equal(result.editorText, undefined);
    assert.equal(result.editorAttachments, undefined);
    const inherited = await load({
      ...scope,
      sessionKey: targetKey,
      sessionId: result.entry.sessionId,
    });
    assert.deepEqual(
      inherited.filter(event => event.type !== 'session').map(event => event.id),
      expectedIds,
    );
    assert.equal(inherited.at(-1).id, entryId);
    assert.deepEqual(inherited.find(event => event.id === 'store-1').data.set.report, {
      count: 1,
      text: '中文',
    });
    checks.push(`${entryId} is included exactly; subsequent turns and store writes are excluded`);
  }
  const rejected = await fork(
    { ...scope, entryId: 'tool-call', targetKey: 'agent:main:justdo:invalid', includeEntry: true },
    parentEntry,
  );
  assert.equal(rejected.status, 'not-user-message');
  assert.deepEqual(await load(scope), before);
  checks.push('unfinished tool-use cut rejected and source remains unchanged');
  await (
    await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabasesAsync')
  )();
  await (
    await native('openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync')
  )();
  await verifyGateway(scope);
  const evidence = {
    version: JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8')).version,
    node: process.versions.node,
    gatewayBundleSha256: createHash('sha256')
      .update(await fs.readFile(path.join(runtime, 'gateway-bundle.mjs')))
      .digest('hex'),
    checks,
  };
  await fs.writeFile(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: checks.length, evidence: path.join(state, 'result.json') }));
} finally {
  await (
    await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabasesAsync')
  )();
  await (
    await native('openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync')
  )();
}
