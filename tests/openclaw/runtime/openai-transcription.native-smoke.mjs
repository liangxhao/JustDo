import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const { runtimeRoot } = resolveNativeSmokeTarget();
const requireRuntime = createRequire(path.join(runtimeRoot, 'package.json'));
const { WebSocketServer } = requireRuntime('ws');

async function until(predicate, description) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await delay(10);
  }
}

test('native OpenAI transcription uses isolated real transports and resets connection state', async () => {
  const previous = { ...process.env };
  fs.mkdirSync(path.resolve('.agent-tasks/runtime'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.agent-tasks/runtime/provider-transcription-'));
  const sessions = [];
  const servers = [];
  let inspection;
  let released = false;
  try {
    for (const key of Object.keys(process.env)) {
      const upper = key.toUpperCase();
      if (upper.startsWith('OPENCLAW_') || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE',
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].includes(upper)) delete process.env[key];
    }
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir);
    const config = {
      agents: { ownership: 'explicit', entries: { main: {} }, defaults: {
        workspace: workspaceDir, embeddedAgent: { cyberFailover: { mode: 'off' } },
      } },
      plugins: { allow: ['openai'], slots: { memory: 'none' }, entries: { openai: { enabled: true } } },
    };
    Object.assign(process.env, {
      OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: path.join(root, 'state'),
      OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeRoot, 'dist/extensions'),
      OPENAI_API_KEY: 'synthetic-unused-environment-key',
    });
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    const dist = path.join(runtimeRoot, 'dist');
    const owners = fs.readdirSync(dist).filter(name => /^loader-runtime-load-[A-Za-z0-9_-]+\.mjs$/.test(name));
    assert.equal(owners.length, 1);
    const loader = await import(pathToFileURL(path.join(dist, owners[0])).href);
    const acquire = Object.values(loader).filter(value =>
      typeof value === 'function' && value.name === 'acquirePluginRegistryForInspection');
    assert.equal(acquire.length, 1);
    inspection = await acquire[0]({ config, workspaceDir, env: process.env, onlyPluginIds: ['openai'],
      activate: false, runtimeSideEffects: false, cache: false, throwOnLoadError: true,
      preferBuiltPluginArtifacts: true });
    const registered = inspection.registry.realtimeTranscriptionProviders.filter(entry => entry.pluginId === 'openai');
    assert.equal(registered.length, 1);
    const provider = registered[0].provider;
    assert.equal(provider.id, 'openai');
    assert.equal(provider.isConfigured({ cfg: config, providerConfig: { apiKey: 'synthetic' } }), false);
    assert.throws(() => provider.createSession({ cfg: config, providerConfig: { apiKey: 'synthetic' } }), /service URL is required/);

    for (const label of ['first', 'second']) {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      const connections = [];
      server.on('connection', (socket, request) => {
        const connection = { socket, url: request.url, authorization: request.headers.authorization, messages: [] };
        connections.push(connection);
        socket.on('message', data => {
          const message = JSON.parse(data.toString());
          connection.messages.push(message);
          if (message.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
          if (message.type === 'input_audio_buffer.commit') {
            socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `${label}-final` }));
            socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed',
              item_id: `${label}-final`, transcript: `${label} final` }));
            socket.close();
          }
        });
      });
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      servers.push({ server, connections });
      const port = server.address().port;
      const transcripts = [];
      const partials = [];
      const errors = [];
      const resolved = provider.resolveConfig({ cfg: config, rawConfig: {
        baseUrl: `ws://127.0.0.1:${port}/${label}`, apiKey: `synthetic-${label}`, model: `${label}-model`,
      } });
      assert.equal(provider.isConfigured({ cfg: config, providerConfig: resolved }), true);
      const session = provider.createSession({ cfg: config, providerConfig: resolved,
        onTranscript: value => transcripts.push(value), onPartial: value => partials.push(value),
        onError: error => errors.push(error) });
      assert.equal(typeof session.connect, 'function');
      assert.equal(typeof session.close, 'function');
      sessions.push({ session, transcripts, partials, errors });
      await session.connect();
      assert.equal(session.isConnected(), true);
      assert.equal(connections.length, 1);
      assert.equal(connections[0].url, `/${label}/realtime?intent=transcription`);
      assert.equal(connections[0].authorization, `Bearer synthetic-${label}`);
      assert.equal(connections[0].messages[0].session.audio.input.transcription.model, `${label}-model`);
    }

    const send = (connection, event) => connection.socket.send(JSON.stringify(event));
    const first = servers[0].connections[0];
    send(first, { type: 'input_audio_buffer.committed', item_id: 'second', previous_item_id: 'first' });
    send(first, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: 'two' });
    send(first, { type: 'input_audio_buffer.committed', item_id: 'first', previous_item_id: null });
    send(first, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: 'one' });
    await until(() => sessions[0].transcripts.length === 2, 'committed predecessor order settles');
    assert.deepEqual(sessions[0].transcripts, ['one', 'two']);
    assert.deepEqual(sessions[1].transcripts, []);

    send(first, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'reused', delta: 'old ' });
    await until(() => sessions[0].partials.includes('old '), 'pre-disconnect partial observed');
    first.socket.terminate();
    await until(() => servers[0].connections.length === 2 && sessions[0].session.isConnected(), 'native reconnect reaches provider readiness');
    const reconnected = servers[0].connections[1];
    assert.equal(reconnected.authorization, 'Bearer synthetic-first');
    send(reconnected, { type: 'input_audio_buffer.committed', item_id: 'reused', previous_item_id: null });
    send(reconnected, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'reused', delta: 'new' });
    send(reconnected, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'reused', transcript: 'new' });
    await until(() => sessions[0].transcripts.length === 3, 'reconnected item settles');
    assert.deepEqual(sessions[0].transcripts, ['one', 'two', 'new']);
    assert.equal(sessions[0].partials.at(-1), 'new');

    for (const [index, item] of sessions.entries()) {
      item.session.sendAudio(Buffer.alloc(800, 0xff));
      await until(() => servers[index].connections.at(-1).messages.some(message => message.type === 'input_audio_buffer.append'), 'real audio frame sent');
      item.session.close();
    }
    await until(() => sessions.every((item, index) => item.transcripts.at(-1) === `${index === 0 ? 'first' : 'second'} final`), 'close drains final native transcripts');
    for (const [index, item] of sessions.entries()) {
      assert.deepEqual(item.errors, []);
      assert.equal(item.session.isConnected(), false);
      assert.equal(servers[index].connections.at(-1).messages.filter(message => message.type === 'input_audio_buffer.commit').length, 1);
    }
    assert.equal(servers[0].connections.length, 2);
    assert.equal(servers[1].connections.length, 1);
  } finally {
    for (const item of sessions) item.session.close();
    for (const { server } of servers) for (const socket of server.clients) socket.terminate();
    const closed = await Promise.allSettled(servers.map(({ server }) =>
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    try {
      await inspection?.release();
      released = closed.every(result => result.status === 'fulfilled');
      for (const result of closed) if (result.status === 'rejected') throw result.reason;
    }
    finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      assert.equal(path.dirname(root), path.resolve('.agent-tasks/runtime'));
      if (released) fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
