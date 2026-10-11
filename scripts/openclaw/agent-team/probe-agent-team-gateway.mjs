import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const runtimeSource = path.resolve(
  process.argv.slice(2).find(value => !value.startsWith('--')) ??
    path.join(repoRoot, 'vendor/openclaw-runtime/current'),
);
// Narrow launch regressions can omit the already independent capacity matrix.
const skipConcurrencyMatrix = process.argv.includes('--skip-concurrency-matrix');
const state = mkdtempSync(path.join(os.tmpdir(), 'justdo-team-gateway-'));
const workspace = path.join(state, 'workspace');
const project = path.join(state, 'project');
// Isolated package layout preserves genuine bundled-plugin provenance without
// modifying the installed runtime or bypassing native plugin trust checks.
const runtime = path.join(state, 'runtime');
mkdirSync(runtime);
for (const entry of readdirSync(runtimeSource, { withFileTypes: true })) {
  if (entry.name === 'dist') continue;
  const source = path.join(runtimeSource, entry.name),
    target = path.join(runtime, entry.name);
  if (entry.isDirectory()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
mkdirSync(path.join(runtime, 'dist'));
for (const entry of readdirSync(path.join(runtimeSource, 'dist'), { withFileTypes: true })) {
  if (entry.name === 'extensions') continue;
  const source = path.join(runtimeSource, 'dist', entry.name),
    target = path.join(runtime, 'dist', entry.name);
  if (entry.isDirectory()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
const bundledPath = path.join(runtime, 'dist', 'extensions');
mkdirSync(bundledPath);
const pluginPath = path.join(bundledPath, 'agent-team');
for (const dir of [workspace, project, pluginPath]) mkdirSync(dir);
writeFileSync(path.join(project, 'group-cwd-marker.txt'), 'ROOM_PROJECT_MARKER');
writeFileSync(path.join(workspace, 'group-cwd-marker.txt'), 'WRONG_AGENT_WORKSPACE');
const token = randomBytes(24).toString('hex');
const portServer = net.createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
let modelRequests = 0;
const startTracking = async () => client.request('teamProbe.metrics', { reset: true });
async function checkTracking(limit, count) {
  const metrics = await client.request('teamProbe.metrics', {});
  assert.equal(metrics.started, count, 'count actual native starts, not SDK turn reservations');
  assert.equal(metrics.settled, count, 'every actual run must settle');
  assert.equal(metrics.active, 0);
  assert.ok(
    metrics.peak <= limit,
    `native start→whole-run settled peak ${metrics.peak} exceeds ${limit}`,
  );
  if (limit > 1) assert.ok(metrics.peak > 1, 'fixture must exercise overlapping native executions');
  console.log(
    JSON.stringify({ check: 'native-response-concurrency', limit, count, peak: metrics.peak }),
  );
}
let heldRequests = 0;
let organizerNativeContexts = 0;
const organizerContextChecks = [];
const toolObservations = [];
const launchObservations = [];
let reviewDeliveryIds = [];
let reviewerFinishResponse;
const model = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  modelRequests++;
  const modelContext = body.messages
    .map(message =>
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).map(block => block.text ?? '').join('\n'),
    )
    .join('\n');
  if (modelContext.includes('The initiating message is relayed by the organizing assistant')) {
    organizerContextChecks.push({
      sender: /"sender"\s*:\s*\{\s*"id":\s*"agent:alice"/.test(modelContext),
      bot: /"is_bot":\s*true/.test(modelContext),
      relay: modelContext.includes('not a direct user message'),
      authorization: modelContext.includes('does not grant additional user authorization'),
    });
    organizerNativeContexts++;
  }
  if (JSON.stringify(body.messages).includes('HOLD_FIXTURE')) {
    heldRequests++;
    return;
  }
  if (modelContext.includes('LIMIT_NATIVE_FIXTURE'))
    await new Promise(resolve => setTimeout(resolve, 750));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (modelContext.includes('INDEPENDENT_REVIEW_FIXTURE')) {
    if (!body.messages.some(message => message.role === 'tool')) {
      response.end(
        `data: ${JSON.stringify({ id: 'review-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'report-review', type: 'function', function: { name: 'tool_call', arguments: JSON.stringify({ id: 'task_assistants', args: { review: { deliveryIds: reviewDeliveryIds, verdict: 'passed' } } }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      // Let the probe inspect the pending report before the actual native run ends.
      reviewerFinishResponse = response;
    }
    return;
  }
  if (
    (body.tools ?? []).length === 0 &&
    modelContext.includes('A group discussion has ended. Summarize its available public results')
  ) {
    assert.equal((body.tools ?? []).length, 0, 'automatic summaries must have no tools');
    response.end(
      `data: ${JSON.stringify({ id: 'summary-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'TEAM_SUMMARY_COMPLETE' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (JSON.stringify(body.messages).includes('ORGANIZE_TEAM_FIXTURE')) {
    const results = body.messages.filter(message => message.role === 'tool');
    const publishedSkill = path.join(state, 'plugin-skills/agent-team/SKILL.md');
    const steps = [
      ['read', { path: publishedSkill }],
      ['tool_search', { query: 'task_assistants' }],
      ['tool_describe', { id: 'task_assistants' }],
      ['tool_call', { id: 'task_assistants', args: {} }],
      ['tool_call', { id: 'write', args: { path: 'forbidden-launch.txt', content: 'forbidden' } }],
      [
        'tool_call',
        {
          id: 'team_discussion',
          args: {
            action: 'create',
            title: 'Organized discussion',
            agentIds: ['bob', 'carol'],
            message: 'Discuss the design in one sentence.',
            rounds: 1,
          },
        },
      ],
    ];
    if (results.length > 0) {
      const text = JSON.stringify(results.at(-1).content);
      launchObservations[results.length - 1] = text;
    }
    if (results.length < steps.length) {
      const [name, args] = steps[results.length];
      response.end(
        `data: ${JSON.stringify({ id: 'organizer-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `organize-team-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
  }
  if (
    JSON.stringify(body.messages).includes('MESSAGE_TOOL_FIXTURE') &&
    !body.messages.some(
      message => message.role === 'tool' && JSON.stringify(message.content).includes('messageId'),
    )
  ) {
    const hadMessageCall = body.messages.some(
      message =>
        message.role === 'assistant' &&
        JSON.stringify(message.tool_calls).includes('Outbound fixture message'),
    );
    if (!hadMessageCall) {
      response.end(
        `data: ${JSON.stringify({ id: 'message-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'message-send', type: 'function', function: { name: 'tool_call', arguments: JSON.stringify({ id: 'message', args: { action: 'send', channel: 'justdo-team', target: 'message-room', message: 'Outbound fixture message' } }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
  }
  const tools = body.messages?.filter(message => message.role === 'tool') ?? [];
  if (!tools.length) {
    toolObservations.push({ offered: (body.tools ?? []).map(tool => tool.function?.name) });
    response.end(
      `data: ${JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'fixture-read',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ path: 'group-cwd-marker.txt' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  toolObservations.push({ results: tools.map(tool => tool.content) });
  response.write(
    `data: ${JSON.stringify({
      id: 'fixture',
      object: 'chat.completion.chunk',
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'Fixture answer.' }, finish_reason: null },
      ],
    })}\n\n`,
  );
  response.end(
    `data: ${JSON.stringify({
      id: 'fixture',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
buildSync({
  absWorkingDir: repoRoot,
  entryPoints: ['tests/openclaw/fixtures/agent-team-probe.ts'],
  outfile: path.join(pluginPath, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['openclaw/plugin-sdk/*'],
});
mkdirSync(path.join(pluginPath, 'skills/agent-team'), { recursive: true });
copyFileSync(
  path.join(repoRoot, 'openclaw-extensions/agent-team/skills/agent-team/SKILL.md'),
  path.join(pluginPath, 'skills/agent-team/SKILL.md'),
);
writeFileSync(
  path.join(pluginPath, 'package.json'),
  JSON.stringify({ name: 'agent-team', type: 'module', openclaw: { extensions: ['./index.mjs'] } }),
);
writeFileSync(
  path.join(pluginPath, 'openclaw.plugin.json'),
  JSON.stringify({
    ...JSON.parse(
      readFileSync(
        path.join(repoRoot, 'openclaw-extensions/agent-team/openclaw.plugin.json'),
        'utf8',
      ),
    ),
    id: 'agent-team',
    name: 'Integration fixture',
    channels: ['justdo-team'],
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
const historyPath = path.join(bundledPath, 'runtime-services');
mkdirSync(historyPath);
buildSync({
  absWorkingDir: repoRoot,
  entryPoints: ['tests/openclaw/fixtures/team-history-probe.ts'],
  outfile: path.join(historyPath, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['openclaw/plugin-sdk/*'],
});
writeFileSync(
  path.join(historyPath, 'package.json'),
  JSON.stringify({
    name: 'runtime-services',
    type: 'module',
    openclaw: { extensions: ['./index.mjs'] },
  }),
);
writeFileSync(
  path.join(historyPath, 'openclaw.plugin.json'),
  JSON.stringify({
    id: 'runtime-services',
    name: 'Independent history fixture',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
const planPath = path.join(bundledPath, 'plan-mode');
mkdirSync(planPath);
buildSync({
  absWorkingDir: repoRoot,
  entryPoints: ['openclaw-extensions/plan-mode/index.ts'],
  outfile: path.join(planPath, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['openclaw/plugin-sdk/*'],
});
writeFileSync(
  path.join(planPath, 'package.json'),
  JSON.stringify({ name: 'plan-mode', type: 'module', openclaw: { extensions: ['./index.mjs'] } }),
);
copyFileSync(
  'openclaw-extensions/plan-mode/openclaw.plugin.json',
  path.join(planPath, 'openclaw.plugin.json'),
);
const cfg = {
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: {
    ownership: 'explicit',
    entries: { alice: {}, bob: {}, carol: {}, dave: {}, erin: {}, frank: {} },
    defaults: {
      maxConcurrent: 6,
      workspace,
      skipBootstrap: true,
      heartbeat: { every: '0m' },
      systemAgent: { agentId: 'alice' },
      model: { primary: 'fixture/answer' },
      models: { 'fixture/answer': { agentRuntime: { id: 'openclaw' } } },
      blockStreamingDefault: 'off',
    },
  },
  models: {
    mode: 'replace',
    catalogRefresh: { enabled: false },
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: 'synthetic-probe-key',
        api: 'openai-completions',
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: 'answer',
            name: 'Fixture',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 1024,
          },
        ],
      },
    },
  },
  broadcast: { strategy: 'parallel' },
  tools: { profile: 'coding', alsoAllow: ['message', 'team_discussion', 'task_assistants'] },
  session: { maintenance: { mode: 'warn', coldStorage: { enabled: false, afterDays: 30 } } },
  plugins: {
    slots: { memory: 'none' },
    allow: ['agent-team', 'runtime-services', 'plan-mode'],
    load: { paths: [pluginPath, historyPath, planPath] },
    entries: {
      'agent-team': { enabled: true },
      'runtime-services': { enabled: true },
      'plan-mode': { enabled: true },
    },
  },
};
const configPath = path.join(state, 'openclaw.json');
writeFileSync(configPath, JSON.stringify(cfg));
const env = {
  ...process.env,
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: '0',
  OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPath,
};
Object.assign(process.env, env);
const child = spawn(
  process.execPath,
  [
    path.join(runtime, 'gateway-launcher.cjs'),
    'gateway',
    'run',
    '--allow-unconfigured',
    '--port',
    String(port),
  ],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
);
let output = '';
child.stdout.on('data', chunk => {
  output += chunk;
});
child.stderr.on('data', chunk => {
  output += chunk;
});
let client;
let hostHandler;
let hostLifecycleObserver;
let nativeSourceRun;
let gatewayConnections = 0;
const watchdog = setTimeout(() => child.kill(), 360000);
try {
  const deadline = Date.now() + 45000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture Gateway exited: ${child.exitCode}`);
    try {
      healthy = (
        await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
      ).ok;
    } catch {
      // The disposable Gateway may still be starting its HTTP listener.
    }
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(healthy, 'fixture Gateway must become healthy');
  // Existing packaged-runtime smoke harness uses this same client discovery.
  // It is test-only; production adapters import only public plugin SDK exports.
  const clientFile = readdirSync(path.join(runtime, 'dist')).find(
    file =>
      /^client-.*\.mjs$/.test(file) &&
      readFileSync(path.join(runtime, 'dist', file), 'utf8').includes('GatewayClient as t'),
  );
  assert.ok(clientFile);
  const { t: GatewayClient } = await import(pathToFileURL(path.join(runtime, 'dist', clientFile)));
  const hello = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture handshake timed out')), 15000);
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.admin'],
      onEvent: event => {
        if (event.event === 'agent') hostLifecycleObserver?.(event.payload);
        if (event.event === 'plugin.agent-team.requested' && hostHandler) {
          nativeSourceRun = event.payload.sourceRunId;
          void hostHandler(event.payload);
        }
      },
      onHelloOk: result => {
        gatewayConnections++;
        clearTimeout(timeout);
        resolve(result);
      },
      onConnectError: error => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    client.start();
  });
  assert.ok(hello.features.methods.includes('teamProbe.run'), 'packaged SDK plugin must register');
  for (const agentId of ['alice', 'bob']) {
    const prepared = await client.request('sessions.create', {
      key: `agent:${agentId}:justdo-team:group:fixture`,
      cwd: project,
      permissionMode: 'read-only',
    });
    assert.equal(prepared.entry.sessionRoot, project);
    assert.equal(prepared.entry.permissionMode, 'read-only');
  }
  const result = await client.request('teamProbe.run', {}, { timeoutMs: 45000 });
  assert.equal(modelRequests, 4);
  assert.equal(result.executions.length, 2);
  assert.equal(result.references.length, 2);
  const toolResults = toolObservations
    .filter(item => item.results)
    .map(item => JSON.stringify(item.results));
  assert.equal(toolResults.length, 2);
  assert.ok(
    toolResults.every(
      text => text.includes('ROOM_PROJECT_MARKER') && !text.includes('WRONG_AGENT_WORKSPACE'),
    ),
    'all participants must read from the room project',
  );
  const beforeCommand = modelRequests;
  await assert.rejects(
    client.request('teamProbe.run', { message: '/reset' }, { timeoutMs: 10000 }),
    /teamDiscussionCommandsUnavailable/,
  );
  assert.equal(modelRequests, beforeCommand);
  const history = await client.request('teamDiscussion.history', {
    roomId: 'fixture',
    discussionIds: ['fixture-discussion'],
    members: result.executions.map(execution => ({
      agentId: execution.agentId,
      sessionId: execution.sessionId,
    })),
  });
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(history.messages.filter(message => message.role === 'assistant').length, 2);
  for (const reference of result.references)
    assert.ok(
      history.messages.some(message => message.id === `${reference.agentId}:${reference.entryId}`),
    );
  const prepared = await client.request('teamDiscussion.prepare', {
    roomId: 'service',
    agentIds: ['alice', 'bob'],
    cwd: project,
    permissionMode: 'ask',
  });
  const serviceRoom = {
    id: 'service',
    title: 'Service',
    members: prepared.members.map(member => ({ ...member, name: member.agentId })),
    rounds: 1,
    revision: 1,
    generation: 0,
    state: 'ready',
    cwd: project,
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
  const serviceInput = {
    room: serviceRoom,
    send: {
      roomId: 'service',
      requestId: 'service-request',
      expectedRevision: 1,
      message: 'Service fixture answer.',
      selectedAgentIds: [],
      rounds: 1,
    },
    discussionId: 'service-discussion',
    members: prepared.members,
  };
  await client.request('teamDiscussion.start', serviceInput);
  let receipt;
  const serviceDeadline = Date.now() + 20000;
  do {
    receipt = await client.request('teamDiscussion.status', {
      roomId: 'service',
      discussionId: 'service-discussion',
    });
    if (receipt.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < serviceDeadline);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.executions.length, 2);
  const afterService = modelRequests;
  await client.request('teamDiscussion.start', serviceInput);
  assert.equal(modelRequests, afterService, 'replaying admission must not call models');
  const cancelled = await client.request('teamDiscussion.stop', {
    roomId: 'service',
    discussionId: 'cancel-before-start',
  });
  assert.equal(cancelled.state, 'cancelled');
  await client.request('teamDiscussion.start', {
    ...serviceInput,
    discussionId: 'cancel-before-start',
  });
  assert.equal(modelRequests, afterService, 'late admission after stop must remain cancelled');
  const messageMembers = await client.request('teamDiscussion.prepare', {
    roomId: 'message-room',
    agentIds: ['alice', 'bob'],
    cwd: project,
    permissionMode: 'full',
    readOnly: false,
  });
  const messageRoom = {
    ...serviceRoom,
    id: 'message-room',
    permissionMode: 'full',
    readOnly: false,
    members: messageMembers.members.map(member => ({ ...member, name: member.agentId })),
  };
  await client.request('teamDiscussion.start', {
    room: messageRoom,
    members: messageMembers.members,
    discussionId: 'message-discussion',
    send: {
      roomId: 'message-room',
      requestId: 'message-request',
      expectedRevision: 1,
      message: 'MESSAGE_TOOL_FIXTURE',
      selectedAgentIds: ['alice'],
      rounds: 1,
    },
  });
  const messageDeadline = Date.now() + 20000;
  do {
    receipt = await client.request('teamDiscussion.status', {
      roomId: 'message-room',
      discussionId: 'message-discussion',
    });
    if (receipt.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < messageDeadline);
  assert.equal(receipt.state, 'completed');
  const messageHistory = await client.request('teamDiscussion.history', {
    roomId: 'message-room',
    discussionIds: ['message-discussion'],
    members: messageMembers.members.map(member => ({
      agentId: member.agentId,
      sessionId: member.sessionId,
    })),
  });
  assert.ok(
    messageHistory.messages.some(
      message => message.role === 'assistant' && message.text === 'Outbound fixture message',
    ),
    'message-tool output must enter the public native history',
  );
  await client.request('teamProbe.run', { hold: true });
  const holdDeadline = Date.now() + 15000;
  while (!heldRequests && Date.now() < holdDeadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(heldRequests, 'native model execution must start before cancellation');
  const stopped = await client.request('teamProbe.stop', {}, { timeoutMs: 15000 });
  assert.equal(stopped.stopped, true);
  assert.ok(heldRequests <= 2, 'cancellation must prevent a second group round');
  // Public production dispatcher limiter: real native runs, tools, late settled events and multiple rounds.
  for (const capacity of skipConcurrencyMatrix ? [] : [1, 2, 6]) {
    const roomId = `limited-${capacity}`;
    const preparedLimit = await client.request('teamDiscussion.prepare', {
      roomId,
      agentIds:
        capacity === 6
          ? ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']
          : ['alice', 'bob', 'carol'],
      cwd: project,
      permissionMode: 'ask',
    });
    const roomLimit = {
      ...serviceRoom,
      id: roomId,
      members: preparedLimit.members.map(member => ({ ...member, name: member.agentId })),
    };
    await startTracking();
    await client.request('teamDiscussion.start', {
      room: roomLimit,
      members: preparedLimit.members,
      discussionId: roomId,
      resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 5, maxConcurrent: capacity },
      send: {
        roomId,
        requestId: roomId,
        expectedRevision: 1,
        message: 'LIMIT_NATIVE_FIXTURE: discuss the project marker in two rounds.',
        selectedAgentIds: [],
        rounds: 2,
      },
    });
    const deadlineLimit = Date.now() + 60000;
    let limited;
    do {
      limited = await client.request('teamDiscussion.status', { roomId, discussionId: roomId });
      if (limited.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadlineLimit);
    assert.equal(limited.state, 'completed');
    await checkTracking(capacity, 5);
    assert.equal(limited.executions.length, 5);
  }
  const heldBeforeLimit = heldRequests;
  const cancelledMembers = (
    await client.request('teamDiscussion.prepare', {
      roomId: 'limited-1',
      agentIds: ['alice', 'bob'],
      cwd: project,
      permissionMode: 'ask',
    })
  ).members;
  await startTracking();
  await client.request('teamDiscussion.start', {
    room: {
      ...serviceRoom,
      id: 'limited-1',
      members: cancelledMembers.map(member => ({ ...member, name: member.agentId })),
    },
    members: cancelledMembers,
    discussionId: 'limited-cancel',
    resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 4, maxConcurrent: 1 },
    send: {
      roomId: 'limited-1',
      requestId: 'limited-cancel',
      expectedRevision: 1,
      message: 'HOLD_FIXTURE',
      selectedAgentIds: [],
      rounds: 2,
    },
  });
  const waitLimit = Date.now() + 15000;
  while (heldRequests === heldBeforeLimit && Date.now() < waitLimit)
    await new Promise(resolve => setTimeout(resolve, 100));
  let cancelledLimit = await client.request(
    'teamDiscussion.stop',
    { roomId: 'limited-1', discussionId: 'limited-cancel' },
    { timeoutMs: 15000 },
  );
  const cancelledDeadline = Date.now() + 15000;
  while (cancelledLimit.state === 'unknown' && Date.now() < cancelledDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    cancelledLimit = await client.request('teamDiscussion.status', {
      roomId: 'limited-1',
      discussionId: 'limited-cancel',
    });
  }
  assert.equal(
    cancelledLimit.state,
    'cancelled',
    'late whole-run abort evidence must settle the initially unknown stop',
  );
  assert.equal(
    heldRequests - heldBeforeLimit,
    1,
    'waiting members must not launch after cancellation',
  );
  await checkTracking(1, 1);
  // Real model tool -> native identity hook -> product host coordinator -> native group.
  const hostBundle = path.join(state, 'host-coordinators.mjs');
  const electronStub = path.join(state, 'electron-stub.mjs');
  writeFileSync(electronStub, 'export const ipcMain={handle(){}};');
  buildSync({
    absWorkingDir: repoRoot,
    stdin: {
      contents:
        "export {AgentTeamSettingsService} from './src/main/plugins/extensions/agentTeamSettingsService'; export {TeamDiscussionCoordinator} from './src/main/ipc/cowork/agent-team/teamDiscussion'; export {CollaborationCoordinator} from './src/main/ipc/cowork/agent-team/collaboration'; export {initializeTeamDiscussionTables} from './src/main/data/agent-team/teamDiscussionStore'; export {initializeCollaborationTables,CollaborationStore} from './src/main/data/agent-team/collaborationStore';",
      resolveDir: repoRoot,
    },
    outfile: hostBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    alias: { electron: electronStub },
  });
  const host = await import(pathToFileURL(hostBundle));
  const hostDb = new DatabaseSync(':memory:');
  hostDb.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    CREATE TABLE agents(id TEXT PRIMARY KEY,enabled INTEGER);
    CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT);
    INSERT INTO agents VALUES('alice',1),('bob',1),('carol',1);
    INSERT INTO cowork_sessions VALUES('organizer','alice','idle'),('review-source','alice','idle'),('review-worker','bob','idle'),('review-peer','carol','idle');`);
  const database = {
    pragma: sql => hostDb.prepare('PRAGMA ' + sql).all(),
    exec: sql => hostDb.exec(sql),
    prepare: sql => hostDb.prepare(sql),
    transaction: fn => () => {
      hostDb.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        hostDb.exec('COMMIT');
        return result;
      } catch (error) {
        hostDb.exec('ROLLBACK');
        throw error;
      }
    },
  };
  host.initializeTeamDiscussionTables(database);
  host.initializeCollaborationTables(database);
  const reviewProfiles = {
    'review-source': 'alice',
    'review-worker': 'bob',
    'review-peer': 'carol',
  };
  const hostStore = {
    getSession: id =>
      id === 'organizer'
        ? { id, agentId: 'alice', cwd: project, permissionMode: 'ask' }
        : reviewProfiles[id]
          ? { id, agentId: reviewProfiles[id], cwd: project, permissionMode: 'ask' }
          : undefined,
    getAgent: id => ({ id, name: id, enabled: true }),
    listAgents: () => ['alice', 'bob', 'carol'].map(id => ({ id, name: id, enabled: true })),
    getSessionRuns: () => [{ rootRunId: nativeSourceRun, state: 'running' }],
  };
  const requestGateway = (method, params) => client.request(method, params, { timeoutMs: 45000 });
  const discussionHost = new host.TeamDiscussionCoordinator({
    getDatabase: () => database,
    getStore: () => hostStore,
    ensureReady: async () => {},
    requestGateway,
    requestConnectedGateway: requestGateway,
    onChanged: () => {},
  });
  const collaborationHost = new host.CollaborationCoordinator({
    getDatabase: () => database,
    getStore: () => hostStore,
    getRouter: () => ({}),
    getRuntime: () => null,
    requestGateway,
    discussion: (...args) => discussionHost.fromAgent(...args),
  });
  hostHandler = payload => collaborationHost.handle(payload);
  hostLifecycleObserver = payload => collaborationHost.observeExecution(payload);
  await client.request('sessions.create', {
    key: 'agent:alice:justdo:organizer',
    cwd: project,
    permissionMode: 'guarded',
  });
  const launchSource = (
    await client.request('teamDiscussion.summary', {
      operation: 'source',
      sessionKey: 'agent:alice:justdo:organizer',
    })
  ).source;
  await client.request('agentTeam.launch.register', {
    expectedGeneration: 0,
    sessionKey: 'agent:alice:justdo:organizer',
    nativeSessionId: launchSource.sessionId,
    lifecycleRevision: launchSource.lifecycleRevision ?? null,
    clientTurnId: 'organizer-request',
    promptSha256: createHash('sha256').update('ORGANIZE_TEAM_FIXTURE').digest('hex'),
    mode: 'discussion',
  });
  await client.request(
    'chat.send',
    {
      sessionKey: 'agent:alice:justdo:organizer',
      message: 'ORGANIZE_TEAM_FIXTURE',
      idempotencyKey: 'organizer-request',
    },
    { timeoutMs: 15000 },
  );
  let organized;
  const organizedDeadline = Date.now() + 60000;
  while (Date.now() < organizedDeadline) {
    const room = discussionHost.metadata.list()[0];
    if (room) {
      organized = await discussionHost.read(room.id);
      if (organized.latestRun?.state === 'completed') break;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal(
    organized?.latestRun?.state,
    'completed',
    'a model tool must create and start the native discussion through Main',
  );
  assert.equal(organized.room.sourceSessionId, 'organizer');
  assert.equal(
    launchObservations.length,
    6,
    'all native discovery, read, policy, and create steps must run',
  );
  assert.ok(
    launchObservations[0].includes('# Agent team'),
    'native read must load the packaged instructions through the published skill link',
  );
  for (const index of [1, 2, 3])
    assert.ok(
      !launchObservations[index].includes('Explicit Agent Team launch is unconfirmed'),
      'native catalog controls and the allowed target must be admitted',
    );
  assert.ok(
    launchObservations[4].includes('Explicit Agent Team launch is unconfirmed'),
    'native tool_call must still gate its write target',
  );
  await client.request('agentTeam.launch.confirm', {
    sessionKey: 'agent:alice:justdo:organizer',
    nativeSessionId: launchSource.sessionId,
    clientTurnId: 'organizer-request',
    mode: 'discussion',
    receiptId: organized.latestRun.discussionId,
  });
  console.log(
    JSON.stringify({
      check: 'explicit-team-launch',
      nativeSkillPublished: true,
      catalogControls: true,
      innerWriteDenied: true,
      nativeGroupCreated: true,
    }),
  );
  assert.equal(
    organized.messages.filter(message => message.role === 'user').length,
    0,
    'organizer messages must not impersonate the user',
  );
  assert.equal(organized.messages.filter(message => message.role === 'assistant').length, 3);
  assert.ok(
    organizerNativeContexts >= 2,
    'both native members must receive assistant-attributed organizer context',
  );
  assert.ok(
    organizerContextChecks.every(check => check.sender && check.relay && check.authorization),
    'native model input must identify the assistant relay and its authorization boundary',
  );
  assert.ok(
    organized.room.summarySource?.sessionId,
    'Main must pin the original native source for automatic summaries',
  );
  const summaryDeadline = Date.now() + 20000;
  let summary;
  do {
    await discussionHost.reconcile();
    summary = discussionHost.metadata.summary(organized.latestRun.discussionId);
    if (summary?.state === 'delivered' || summary?.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < summaryDeadline);
  assert.equal(
    summary?.state,
    'delivered',
    'completed discussions must summarize in the original source',
  );
  const summaryHistory = await client.request('chat.history', {
    sessionKey: 'agent:alice:justdo:organizer',
  });
  assert.ok(JSON.stringify(summaryHistory).includes('TEAM_SUMMARY_COMPLETE'));
  const countAfterSummary = modelRequests;
  await discussionHost.reconcile();
  assert.equal(modelRequests, countAfterSummary, 'delivered summaries must not be resent');
  const settleRoomSummaries = async roomId => {
    const deadline = Date.now() + 30000;
    while (discussionHost.metadata.hasUnsettledSummary(roomId) && Date.now() < deadline) {
      await discussionHost.reconcile();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(
      discussionHost.metadata.hasUnsettledSummary(roomId),
      false,
      'room membership changes must wait for native summary settlement',
    );
  };
  const sourceKey = 'agent:alice:justdo:organizer';
  const teamSettings = new host.AgentTeamSettingsService(database);
  const defaultSettings = teamSettings.read();
  defaultSettings.value.discussion.maxConcurrent = 1;
  teamSettings.save(defaultSettings.value, defaultSettings.revision);
  const sourceBefore = await client.request('teamProbe.sessionPolicy', { key: sourceKey });
  const participating = await discussionHost.setParticipation({
    roomId: organized.room.id,
    expectedRevision: organized.room.revision,
    enabled: true,
  });
  assert.equal(participating.members.filter(member => member.ownership === 'source').length, 1);
  await startTracking();
  await discussionHost.send({
    roomId: participating.id,
    requestId: 'source-participation',
    expectedRevision: participating.revision,
    message: 'LIMIT_NATIVE_FIXTURE: discuss a second point with the organizer.',
    selectedAgentIds: [],
    rounds: 1,
  });
  let sourceRound;
  const participationDeadline = Date.now() + 25000;
  do {
    sourceRound = await discussionHost.read(participating.id);
    if (sourceRound.latestRun?.state === 'completed' || sourceRound.latestRun?.state === 'failed')
      break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < participationDeadline);
  assert.equal(
    sourceRound.latestRun?.state,
    'completed',
    'production source participation must settle',
  );
  await checkTracking(1, 3);
  await settleRoomSummaries(participating.id);
  assert.ok(
    sourceRound.messages.some(
      message =>
        message.discussionId === sourceRound.latestRun.discussionId &&
        message.agentId === 'alice' &&
        message.origin !== 'organizer',
    ),
    'original source must publish to the group',
  );
  const sourceAfter = await client.request('teamProbe.sessionPolicy', { key: sourceKey });
  assert.equal(
    sourceAfter.sessionId,
    sourceBefore.sessionId,
    'source participation must preserve native identity',
  );
  assert.deepEqual(
    sourceAfter.delivery,
    sourceBefore.delivery,
    'source participation must preserve canonical delivery',
  );
  await discussionHost.send({
    roomId: participating.id,
    requestId: 'source-only',
    expectedRevision: participating.revision,
    message: 'A direct question for the organizer.',
    selectedAgentIds: ['alice'],
    rounds: 1,
  });
  let directRound;
  const directDeadline = Date.now() + 25000;
  do {
    directRound = await discussionHost.read(participating.id);
    if (directRound.latestRun?.state === 'completed' || directRound.latestRun?.state === 'failed')
      break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < directDeadline);
  assert.equal(directRound.latestRun?.state, 'completed');
  await settleRoomSummaries(participating.id);
  assert.ok(
    directRound.messages.some(
      message =>
        message.discussionId === directRound.latestRun.discussionId &&
        message.role === 'user' &&
        message.text === 'A direct question for the organizer.',
    ),
    'source-only mentions retain the public question',
  );
  await discussionHost.setParticipation({
    roomId: participating.id,
    expectedRevision: participating.revision,
    enabled: false,
  });
  const afterDisable = await discussionHost.read(participating.id, undefined, [
    sourceRound.latestRun.discussionId,
  ]);
  assert.ok(
    afterDisable.messages.some(message => message.agentId === 'alice'),
    'public source replies survive opting out',
  );
  await discussionHost.stop(participating.id);
  await client.request('sessions.patch', { key: sourceKey, toolOverrides: { webSearch: false } });
  const restrictedDescription = await client.request('sessions.describe', { key: sourceKey });
  assert.equal(
    restrictedDescription.session.toolOverrides.webSearch,
    false,
    'source overrides must persist independently of global config',
  );
  const restrictedSource = await client.request('teamProbe.sessionPolicy', { key: sourceKey });
  assert.equal(restrictedSource.toolOverrides.webSearch, false);
  for (const action of ['create', 'send']) {
    await client.request('collaboration.bind', {
      sessionKey: sourceKey,
      runId: nativeSourceRun,
      toolCallId: `restricted-${action}`,
    });
    await assert.rejects(
      client.request('collaboration.dispatch', {
        operation: 'discussion',
        sessionKey: sourceKey,
        toolCallId: `restricted-${action}`,
        input: { action, roomId: organized.room.id },
      }),
      /teamDiscussionSourcePolicyUnsupported/,
    );
  }
  await client.request('sessions.patch', { key: sourceKey, toolOverrides: null });
  await client.request('sessions.pluginPatch', {
    key: sourceKey,
    pluginId: 'plan-mode',
    namespace: 'state',
    value: { enabled: true, updatedAt: Date.now() },
  });
  const plannedSource = await client.request('teamProbe.sessionPolicy', { key: sourceKey });
  assert.equal(
    plannedSource.planEnabled,
    true,
    'native getSessionEntry must retain the registered Plan slot used by collaboration',
  );
  await client.request('collaboration.bind', {
    sessionKey: sourceKey,
    runId: nativeSourceRun,
    toolCallId: 'planned-create',
  });
  await assert.rejects(
    client.request('collaboration.dispatch', {
      operation: 'discussion',
      sessionKey: sourceKey,
      toolCallId: 'planned-create',
      input: { action: 'create' },
    }),
    /Plan mode/,
  );
  assert.equal(
    discussionHost.metadata.list().length,
    1,
    'rejected source policies must never reach host room creation',
  );
  await client.request('sessions.delete', { key: sourceKey, deleteTranscript: true });
  // Native tool identity and whole-run terminals with the production review store.
  // Product room setup is explicit fixture metadata; model-driven recruitment is
  // covered separately, and this probe does not assess artifact/review quality.
  const reviewMetadata = new host.CollaborationStore(database);
  const reviewKey = id => `agent:${reviewProfiles[id]}:justdo:${id}`;
  for (const id of Object.keys(reviewProfiles))
    await client.request('sessions.create', {
      key: reviewKey(id),
      cwd: project,
      permissionMode: 'guarded',
    });
  reviewMetadata.createRoom({
    id: 'quality-room',
    anchorSessionId: 'review-source',
    members: Object.keys(reviewProfiles).map(sessionId => ({
      sessionId,
      agentId: reviewProfiles[sessionId],
      sessionKey: reviewKey(sessionId),
    })),
  });
  reviewMetadata.beginRound('quality-room', 'quality-batch');
  const startReviewPeer = async (id, message) => {
    const delivery = reviewMetadata.enqueue(
      'quality-room',
      'quality-batch',
      reviewKey('review-source'),
      id,
      'fixture-origin',
      { to: reviewProfiles[id], message },
    );
    reviewMetadata.transition(delivery.id, 'queued', 'dispatching');
    const accepted = await client.request(
      'chat.send',
      { sessionKey: reviewKey(id), message, idempotencyKey: id },
      { timeoutMs: 15000 },
    );
    assert.ok(accepted.runId, 'native admission must identify the actual peer run');
    reviewMetadata.transition(delivery.id, 'dispatching', 'accepted', accepted.runId);
    return delivery.id;
  };
  const workDeliveryId = await startReviewPeer(
    'review-worker',
    'Read the project marker and report the result.',
  );
  const workerDeadline = Date.now() + 20000;
  while (
    reviewMetadata.listDeliveries('quality-room').find(item => item.id === workDeliveryId)
      ?.executionOutcome !== 'completed' &&
    Date.now() < workerDeadline
  )
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(
    reviewMetadata.listDeliveries('quality-room')[0].executionOutcome,
    'completed',
    'worker completion requires real whole-run evidence',
  );
  reviewDeliveryIds = [workDeliveryId];
  const reviewDeliveryId = await startReviewPeer('review-peer', 'INDEPENDENT_REVIEW_FIXTURE');
  const reviewDeadline = Date.now() + 15000;
  while (
    (!reviewerFinishResponse || !reviewMetadata.reviews.list('quality-room').length) &&
    Date.now() < reviewDeadline
  )
    await new Promise(resolve => setTimeout(resolve, 100));
  const pendingReview = reviewMetadata.reviews.list('quality-room')[0];
  assert.ok(reviewerFinishResponse, 'native reviewer must continue after its report tool call');
  assert.deepEqual(pendingReview?.deliveryIds, [workDeliveryId]);
  assert.equal(pendingReview?.reviewDeliveryId, reviewDeliveryId);
  assert.equal(
    pendingReview?.state,
    'pending',
    'tool report success must not imply reviewer execution completion',
  );
  reviewerFinishResponse.end(
    `data: ${JSON.stringify({ id: 'review-finished', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'REVIEW_FINDINGS_NATIVE' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
  const reviewEndDeadline = Date.now() + 15000;
  while (
    reviewMetadata.reviews.list('quality-room')[0]?.state !== 'confirmed' &&
    Date.now() < reviewEndDeadline
  )
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(
    reviewMetadata.reviews.list('quality-room')[0]?.state,
    'confirmed',
    'only a successful exact native reviewer terminal confirms its report',
  );
  const reviewHistory = await client.request('chat.history', {
    sessionKey: reviewKey('review-peer'),
  });
  assert.ok(
    JSON.stringify(reviewHistory).includes('REVIEW_FINDINGS_NATIVE'),
    'review findings remain in native history',
  );
  const afterSourceDelete = await discussionHost.read(participating.id, undefined, [
    sourceRound.latestRun.discussionId,
  ]);
  assert.equal(afterSourceDelete.historyUnavailable, false);
  assert.ok(
    afterSourceDelete.messages.some(message => message.agentId === 'alice'),
    'public source replies survive source transcript deletion',
  );
  hostHandler = undefined;
  hostDb.close();
  const config = await client.request('config.get', {});
  await client.request('config.patch', {
    baseHash: config.hash,
    raw: JSON.stringify({ plugins: { entries: { 'agent-team': { enabled: false } } } }),
    restartDelayMs: 0,
  });
  let offlineReceipt;
  const disabledDeadline = Date.now() + 25000;
  while (Date.now() < disabledDeadline) {
    try {
      offlineReceipt = await client.request(
        'teamDiscussion.offlineControl',
        { operation: 'status', roomId: 'service', discussionId: 'service-discussion' },
        { timeoutMs: 2000 },
      );
      break;
    } catch {
      // Wait for the independent receipt service after plugin replacement.
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.equal(
    offlineReceipt?.state,
    'completed',
    'independent runtime services must reconcile receipts when Agent Team is disabled',
  );
  const disabledHistory = await client.request('teamDiscussion.history', {
    roomId: 'service',
    discussionIds: ['service-discussion'],
    members: prepared.members.map(member => ({
      agentId: member.agentId,
      sessionId: member.sessionId,
    })),
  });
  assert.equal(disabledHistory.messages.filter(message => message.role === 'assistant').length, 2);
  await assert.rejects(() => client.request('teamDiscussion.start', serviceInput));
  // Retain a disabled discovery source, then follow the application toggle's
  // native write -> skill sync -> safe restart ordering. Old discovery inputs
  // must not remove the enabled skill when another file watch refreshes later.
  const publishedSkill = path.join(state, 'plugin-skills/agent-team/SKILL.md');
  await client.request('skills.status', { agentId: 'alice' });
  assert.equal(existsSync(publishedSkill), false);
  const enableConfig = await client.request('config.get', {});
  await client.request('config.patch', {
    baseHash: enableConfig.hash,
    raw: JSON.stringify({ plugins: { entries: { 'agent-team': { enabled: true } } } }),
    restartDelayMs: 0,
  });
  await client.request('skills.update', { skillKey: 'agent-team', enabled: true });
  const connectionsBeforeRestart = gatewayConnections;
  await client.request('gateway.restart.request', {
    reason: 'extension-status-change',
    skipDeferral: false,
  });
  const restartDeadline = Date.now() + 45000;
  while (gatewayConnections === connectionsBeforeRestart && Date.now() < restartDeadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(gatewayConnections > connectionsBeforeRestart, 'safe native restart must reconnect');
  await client.request('skills.status', { agentId: 'alice' });
  assert.equal(existsSync(publishedSkill), true);
  const watchSkill = path.join(workspace, 'skills/publication-probe');
  mkdirSync(watchSkill, { recursive: true });
  for (let revision = 0; revision < 3; revision++) {
    writeFileSync(
      path.join(watchSkill, 'SKILL.md'),
      `---\nname: publication-probe\ndescription: Synthetic publication regression.\n---\n# Revision ${revision}\n`,
    );
    await new Promise(resolve => setTimeout(resolve, 1000));
    await client.request('skills.update', { skillKey: 'agent-team', enabled: true });
    assert.equal(existsSync(publishedSkill), true, 'refresh must retain the enabled native skill');
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        stateDirectory: state,
        modelRequests,
        executions: result.executions.length,
        references: result.references.length,
        projectReadVerified: true,
        commandsRejected: true,
        historyVerified: true,
        nativeCancellationVerified: true,
        productionServiceVerified: true,
        admissionReplayVerified: true,
        messageToolVerified: true,
        disabledHistoryVerified: true,
        modelOrganizedTeamVerified: true,
        nativeSkillPublicationAfterToggleVerified: true,
        organizerNativeContextsVerified: true,
        automaticSummaryVerified: true,
        sourceParticipationVerified: true,
        sourcePublicHistoryPreserved: true,
        organizerBotFlagProjected: organizerContextChecks.every(check => check.bot),
        restrictedSourceGuardVerified: true,
        nativePlanSlotGuardVerified: true,
        independentReviewIdentityVerified: true,
        pendingUntilNativeReviewTerminalVerified: true,
        scope: 'packaged Gateway with fixture model; not complete G1-G6 acceptance',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.stack ?? error.message);
  console.error(JSON.stringify({ modelRequests, toolObservations }));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  writeFileSync(path.join(state, 'probe.log'), output.replaceAll(token, '<fixture-token>'));
  if (client) {
    const stopTimeout = setTimeout(() => client.stop(), 3000);
    await Promise.race([
      client.stopAndWait().catch(() => client.stop()),
      new Promise(resolve => setTimeout(resolve, 3500)),
    ]);
    clearTimeout(stopTimeout);
  }
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.connected) child.send('stop');
    else child.kill();
    const forceStop = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(forceStop);
  }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  writeFileSync(path.join(state, 'probe.log'), output.replaceAll(token, '<fixture-token>'));
  console.log(`Fixture log: ${path.join(state, 'probe.log')}`);
}
