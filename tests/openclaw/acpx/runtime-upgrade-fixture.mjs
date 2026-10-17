// Run directly with Node or Electron-as-Node. The only child is this synthetic ACP
// server; neither Gateway nor an installed adapter/model is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);

function serveAgent(root) {
  const log = entry => fs.appendFileSync(path.join(root, 'agent-events.jsonl'), `${JSON.stringify(entry)}\n`);
  const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const reply = (id, result) => send({ id, result });
  const pendingPermissions = new Map();
  let activePrompt;
  let permissionId = 0;
  log({ type: 'started', pid: process.pid });

  const output = (sessionId, text) => send({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
  const finish = (request, text) => {
    output(request.params.sessionId, text);
    reply(request.id, { stopReason: 'end_turn' });
  };

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    const message = JSON.parse(line);
    if (!message.method) {
      const prompt = pendingPermissions.get(message.id);
      if (prompt) {
        pendingPermissions.delete(message.id);
        const decision = message.result?.outcome;
        log({ type: 'permission', outcome: decision?.optionId ?? decision?.outcome });
        finish(prompt, `permission:${decision?.optionId ?? decision?.outcome}`);
      }
      return;
    }
    switch (message.method) {
      case 'initialize':
        reply(message.id, {
          protocolVersion: message.params.protocolVersion,
          agentCapabilities: { loadSession: true },
          authMethods: [],
          agentInfo: { name: 'runtime-fixture', version: '1' },
        });
        break;
      case 'session/new': {
        const countFile = path.join(root, 'created-count');
        const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
        fs.writeFileSync(countFile, String(count));
        const sessionId = `fixture-session-${count}`;
        log({ type: 'new', sessionId });
        reply(message.id, { sessionId });
        break;
      }
      case 'session/load':
        log({ type: 'load', sessionId: message.params.sessionId });
        reply(message.id, {});
        break;
      case 'session/prompt': {
        const text = message.params.prompt.filter(item => item.type === 'text').map(item => item.text).join('');
        if (text === 'wait') {
          activePrompt = message;
          output(message.params.sessionId, 'waiting');
        } else if (text === 'request-write') {
          const id = `permission-${++permissionId}`;
          pendingPermissions.set(id, message);
          send({
            id,
            method: 'session/request_permission',
            params: {
              sessionId: message.params.sessionId,
              toolCall: { toolCallId: id, title: 'Synthetic write', kind: 'edit', status: 'pending' },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ],
            },
          });
        } else {
          finish(message, `echo:${text}`);
        }
        break;
      }
      case 'session/cancel':
        log({ type: 'cancel', sessionId: message.params.sessionId });
        if (activePrompt) {
          reply(activePrompt.id, { stopReason: 'cancelled' });
          activePrompt = undefined;
        }
        break;
      default:
        if (message.id !== undefined) reply(message.id, {});
    }
  });
  input.on('close', () => process.exit(0));
}

async function loadRuntime(packageFile, expectedVersion) {
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(metadata.version, expectedVersion, 'exercise the requested published dependency');
  const require = createRequire(packageFile);
  const runtime = await import(pathToFileURL(require.resolve('acpx/runtime')).href);
  for (const name of [
    'AcpxRuntime', 'createAcpRuntime', 'createAgentRegistry', 'createFileSessionStore',
    'decodeAcpxRuntimeHandleState', 'encodeAcpxRuntimeHandleState', 'isRequestedModelUnsupportedError',
  ]) assert.equal(typeof runtime[name], 'function', `public export ${name}`);
  return runtime;
}

