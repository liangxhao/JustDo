// Isolated, model-free packaged-runtime proof. Never points at application state.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

(async () => {
  const root = path.resolve(process.argv[2] || 'vendor/openclaw-runtime/current');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-storage-smoke-'));
  const workspace = path.join(state, 'workspace');
  fs.mkdirSync(workspace);
  const token = randomBytes(24).toString('hex');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const configPath = path.join(state, 'openclaw.json');
  const model = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const content = 'Local mock continuation after restored history.';
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'smoke',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      entries: { main: {}, peer: {} },
      defaults: {
        workspace,
        model: { primary: 'smoke/fixture' },
        systemAgent: { agentId: 'main' },
      },
    },
    models: {
      catalogRefresh: { enabled: false },
      providers: {
        smoke: {
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'isolated-test',
          models: [{ id: 'fixture', name: 'Local fixture', contextWindow: 32768, maxTokens: 128 }],
        },
      },
    },
    session: { maintenance: { mode: 'warn', coldStorage: { enabled: false, afterDays: 30 } } },
    plugins: { allow: [], entries: {} },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = {
    ...process.env,
    OPENCLAW_HOME: state,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: '1',
  };
  Object.assign(process.env, env);
  const file = fs
    .readdirSync(path.join(root, 'dist'))
    .find(
      f =>
        /^client-.*\.mjs$/.test(f) &&
        fs.readFileSync(path.join(root, 'dist', f), 'utf8').includes('GatewayClient as t'),
    );
  const { t: GatewayClient } = await import(pathToFileURL(path.join(root, 'dist', file)).href);
  let child,
    client,
    output = '';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function stop() {
    if (client) {
      await client.stopAndWait().catch(() => client.stop());
      client = null;
    }
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.send('stop');
      const fallback = setTimeout(() => child.kill(), 30000);
      await exited;
      clearTimeout(fallback);
    }
  }
  async function start() {
    child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('message', m => { if (m === 'stop') process.emit('SIGTERM'); }); const entry = process.argv[1]; process.argv = [process.execPath, ...process.argv.slice(1)]; import(require('node:url').pathToFileURL(entry).href);",
        path.join(
          root,
          process.argv.includes('--unbundled') ? 'openclaw.mjs' : 'gateway-launcher.cjs',
        ),
        'gateway',
        'run',
        '--allow-unconfigured',
        '--port',
        String(port),
      ],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    child.stdout.on('data', b => {
      output += b;
    });
    child.stderr.on('data', b => {
      output += b;
    });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Gateway exited ' + child.exitCode);
      try {
        if (
          (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(800) })).ok
        )
          break;
      } catch {}
      await sleep(500);
    }
    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Handshake timeout')), 20000);
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        scopes: ['operator.admin'],
        onHelloOk: data => {
          clearTimeout(timer);
          resolve(data);
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.start();
    });
    for (const method of [
      'sessions.storage.status',
      'sessions.storage.run',
      'chat.startup',
      'chat.history',
    ])
      assert.ok(hello.features.methods.includes(method), method);
  }
  const keys = [
    'agent:main:justdo:old',
    'agent:main:justdo:recent',
    'agent:main:justdo:busy',
    'agent:peer:justdo:old',
  ];
  async function requestRunWhenReady() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.request('sessions.storage.run', {});
      } catch (error) {
        // Only the explicit pre-admission startup refusal is retryable here.
        if (attempt >= 60 || !/maintenance is not running/i.test(error.message)) throw error;
        await sleep(500);
      }
    }
  }
  try {
    await start();
    console.log('storage smoke: initial runtime connected');
    const initial = await client.request('sessions.storage.status', {});
    await assert.rejects(requestRunWhenReady(), /disabled/i);
    for (const key of keys) {
      await client.request('sessions.create', { key, cwd: workspace, permissionMode: 'read-only' });
      await client.request('chat.inject', {
        sessionKey: key,
        message: `storage smoke ${key} attachment reference ./fixture.txt`,
      });
    }
    fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'isolated attachment fixture');
    console.log('storage smoke: reading hot history before archiving');
    const hot = await client.request('chat.history', { sessionKey: keys[0], limit: 100 });
    assert.ok(JSON.stringify(hot.messages).includes('storage smoke'));
    console.log('storage smoke: hot history passed');
    const before = await client.request('sessions.storage.status', {});
    await stop();
    // Fixture-only aging while Gateway is stopped; production never edits native tables.
    const old = Date.now() - 60 * 86400000;
    for (const agent of before.agents) {
      const resolved = path.resolve(agent.storePath);
      assert.ok(resolved.startsWith(path.resolve(state) + path.sep));
      if (!fs.existsSync(resolved)) continue;
      const db = new DatabaseSync(resolved);
      try {
        db.prepare(
          "UPDATE session_nodes SET entry_json=json_set(entry_json, '$.updatedAt', ?), updated_at=?, last_activity_at=?, last_interaction_at=? WHERE session_key LIKE '%:old'",
        ).run(old, old, old, old);
        // Native identity validation requires the projected timestamp and JSON to agree.
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS count FROM session_nodes WHERE updated_at != json_extract(entry_json, '$.updatedAt')",
            )
            .get().count,
          0,
        );
        db.prepare(
          "UPDATE session_windows SET updated_at=?, transcript_updated_at=? WHERE session_key LIKE '%:old'",
        ).run(old, old);
      } finally {
        db.close();
      }
    }
    await start();
    // Check the aged fixture while still hot, then exercise the actual revision-bound save.
    const aged = await client.request('chat.startup', { sessionKey: keys[0], limit: 100 });
    assert.ok(JSON.stringify(aged.messages).includes(`storage smoke ${keys[0]}`));
    const snapshot = await client.request('config.get', {});
    await client.request('config.patch', {
      baseHash: snapshot.hash,
      raw: JSON.stringify({
        session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } },
      }),
    });
    const effective = await client.request('config.get', {});
    assert.equal(effective.config.session.maintenance.coldStorage.enabled, true);
    assert.equal(effective.valid, true);
    assert.ok(effective.configRevisionHash, 'native resolved revision is available');
    assert.equal(
      effective.configRevisionHash,
      effective.appliedConfigHash,
      'saved policy is applied',
    );
    await requestRunWhenReady();
    let archived;
    for (let i = 0; i < 120; i++) {
      archived = await client.request('sessions.storage.status', {});
      if (
        !archived.maintenance.running &&
        archived.agents.reduce((n, a) => n + a.coldTranscripts, 0) >= 2
      )
        break;
      await sleep(500);
    }
    console.log('storage smoke: archive pass settled');
    assert.equal(archived.maintenance.lastError, null);
    assert.ok(
      archived.agents.reduce((n, a) => n + a.coldTranscripts, 0) >= 2,
      'old transcripts archived',
    );
    await stop();
    const disabled = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    disabled.session.maintenance.coldStorage.enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(disabled));
    const testCorruption = !process.argv.includes('--skip-corruption');
    if (testCorruption) {
      const coldFiles = fs
        .readdirSync(state, { recursive: true })
        .filter(name => name.endsWith('.jsonl.zst'))
        .map(name => path.join(state, name));
      assert.ok(coldFiles.length >= 2, 'external archives exist');
      const originalArchives = coldFiles.map(file => [file, fs.readFileSync(file)]);
      for (const [file] of originalArchives) fs.writeFileSync(file, 'corrupt isolated fixture');
      await start();
      console.log('storage smoke: restarted with archive policy disabled');
      await assert.rejects(
        client.request('chat.startup', { sessionKey: keys[0], limit: 100 }),
        /archive|checksum|hash|cold|decompress|corrupt/i,
      );
      await assert.rejects(
        client.request('chat.history', { sessionKey: keys[3], limit: 100 }),
        /archive|checksum|hash|cold|decompress|corrupt/i,
      );
      console.log('storage smoke: corruption rejected');
      await stop();
      for (const [file, data] of originalArchives) fs.writeFileSync(file, data);
      await start();
    } else {
      await start();
    }
    for (const [key, method] of [
      [keys[0], 'chat.startup'],
      [keys[3], 'chat.history'],
    ]) {
      console.log('storage smoke: restoring ' + method);
      const history = await client.request(method, { sessionKey: key, limit: 100 });
      assert.ok(
        JSON.stringify(history.messages).includes(`storage smoke ${key}`),
        method + ' restores history',
      );
      assert.ok(JSON.stringify(history.messages).includes('./fixture.txt'));
    }
    const restored = await client.request('sessions.storage.status', {});
    assert.equal(
      restored.agents.reduce((n, a) => n + a.coldTranscripts, 0),
      0,
    );
    console.log('storage smoke: both histories restored, sending continuation');
    await client.request('chat.send', {
      sessionKey: keys[0],
      message: 'Continue this restored conversation.',
      idempotencyKey: randomBytes(16).toString('hex'),
    });
    let continued = false;
    for (let i = 0; i < 90; i++) {
      const history = await client.request('chat.history', { sessionKey: keys[0], limit: 100 });
      if (
        JSON.stringify(history.messages).includes('Local mock continuation after restored history.')
      ) {
        continued = true;
        break;
      }
      await sleep(500);
    }
    assert.ok(continued, 'restored session accepts and persists a mock model continuation');
    console.log(
      JSON.stringify({
        ok: true,
        state,
        initialAgents: initial.agents.length,
        archived: archived.agents.map(({ agentId, coldTranscripts }) => ({
          agentId,
          coldTranscripts,
        })),
        restored: true,
        corruptArchivesRejected: testCorruption,
        modelContinuation: 'local mock passed',
      }),
    );
  } finally {
    await stop();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<test-token>'));
    console.log('Isolated smoke state: ' + state);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
