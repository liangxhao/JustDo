// Exploration only: real product WebSocket server, synthetic execution backend.
// No installed app credentials, user sessions, or model calls are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../..');
const dependencyRoot = process.argv[2] || root;
process.env.NODE_PATH = path.join(dependencyRoot, 'node_modules');
Module._initPaths();
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(compiled.outputText, filename);
};
const { WebSocket } = require('ws');
const { BrowserExtensionChatServer, BROWSER_EXTENSION_ID } = require(
  path.join(root, 'src/main/browser/browserExtensionChatServer.ts'),
);

async function main() {
  let listener;
  let received;
  const thread = {
    id: 'probe-thread',
    title: 'Probe',
    status: 'running',
    cwd: root,
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
  const server = new BrowserExtensionChatServer(
    {
      listSessions: () => [thread],
      startThread: async () => thread,
      getMessages: async () => [],
      subscribeThreadEvents: async (_id, callback) => {
        listener = callback;
        return () => {};
      },
      sendMessage: async request => {
        received = request;
        return { sessionId: thread.id, runId: 'probe-run' };
      },
      getThreadRuntimeStatus: async () => ({ known: true, running: true }),
      consumeTurnError: () => undefined,
      interruptThread: async () => {},
      getComposerOptions: () => ({ models: [], permissionMode: 'ask' }),
    },
    'a'.repeat(64),
    'probe',
  );
  let socket;
  try {
    await server.start();
    socket = new WebSocket(server.getCapability().localAppServerUrl, {
      origin: `chrome-extension://${BROWSER_EXTENSION_ID}`,
    });
    await once(socket, 'open');
    const notifications = [];
    const pending = new Map();
    let sequence = 0;
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.id !== undefined) pending.get(message.id)?.(message);
      else notifications.push(message);
    });
    const request = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out: ${method}`));
        }, 3000);
        pending.set(id, value => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(value);
        });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    assert.ok(
      (await request('initialize', { clientInfo: { name: 'multica-probe', version: '1' } })).result,
    );
    socket.send(JSON.stringify({ method: 'initialized' }));
    assert.equal(
      (await request('thread/start', { cwd: 'probe-task-cwd', model: 'probe-model' })).result.thread
        .id,
      thread.id,
    );
    assert.match(
      (await request('thread/resume', { threadId: thread.id })).error.message,
      /Method not found/,
    );
    await request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'synthetic question' }],
    });
    assert.equal(received.message, 'synthetic question');
    listener({
      kind: 'agent',
      event: {
        runId: 'probe-run',
        sessionKey: 'probe',
        stream: 'tool',
        agentSeq: 1,
        data: { phase: 'start', toolCallId: 'call-1', name: 'read', args: { path: 'fixture.txt' } },
      },
    });
    // An RPC round trip flushes the earlier notification without timing sleeps.
    await request('thread/list');
    assert.ok(notifications.some(message => message.method === 'thread/stream'));
    assert.equal(
      notifications.some(message => message.method === 'item/started'),
      false,
    );
    await request('turn/interrupt', { threadId: thread.id, turnId: 'probe-run' });
    assert.ok(notifications.some(message => message.method === 'turn/completed'));
    console.log(
      JSON.stringify(
        {
          backend: 'synthetic; no real agent task executed',
          checks: [
            'initialize accepted',
            'Codex text input accepted',
            'thread/resume missing confirmed',
            'tool event delivered as custom thread/stream, not Codex item',
            'interrupt lifecycle delivered',
          ],
          notificationMethods: [...new Set(notifications.map(message => message.method))],
        },
        null,
        2,
      ),
    );
  } finally {
    if (socket) {
      socket.terminate();
      await once(socket, 'close');
    }
    await server.stop();
  }
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