async function regress() {
  const packageFile = path.resolve(process.env.ACPX_RUNTIME_TEST_PACKAGE
    ?? 'openclaw-extensions/acpx/node_modules/acpx/package.json');
  const api = await loadRuntime(packageFile, process.env.ACPX_RUNTIME_EXPECTED_VERSION ?? '0.19.5');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpx-runtime-'));
  const workspace = path.join(root, '工作 区');
  fs.mkdirSync(workspace);
  const runtimes = [];
  let request = 0;
  let stopping = false;
  const events = () => fs.existsSync(path.join(root, 'agent-events.jsonl'))
    ? fs.readFileSync(path.join(root, 'agent-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const create = (module, storeName, nonInteractivePermissions = 'deny') => {
    assert(!stopping, 'fixture cleanup has closed runtime admission');
    const store = module.createFileSessionStore({ stateDir: path.join(root, storeName) });
    const runtime = module.createAcpRuntime({
      cwd: workspace,
      sessionStore: store,
      agentRegistry: module.createAgentRegistry({ overrides: { fixture: [process.execPath, script, '--agent', root] } }),
      permissionMode: 'approve-reads',
      nonInteractivePermissions,
      timeoutMs: 5_000,
      fs: false,
      terminal: false,
    });
    runtimes.push(runtime);
    return { runtime, store };
  };
  const start = (runtime, handle, text) => runtime.startTurn({
    handle, text, mode: 'prompt', requestId: `fixture-request-${++request}`, timeoutMs: 0,
  });
  const complete = async (runtime, handle, text) => {
    const turn = start(runtime, handle, text);
    const received = [];
    const stream = (async () => { for await (const event of turn.events) received.push(event); })();
    // Observe both channels immediately so a failing runtime cannot escape the
    // owned cleanup through an unhandled event-stream rejection.
    const [result] = await Promise.all([turn.result, stream]);
    return { result, received };
  };

  const scenarios = async () => {
    const { runtime } = create(api, 'current');
    const input = { sessionKey: 'runtime-upgrade:current', agent: 'fixture', mode: 'persistent' };
    const handles = await Promise.all(Array.from({ length: 4 }, () => runtime.ensureSession(input)));
    const handle = handles[0];
    assert(handles.every(item => item.backendSessionId === handle.backendSessionId));
    assert.equal(events().filter(item => item.type === 'new').length, 1, 'concurrent ensure creates one physical session');
    assert.equal((await runtime.findSession(input)).backendSessionId, handle.backendSessionId);

    const denied = await complete(runtime, handle, 'request-write');
    assert.equal(denied.result.status, 'completed');
    assert(denied.received.some(item => item.type === 'text_delta' && item.text === 'permission:reject'));
    assert.equal(events().find(item => item.type === 'permission')?.outcome, 'reject');
    assert.equal((await complete(runtime, handle, 'after-denial')).result.status, 'completed');

    for (const closeStream of [false, true]) {
      const turn = start(runtime, handle, 'wait');
      let signalWaiting;
      let rejectWaiting;
      const waiting = new Promise((resolve, reject) => { signalWaiting = resolve; rejectWaiting = reject; });
      const stream = (async () => {
        for await (const event of turn.events) {
          if (event.type === 'text_delta' && event.text === 'waiting') signalWaiting();
        }
      })();
      void stream.catch(rejectWaiting);
      await Promise.race([
        waiting,
        turn.result.then(() => { throw new Error('synthetic prompt ended before its waiting event'); }),
      ]);
      if (closeStream) {
        await turn.closeStream({ reason: 'fixture stopped observing' });
        await stream;
        await runtime.cancel({ handle, reason: 'fixture cancellation' });
      } else {
        await turn.cancel({ reason: 'fixture cancellation' });
      }
      assert.equal((await turn.result).status, 'cancelled');
      await stream;
      assert.equal((await complete(runtime, handle, 'after-cancel')).result.status, 'completed');
    }
    assert.equal(events().filter(item => item.type === 'cancel').length, 2);
    assert.equal(events().filter(item => item.type === 'new').length, 1, 'permission and cancel controls preserve the physical session');
    await runtime.close({ handle, reason: 'fixture complete' });
    await runtime.shutdown();

    if (process.env.ACPX_RUNTIME_BASELINE_PACKAGE) {
      const oldApi = await loadRuntime(path.resolve(process.env.ACPX_RUNTIME_BASELINE_PACKAGE), '0.19.1');
      const old = create(oldApi, 'legacy');
      const legacyInput = { sessionKey: 'runtime-upgrade:legacy', agent: 'fixture', mode: 'persistent' };
      const legacyHandle = await old.runtime.ensureSession(legacyInput);
      assert.equal((await complete(old.runtime, legacyHandle, 'legacy-output')).result.status, 'completed');
      await old.runtime.shutdown();
      const previous = await old.store.load(legacyHandle.acpxRecordId);
      const newCount = events().filter(item => item.type === 'new').length;
      const next = create(api, 'legacy');
      const found = await next.runtime.findSession(legacyInput);
      assert.equal(found?.backendSessionId, legacyHandle.backendSessionId);
      const reused = await next.runtime.ensureSession(legacyInput);
      assert.equal(reused.backendSessionId, legacyHandle.backendSessionId);
      assert.equal(reused.acpxRecordId, legacyHandle.acpxRecordId);
      // Also consume the genuine old serialized handle rather than only its replacement.
      assert.equal((await complete(next.runtime, legacyHandle, 'after-upgrade')).result.status, 'completed');
      const retained = await next.store.load(legacyHandle.acpxRecordId);
      for (const message of previous.messages) {
        assert(retained.messages.some(item => JSON.stringify(item) === JSON.stringify(message)), 'retain every legacy message');
      }
      assert.equal(events().filter(item => item.type === 'new').length, newCount, 'legacy resume must not create a new session');
      assert(events().some(item => item.type === 'load' && item.sessionId === legacyHandle.backendSessionId));
      await next.runtime.close({ handle: reused, reason: 'fixture legacy complete' });
      await next.runtime.shutdown();
    }

    const pids = new Set(events().filter(item => item.type === 'started').map(item => item.pid));
    const alive = pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const cleanupDeadline = Date.now() + 2_000;
    while ([...pids].some(alive) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(![...pids].some(alive), 'close/shutdown retire every synthetic adapter process');
  };
  let primaryFailure;
  let deadline;
  try {
    await Promise.race([
      scenarios(),
      new Promise((_, reject) => {
        // Cold Electron + genuine old/new persistence takes about 39s locally;
        // leave bounded headroom for the application's parallel test workers.
        deadline = setTimeout(() => reject(new Error('acpx runtime fixture exceeded its execution budget')), 90_000);
      }),
    ]);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    stopping = true;
    clearTimeout(deadline);
    // Begin every owned shutdown even when one rejects. A test failure remains
    // primary; shutdown failures must still allow the other owners and temp tree
    // to finish. Closing this process's pipes also retires its synthetic server.
    const cleanupDeadline = setTimeout(() => {
      if (primaryFailure) process.stderr.write(`${primaryFailure.stack ?? primaryFailure}\n`);
      process.stderr.write('acpx runtime fixture exceeded its cleanup budget\n');
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      process.exit(1);
    }, 15_000);
    try {
      const settled = await Promise.allSettled(runtimes.map(runtime => Promise.resolve().then(() => runtime.shutdown())));
      const failures = settled.filter(item => item.status === 'rejected').map(item => item.reason);
      try { fs.rmSync(root, { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
      if (failures.length && !primaryFailure) throw new AggregateError(failures, 'acpx fixture cleanup failed');
      if (failures.length) process.stderr.write(`${failures.length} fixture cleanup operation(s) also failed\n`);
    } finally {
      clearTimeout(cleanupDeadline);
    }
  }
  process.stdout.write('acpx runtime regression passed\n');
}

if (process.argv[2] === '--agent') serveAgent(process.argv[3]);
else await regress();
