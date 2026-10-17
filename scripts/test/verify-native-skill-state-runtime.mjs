// Opt-in real Gateway/QuickJS probe with synthetic skills, a loopback model and
// disposable state. Never reads user configuration or connects to their Gateway.
// Usage: node scripts/test/verify-native-skill-state-runtime.mjs [runtime-directory]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = path.resolve(process.argv[2] ?? path.join(root, 'vendor/openclaw-runtime/current'));
const packageJson = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
const buildInfo = JSON.parse(await readFile(path.join(runtime, 'runtime-build-info.json'), 'utf8'));
const runtimeIdentity = {
  version: packageJson.version,
  node: process.versions.node,
  electron: process.versions.electron,
  gatewayBundleSha256: createHash('sha256')
    .update(await readFile(path.join(runtime, 'gateway-bundle.mjs')))
    .digest('hex'),
  patchSetSha256: buildInfo.patchSetSha256,
};
const artifacts = path.join(root, '.agent-tasks/runtime/skill-state');
await mkdir(artifacts, { recursive: true });
const resumeBase =
  process.argv[3] === '--resume-restart' ? path.resolve(process.argv[4]) : undefined;
assert.ok(!process.argv[3] || resumeBase, 'Unknown probe option');
if (resumeBase) {
  assert.equal(path.dirname(resumeBase), path.resolve(artifacts));
  assert.ok(path.basename(resumeBase).startsWith('probe-'));
  assert.equal(path.dirname(await realpath(resumeBase)), await realpath(artifacts));
}
const base = resumeBase ?? (await mkdtemp(path.join(artifacts, 'probe-')));
let previousVerification;
if (resumeBase) {
  const previousPath = path.join(base, 'restart-source-evidence.json');
  let raw;
  try {
    raw = await readFile(previousPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    raw = await readFile(path.join(base, 'failure.json'), 'utf8');
    await writeFile(previousPath, raw, { flag: 'wx' });
  }
  previousVerification = JSON.parse(raw);
  assert.equal(previousVerification.checks.length, 16);
  assert.match(previousVerification.error, /Restart requires a clean Gateway shutdown/);
}
const workspace = path.join(base, 'workspace');
await mkdir(workspace, { recursive: true });
const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const lifecycleModule = path.join(base, 'host-lifecycle.cjs');
buildSync({
  entryPoints: [path.join(root, 'src/main/openclaw/runtime/openclawLauncher.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: lifecycleModule,
});
const { ensureGatewayShutdownPreload, OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } = require(
  lifecycleModule,
);
const shutdownPreload = ensureGatewayShutdownPreload(base);
const { GATEWAY_READY_MESSAGE } = require(
  path.join(root, 'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'),
);
const configPath = path.join(base, 'config.json');
const token = randomBytes(24).toString('hex');
const checks = [];
const events = [];
const requests = [];
let scenario;
let gateway;
let client;
let gatewayOutput = '';

const skillName = 'fixture-calibration';
const bodyWord = 'quartzcalibration';
const skillTail = 'COMPLETE_SKILL_INSTRUCTIONS_END';
const skillText = `---\nname: ${skillName}\ndescription: Fixture instrument calibration workflow.\n---\n# Calibration\n${bodyWord}\n${'Fixture instructions.\n'.repeat(1000)}${skillTail}\n`;
for (const [name, text] of [
  [skillName, skillText],
  [
    'fixture-disabled',
    '---\nname: fixture-disabled\ndescription: disableduniqueneedle\n---\nDisabled instructions.\n',
  ],
]) {
  // Match the product's imported-skill destination, rather than only project skills.
  const directory = path.join(base, 'state', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), text);
}

const model = http.createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.ok(scenario, 'Unexpected model request outside a probe turn');
    requests.push({ scenario: scenario.name, body });
    scenario.bodies.push(body);
    const step = scenario.steps[scenario.cursor++];
    if (step?.hold) {
      scenario.heldResponse = response;
      return;
    }
    const delta = step
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}-${scenario.cursor}`,
              type: 'function',
              function: { name: step.name, arguments: JSON.stringify(step.args) },
            },
          ],
        }
      : { role: 'assistant', content: `PROBE_DONE:${scenario.name}` };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    scenario?.errors.push(String(error));
    response.writeHead(500);
    response.end('Fixture model assertion failed');
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));

const config = {
  logging: { file: path.join(base, 'gateway.log'), level: 'debug', consoleLevel: 'info' },
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: {
    ownership: 'explicit',
    entries: {
      main: {},
      code: { tools: { codeMode: { enabled: true, executor: 'quickjs' } } },
      restricted: { tools: { deny: ['read', 'skills_read'] } },
    },
    defaults: {
      workspace,
      skipBootstrap: true,
      heartbeat: { every: '0m' },
      model: { primary: 'fixture/fixture' },
      compaction: { mode: 'safeguard', memoryFlush: { enabled: false } },
    },
  },
  models: {
    mode: 'replace',
    catalogRefresh: { enabled: false },
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: 'openai-completions',
        apiKey: 'fixture-only',
        agentRuntime: { id: 'openclaw' },
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: 'fixture',
            name: 'Fixture',
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 2000,
          },
        ],
      },
    },
  },
  skills: { limits: { maxSkillsInPrompt: 0 }, entries: { 'fixture-disabled': { enabled: false } } },
  tools: {
    profile: 'full',
    toolSearch: { enabled: true, mode: 'directory' },
    codeMode: { enabled: false },
  },
  plugins: {
    slots: { memory: 'none' },
    allow: ['openai', 'code-mode-quickjs'],
    entries: { openai: { enabled: true }, 'code-mode-quickjs': { enabled: true } },
  },
};
await writeFile(configPath, JSON.stringify(config));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.toUpperCase().startsWith('OPENCLAW_') &&
      !['VITEST', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase()),
  ),
);
Object.assign(env, {
  OPENCLAW_HOME: base,
  OPENCLAW_STATE_DIR: path.join(base, 'state'),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1',
});
if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
// The SDK client also uses the disposable device/state location.
for (const name of Object.keys(process.env)) {
  if (
    name.toUpperCase().startsWith('OPENCLAW_') ||
    ['VITEST', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase())
  )
    delete process.env[name];
}
Object.assign(process.env, env);
const { GatewayClient } = await import(
  pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js'))
);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    if (gateway?.exitCode !== null && gateway?.exitCode !== undefined)
      throw new Error(`Gateway exited (${gateway.exitCode}): ${gatewayOutput.slice(-5000)}`);
    await wait(100);
  }
  throw new Error(`Timeout: ${label}`);
}
async function startGateway() {
  gateway = spawn(
    process.execPath,
    [
      '--require',
      shutdownPreload,
      path.join(runtime, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
    ],
    { cwd: base, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  for (const stream of [gateway.stdout, gateway.stderr])
    stream.on('data', data => {
      gatewayOutput += data;
    });
  await until(
    async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {
        return false;
      }
    },
    'Gateway ready',
    300000,
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway handshake timeout')), 90000);
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin'],
      // Match the product chat client; the SDK's 30s default is shorter.
      requestTimeoutMs: 90_000,
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: error => {
        clearTimeout(timer);
        reject(error);
      },
      onEvent: event => {
        events.push(event);
      },
    });
    client.start();
  });
  gateway.send(GATEWAY_READY_MESSAGE);
}
async function stopGateway() {
  await client?.stop();
  client = undefined;
  if (!gateway) return true;
  if (gateway.exitCode !== null || gateway.signalCode !== null)
    return gateway.exitCode === 0 && gateway.signalCode === null;
  const child = gateway;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.send(OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE);
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    child.kill();
  }, 330000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
    gateway = undefined;
  }
  return !forced && child.exitCode === 0;
}
const plainKey = 'agent:main:fixture:skills';
const codeKey = 'agent:code:fixture:store';
const otherKey = 'agent:code:fixture:other';
const restrictedKey = 'agent:restricted:fixture:skills';
const skillCall = (name, args) => ({ name: 'tool_call', args: { id: name, args } });
const exec = code => ({ name: 'exec', args: { title: 'Verify native session state', code } });
const readReport = exec(
  "const value = await load('report'); if (value.count !== 7 || value.text !== '中文') throw new Error('Store mismatch'); return 'TURN_READ_OK';",
);
const toolMessages = turn => {
  const messages = turn.bodies.at(-1).messages;
  return messages
    .slice(messages.findLastIndex(message => message.role === 'user') + 1)
    .filter(message => message.role === 'tool')
    .map(message =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    );
};
const toolText = turn => toolMessages(turn).join('\n');
const codeResults = turn => toolMessages(turn).map(text => JSON.parse(text));
function completed(turn, marker) {
  assert.deepEqual(turn.errors, []);
  const results = codeResults(turn);
  assert.ok(results.length > 0, 'Missing structured Code Mode result');
  for (const result of results) assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(
    results.some(result => JSON.stringify(result.value)?.includes(marker)),
    `Missing value ${marker}: ${JSON.stringify(results).slice(-4000)}`,
  );
}
async function run(name, key, steps, verify) {
  scenario = { name, steps, cursor: 0, bodies: [], errors: [] };
  const accepted = await client.request('chat.send', {
    sessionKey: key,
    message: `Fixture verification: ${name}`,
    idempotencyKey: randomBytes(16).toString('hex'),
  });
  const terminal = await until(
    () =>
      events.find(
        event =>
          event.event === 'agent' &&
          event.payload?.runId === accepted.runId &&
          event.payload?.stream === 'lifecycle' &&
          event.payload?.data?.executionSettled === true,
      ),
    `${name} settled`,
  );
  assert.equal(terminal.payload.data.phase, 'end', JSON.stringify(terminal.payload.data));
  assert.deepEqual(scenario.errors, []);
  assert.equal(scenario.cursor, steps.length + 1, `Unexpected tool/model rounds in ${name}`);
  await verify(scenario);
  checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  await startGateway();
  if (resumeBase) {
    await run('completed store survives preceding host exit', codeKey, [readReport], turn =>
      completed(turn, 'TURN_READ_OK'),
    );
  } else {
    for (const key of [plainKey, codeKey, otherKey, restrictedKey])
      await client.request('sessions.create', { key, cwd: workspace, permissionMode: 'full' });
    await run(
      'skills omitted from prompt remain searchable',
      plainKey,
      [skillCall('skills_search', { query: 'instrument calibration' })],
      turn => {
        const system = JSON.stringify(
          turn.bodies[0].messages.filter(message => message.role === 'system'),
        );
        assert.ok(!system.includes(`<name>${skillName}</name>`));
        assert.ok(toolText(turn).includes(skillName), toolText(turn));
        assert.ok(!toolText(turn).includes(skillTail));
      },
    );
    await run(
      'skill instruction body search',
      plainKey,
      [skillCall('skills_search', { query: bodyWord })],
      turn => assert.ok(toolText(turn).includes(skillName), toolText(turn)),
    );
    await run(
      'complete skill read beyond search prefix',
      plainKey,
      [skillCall('skills_read', { name: skillName })],
      turn => assert.ok(toolText(turn).includes(skillTail), toolText(turn).slice(-1000)),
    );
    await run(
      'disabled skills excluded',
      plainKey,
      [skillCall('skills_search', { query: 'disableduniqueneedle' })],
      turn => assert.ok(!toolText(turn).includes('fixture-disabled'), toolText(turn)),
    );
    await run(
      'read denial keeps metadata search',
      restrictedKey,
      [skillCall('skills_search', { query: 'instrument calibration' })],
      turn => assert.ok(toolText(turn).includes(skillName), toolText(turn)),
    );
    await run(
      'read denial suppresses instruction search',
      restrictedKey,
      [skillCall('skills_search', { query: bodyWord })],
      turn => assert.ok(!toolText(turn).includes(skillName), toolText(turn)),
    );
    await run(
      'read denial blocks exact skill read',
      restrictedKey,
      [skillCall('skills_read', { name: skillName })],
      turn => {
        assert.ok(!toolText(turn).includes(skillTail), toolText(turn));
        assert.match(toolText(turn), /denied|not available|not allowed|unknown|unavailable/i);
      },
    );
    await run(
      'Code Mode searches and reads skills',
      codeKey,
      [
        exec(
          `const found = await skills.search(${JSON.stringify(bodyWord)}); const text = await skills.read(${JSON.stringify(skillName)}); if (!JSON.stringify(found).includes(${JSON.stringify(skillName)}) || !text.includes(${JSON.stringify(skillTail)})) throw new Error('Skill result mismatch'); return 'CODE_SKILLS_OK';`,
        ),
      ],
      turn => completed(turn, 'CODE_SKILLS_OK'),
    );
    await run(
      'store survives separate cells',
      codeKey,
      [
        exec("await store('report', { count: 7, text: '中文' }); return 'SAVED';"),
        exec(
          "const value = await load('report'); if (value.count !== 7 || value.text !== '中文') throw new Error('Store mismatch'); return 'CELL_READ_OK';",
        ),
      ],
      turn => completed(turn, 'CELL_READ_OK'),
    );
    await run('store survives follow-up turn', codeKey, [readReport], turn =>
      completed(turn, 'TURN_READ_OK'),
    );
    await run(
      'store isolated between sessions',
      otherKey,
      [
        exec(
          "if (await load('report') !== undefined) throw new Error('Cross-session leak'); return 'ISOLATION_OK';",
        ),
      ],
      turn => completed(turn, 'ISOLATION_OK'),
    );
    await run(
      'failed cell discards buffered writes',
      codeKey,
      [exec("await store('failed-cell', 9); throw new Error('EXPECTED_CELL_FAILURE');")],
      turn => {
        const result = codeResults(turn).at(-1);
        assert.equal(result.status, 'failed');
        assert.match(JSON.stringify(result.error), /EXPECTED_CELL_FAILURE/);
      },
    );
    await run(
      'failed cell leaves no saved value',
      codeKey,
      [
        exec(
          "if (await load('failed-cell') !== undefined) throw new Error('Failed cell committed'); return 'FAILED_WRITE_ABSENT';",
        ),
      ],
      turn => completed(turn, 'FAILED_WRITE_ABSENT'),
    );
    await run(
      'oversized value rejected',
      codeKey,
      [exec("await store('oversized', 'x'.repeat(262145)); return 'UNREACHABLE';")],
      turn => {
        const result = codeResults(turn).at(-1);
        assert.equal(result.status, 'failed');
        assert.match(JSON.stringify(result.error), /256 KiB/);
      },
    );
    scenario = {
      name: 'cancel uncommitted cell',
      steps: [
        exec("await store('canceled-cell', 11); await yield_control(); return 'UNREACHABLE';"),
        { hold: true },
      ],
      cursor: 0,
      bodies: [],
      errors: [],
    };
    const canceled = await client.request('chat.send', {
      sessionKey: codeKey,
      message: 'Fixture verification: cancel uncommitted cell',
      idempotencyKey: randomBytes(16).toString('hex'),
    });
    await until(() => scenario.heldResponse, 'cell yielded before cancellation');
    assert.equal(codeResults(scenario).at(-1).status, 'waiting');
    await client.request('chat.abort', { sessionKey: codeKey, runId: canceled.runId });
    const canceledTerminal = await until(
      () =>
        events.find(
          event =>
            event.event === 'agent' &&
            event.payload?.runId === canceled.runId &&
            event.payload?.stream === 'lifecycle' &&
            event.payload?.data?.executionSettled === true,
        ),
      'canceled run settled',
    );
    const canceledOutcome = canceledTerminal.payload.data;
    assert.ok(['end', 'error'].includes(canceledOutcome.phase), JSON.stringify(canceledOutcome));
    assert.equal(canceledOutcome.aborted, true);
    assert.equal(canceledOutcome.stopReason, 'aborted');
    scenario.heldResponse.destroy();
    checks.push('cancellation settles without completing cell');
    console.log('PASS cancellation settles without completing cell');
    await run(
      'canceled cell leaves no saved value',
      codeKey,
      [
        exec(
          "if (await load('canceled-cell') !== undefined) throw new Error('Canceled cell committed'); return 'CANCELED_WRITE_ABSENT';",
        ),
      ],
      turn => completed(turn, 'CANCELED_WRITE_ABSENT'),
    );
  }
  assert.equal(await stopGateway(), true, 'Restart requires a clean Gateway shutdown');
  await startGateway();
  await run('store survives Gateway restart', codeKey, [readReport], turn =>
    completed(turn, 'TURN_READ_OK'),
  );
  await run(
    'deleting a stored value',
    codeKey,
    [exec("await store('report', undefined); return 'DELETE_OK';")],
    turn => completed(turn, 'DELETE_OK'),
  );
  await run(
    'deleted value absent on next turn',
    codeKey,
    [
      exec(
        "if (await load('report') !== undefined) throw new Error('Deleted value remains'); return 'DELETE_CONFIRMED';",
      ),
    ],
    turn => completed(turn, 'DELETE_CONFIRMED'),
  );
  const history = await client.request('chat.history', { sessionKey: codeKey, limit: 200 });
  assert.ok(!JSON.stringify(history).includes('"customType":"openclaw.code-mode-store"'));
  checks.push('internal store entries stay outside display history');
  console.log('PASS internal store entries stay outside display history');
  assert.equal(await stopGateway(), true, 'Final Gateway shutdown must finish cleanly');
  await writeFile(
    path.join(base, 'result.json'),
    JSON.stringify(
      {
        ...runtimeIdentity,
        checks,
        previousVerification,
        modelRequests: requests.length,
        provider: 'loopback synthetic model',
      },
      null,
      2,
    ),
  );
  console.log(
    `Native skill discovery and Code Mode state: ${checks.length} checks passed. Evidence: ${path.join(base, 'result.json')}`,
  );
} catch (error) {
  console.error(error);
  await writeFile(
    path.join(base, 'failure.json'),
    JSON.stringify(
      {
        ...runtimeIdentity,
        checks,
        scenario: scenario?.name,
        errors: scenario?.errors,
        error: String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  scenario?.heldResponse?.destroy();
  await stopGateway();
  await new Promise(resolve => model.close(resolve));
  await writeFile(path.join(base, 'gateway-console.log'), gatewayOutput);
}
