import probePaths from '../probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
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
  renameSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { buildSync } = hostRequire("esbuild");

const gatewayBundleLauncher = hostRequire(path.join(hostRoot, 'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'));

const repoRoot = hostRoot;
const runtimeSource = path.resolve(
  process.argv.slice(2).find(value => !value.startsWith('--')) ??
    path.join(repoRoot, 'vendor/openclaw-runtime/current'),
);
// Narrow launch regressions can omit the already independent capacity matrix.
const skipConcurrencyMatrix = process.argv.includes('--skip-concurrency-matrix');
const historyToggleOnly = process.argv.includes('--history-toggle-only');
const coldStartOnly = process.argv.includes('--cold-start-only');
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-team-gateway-'));
// Native watches admit the config directory's parent and each workspace's
// parent. Keep those authorities private, as in the desktop layout: a config
// directly under fixtureRoot would observe the shared OS temp directory, and
// a project directly under state would observe SQLite, logs and runtime I/O.
const state = path.join(fixtureRoot, 'gateway-state');
const workspace = path.join(state, 'agent-workspaces');
const project = path.join(fixtureRoot, 'projects', 'room');
mkdirSync(state);
mkdirSync(path.dirname(project));
// Isolated package layout preserves genuine bundled-plugin provenance without
// modifying the installed runtime or bypassing native plugin trust checks.
const runtime = path.join(fixtureRoot, 'runtime');
mkdirSync(runtime);
for (const entry of readdirSync(runtimeSource, { withFileTypes: true })) {
  if (entry.name === 'dist') continue;
  const source = path.join(runtimeSource, entry.name),
    target = path.join(runtime, entry.name);
  if (statSync(source).isDirectory()) symlinkSync(source, target, 'junction');
  else copyFileSync(source, target);
}
mkdirSync(path.join(runtime, 'dist'));
for (const entry of readdirSync(path.join(runtimeSource, 'dist'), { withFileTypes: true })) {
  if (entry.name === 'extensions') continue;
  const source = path.join(runtimeSource, 'dist', entry.name),
    target = path.join(runtime, 'dist', entry.name);
  // Native public surfaces must remain physically inside this isolated package;
  // 10.4 correctly rejects dist junctions escaping the owning runtime root.
  if (entry.isDirectory()) cpSync(source, target, { recursive: true });
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
const startTracking = async () => requestTeam('teamProbe.metrics', { reset: true });
async function checkTracking(limit, count) {
  const metrics = await requestTeam('teamProbe.metrics', {});
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
const lifecycleObservations = [];
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
    const senders = mainBinding.readConversationSenders(body.messages);
    organizerContextChecks.push({
      request: modelRequests,
      relayRoles: body.messages
        .filter(message =>
          JSON.stringify(message.content).includes(
            'The initiating message is relayed by the organizing assistant',
          ),
        )
        .map(message => message.role),
      sender: senders.some(sender => sender.id === 'agent:alice'),
      bot: senders.some(sender => sender.id === 'agent:alice' && sender.isBot),
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
        `data: ${JSON.stringify({ id: 'message-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'message-send', type: 'function', function: { name: 'tool_call', arguments: JSON.stringify({ id: 'message', args: { action: 'send', channel: 'agent-team', target: 'message-room', message: 'Outbound fixture message' } }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
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
  entryPoints: [path.join(pluginRoot, 'tests/fixtures/agent-team-probe.ts')],
  alias: { '@app-plugin/sdk/native': path.join(hostRoot, 'plugins/sdk/app-plugin-sdk/native.ts') },
  outfile: path.join(pluginPath, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['openclaw/plugin-sdk/*'],
});
mkdirSync(path.join(pluginPath, 'skills/agent-team'), { recursive: true });
copyFileSync(
  path.join(pluginRoot, 'skills/agent-team/SKILL.md'),
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
        path.join(pluginRoot, 'openclaw.plugin.json'),
        'utf8',
      ),
    ),
    id: 'agent-team',
    name: 'Integration fixture',
    channels: ['agent-team'],
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
const runtimeServicesPath = path.join(bundledPath, 'runtime-services');
mkdirSync(runtimeServicesPath);
buildSync({
  absWorkingDir: repoRoot,
  entryPoints: ['tests/openclaw/fixtures/team-runtime-services-probe.ts'],
  outfile: path.join(runtimeServicesPath, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['openclaw/plugin-sdk/*'],
});
writeFileSync(
  path.join(runtimeServicesPath, 'package.json'),
  JSON.stringify({
    name: 'runtime-services',
    type: 'module',
    openclaw: { extensions: ['./index.mjs'] },
  }),
);
writeFileSync(
  path.join(runtimeServicesPath, 'openclaw.plugin.json'),
  JSON.stringify({
    id: 'runtime-services',
    name: 'Independent runtime services fixture',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
const planPath = path.join(bundledPath, 'plan-mode');
mkdirSync(planPath);
buildSync({
  absWorkingDir: repoRoot,
  entryPoints: ['plugins/extensions/plan-mode/index.ts'],
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
  'plugins/extensions/plan-mode/openclaw.plugin.json',
  path.join(planPath, 'openclaw.plugin.json'),
);
const cfg = {
  logging: { file: path.join(state, 'native.log'), level: 'debug', consoleLevel: 'info' },
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
  update: { checkOnStart: false, auto: { enabled: false } },
  agents: {
    ownership: 'explicit',
    // The narrow history check does not exercise the six-member capacity matrix.
    entries: Object.fromEntries(
      (historyToggleOnly
        ? ['alice', 'bob']
        : ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']
      ).map(agentId => [agentId, { workspace: path.join(workspace, agentId) }]),
    ),
    defaults: {
      maxConcurrent: 6,
      workspace: path.join(workspace, 'alice'),
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
    load: { paths: [pluginPath, runtimeServicesPath, planPath] },
    entries: {
      'agent-team': { enabled: true },
      'runtime-services': { enabled: true },
      'plan-mode': { enabled: true },
    },
  },
};
const configPath = path.join(state, 'openclaw.json');
writeFileSync(configPath, JSON.stringify(cfg));
const mainBindingPath = path.join(state, 'main-plugin-binding.mjs');
buildSync({
  absWorkingDir: repoRoot,
  stdin: {
    contents: `export { bindPluginGatewayClient, runWithPluginRequestBinding }
      from './src/main/engine/gateway/pluginRequestBinding';
      export { isAppNativeHandshake } from './plugins/sdk/app-plugin-sdk/native-contract';
      export { readConversationSenders } from ${JSON.stringify(path.join(pluginRoot, "tests/fixtures/agent-team-model-context.ts"))};
      export { buildGatewayLaunchEnvironment } from './src/main/openclaw/runtime/launch/gatewayLaunchArgs';`,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  outfile: mainBindingPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const mainBinding = await import(pathToFileURL(mainBindingPath));
// Exercise the desktop launch policy, including its Windows filesystem watcher
// configuration, rather than an independently maintained environment.
const env = {
  ...mainBinding.buildGatewayLaunchEnvironment(
    gatewayBundleLauncher.buildOpenClawCompileCacheEnvironment(
      process.env,
      path.join(state, '.compile-cache'),
    ),
    { appStartedAtMs: Date.now(), stateDir: state },
  ),
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_RESPAWN: '1',
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: '0',
  OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPath,
  OPENCLAW_DEBUG: '1',
};
Object.assign(process.env, env);
const child = spawn(
  process.execPath,
  [
    path.join(
      runtime,
      existsSync(path.join(runtime, 'gateway-launcher.cjs'))
        ? 'gateway-launcher.cjs'
        : 'openclaw.mjs',
    ),
    'gateway',
    'run',
    '--allow-unconfigured',
    '--port',
    String(port),
  ],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
);
const childClosed = new Promise(resolve => child.once('close', resolve));
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
let appBinding;
const appClient = mainBinding.bindPluginGatewayClient({
  request: (...args) => client.request(...args),
});
function withAppBinding(operation) {
  const admitted = appBinding;
  return mainBinding.runWithPluginRequestBinding(
    admitted,
    () =>
      assert.equal(appBinding, admitted, 'the admitted Native registration must remain current'),
    operation,
  );
}
function requestTeam(method, params, options) {
  return withAppBinding(() => appClient.request(method, params, options));
}
async function awaitAppNativeRegistration() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const receipt = await client.request('agent-team.app.handshake', {}, { timeoutMs: 2000 });
      assert.ok(mainBinding.isAppNativeHandshake(receipt));
      assert.equal(receipt.pluginId, 'agent-team');
      appBinding = {
        pluginId: receipt.pluginId,
        registrationId: receipt.registrationId,
        processId: receipt.processId,
        gatewayMethods: receipt.gatewayMethods,
      };
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('Native config must settle before plugin execution');
}
const watchdog = setTimeout(() => child.kill(), 360000);
async function verifySkillDiscovery() {
  const skillPath = path.join(state, 'skills/polling-probe');
  await client.request('skills.status', { agentId: 'alice' });
  mkdirSync(skillPath, { recursive: true });
  for (let revision = 0; revision < 3; revision++) {
    const description = `Synthetic polling revision ${revision}.`;
    const startedAt = performance.now();
    writeFileSync(
      path.join(skillPath, 'SKILL.md'),
      `---\nname: polling-probe\ndescription: ${description}\n---\n# Polling probe\n`,
    );
    let found = false;
    do {
      const report = await client.request(
        'skills.status',
        { agentId: 'alice' },
        { timeoutMs: 5000 },
      );
      found = report.skills.some(
        skill => skill.name === 'polling-probe' && skill.description === description,
      );
      if (found) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (performance.now() - startedAt < 5000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    assert.ok(
      found && elapsedMs < 5000,
      'skill file changes must remain discoverable within the UI refresh window',
    );
    console.log(JSON.stringify({ check: 'native-skill-file-discovery', revision, elapsedMs }));
  }
  const retiredPath = path.join(state, 'retired-polling-probe');
  renameSync(skillPath, retiredPath);
  const deletedAt = performance.now();
  let removed = false;
  do {
    const report = await client.request('skills.status', { agentId: 'alice' }, { timeoutMs: 5000 });
    removed = !report.skills.some(skill => skill.name === 'polling-probe');
    if (removed) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (performance.now() - deletedAt < 5000);
  assert.ok(
    removed && performance.now() - deletedAt < 5000,
    'atomic skill removal must remain available while Gateway watches the directory',
  );
  console.log(
    JSON.stringify({
      check: 'native-skill-atomic-removal',
      elapsedMs: Math.round(performance.now() - deletedAt),
    }),
  );
}
async function verifyHistoryToggle(serviceInput, members) {
  const historyInput = {
    roomId: 'service',
    discussionIds: ['service-discussion'],
    members: members.map(member => ({ agentId: member.agentId, sessionId: member.sessionId })),
  };
  const originalHistory = await requestTeam('teamDiscussion.history', historyInput);
  assert.equal(originalHistory.messages.filter(message => message.role === 'assistant').length, 2);
  const collaborationHistoryInput = {
    lookups: [
      {
        deliveryId: 'history-availability',
        receiptId: 'absent-receipt',
        sessionId: 'history-probe',
        sessionKey: 'agent:alice:justdo:history-probe',
        sourceSessionKey: 'agent:bob:justdo:source-probe',
      },
    ],
  };
  const missingReceipt = { messages: [{ deliveryId: 'history-availability' }] };
  assert.deepEqual(
    await requestTeam('collaboration.messages', collaborationHistoryInput),
    missingReceipt,
  );
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
  await assert.rejects(() => requestTeam('teamDiscussion.history', historyInput));
  await assert.rejects(() => requestTeam('collaboration.messages', collaborationHistoryInput));
  await assert.rejects(() => requestTeam('teamDiscussion.start', serviceInput));
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
  await awaitAppNativeRegistration();
  const restoredHistory = await requestTeam('teamDiscussion.history', historyInput);
  assert.equal(restoredHistory.messages.filter(message => message.role === 'assistant').length, 2);
  assert.deepEqual(restoredHistory.messages, originalHistory.messages);
  assert.deepEqual(
    await requestTeam('collaboration.messages', collaborationHistoryInput),
    missingReceipt,
  );
  await client.request('skills.status', { agentId: 'alice' });
  assert.equal(existsSync(publishedSkill), true);
  const watchSkill = path.join(workspace, 'alice', 'skills/publication-probe');
  mkdirSync(watchSkill, { recursive: true });
  for (let revision = 0; revision < 3; revision++) {
    const description = `Synthetic publication regression ${revision}.`;
    writeFileSync(
      path.join(watchSkill, 'SKILL.md'),
      `---\nname: publication-probe\ndescription: ${description}\n---\n# Revision ${revision}\n`,
    );
    const refreshDeadline = Date.now() + 5000;
    let refreshed = false;
    do {
      const report = await client.request('skills.status', { agentId: 'alice' });
      refreshed = report.skills.some(
        skill => skill.name === 'publication-probe' && skill.description === description,
      );
      if (refreshed) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < refreshDeadline);
    assert.ok(refreshed, 'native workspace watch must observe the exact skill revision');
    await client.request('skills.update', { skillKey: 'agent-team', enabled: true });
    assert.equal(existsSync(publishedSkill), true, 'refresh must retain the enabled native skill');
  }
}
async function runChecks() {
  let coldResult;
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
  // Match the public Native SDK used by the managed desktop backend; chunk
  // names and minified export aliases are not a runtime contract.
  const { GatewayClient } = await import(
    pathToFileURL(path.join(runtime, 'dist/plugin-sdk/gateway-runtime.js')).href
  );
  assert.equal(typeof GatewayClient, 'function', 'Prepared runtime exposes public GatewayClient');
  const hello = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture handshake timed out')), 15000);
    client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: 'gateway-client',
      role: 'operator',
      mode: 'backend',
      scopes: ['operator.admin'],
      // Match the managed desktop backend: its loopback token authenticates
      // this connection without opening a second native state writer in Main.
      deviceIdentity: null,
      sharedStateMode: 'read-only',
      onEvent: event => {
        if (event.event === 'agent' && event.payload.stream === 'lifecycle') {
          const { runId, sessionKey, sessionId, data } = event.payload;
          lifecycleObservations.push({ runId, sessionKey, sessionId, data });
        }
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
  // HELLO precedes completion of Native config activation. Use the same public
  // read-only admission receipt as Main. Do not prewarm skills or models.
  await awaitAppNativeRegistration();
  if (!historyToggleOnly) {
    // Keep the independent tool/CWD/command matrix and its original 30s/45s
    // limits in the full probe, outside the history registration check.
    const coldMembers = new Map();
    for (const agentId of ['alice', 'bob']) {
      const prepared = await client.request('sessions.create', {
        key: `agent:${agentId}:agent-team:group:fixture`,
        cwd: project,
        permissionMode: 'read-only',
      });
      assert.equal(prepared.entry.sessionRoot, project);
      assert.equal(prepared.entry.permissionMode, 'read-only');
      coldMembers.set(agentId, prepared.entry);
    }
    const coldStartedAt = performance.now();
    const result = await requestTeam('teamProbe.run', {}, { timeoutMs: 45000 });
    coldResult = result;
    const coldElapsedMs = Math.round(performance.now() - coldStartedAt);
    assert.ok(
      coldElapsedMs < 30000,
      'cold tool execution and delivery must fit the original budget',
    );
    assert.deepEqual(
      result.outcomes.toSorted((a, b) => a.agentId.localeCompare(b.agentId)),
      [
        { agentId: 'alice', outcome: 'completed' },
        { agentId: 'bob', outcome: 'completed' },
      ],
    );
    for (const execution of result.executions) {
      const member = coldMembers.get(execution.agentId);
      assert.ok(member, 'execution must belong to a prepared member');
      assert.equal(execution.sessionId, member.sessionId);
      assert.equal(execution.lifecycleRevision, member.lifecycleRevision);
      assert.equal(execution.sessionKey, `agent:${execution.agentId}:agent-team:group:fixture`);
      assert.ok(execution.runId);
    }
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
      requestTeam('teamProbe.run', { message: '/reset' }, { timeoutMs: 10000 }),
      /teamDiscussionCommandsUnavailable/,
    );
    assert.equal(modelRequests, beforeCommand);
    const history = await requestTeam('teamDiscussion.history', {
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
        history.messages.some(
          message => message.id === `${reference.agentId}:${reference.entryId}`,
        ),
      );
    console.log(
      JSON.stringify({
        check: 'cold-team-tool-cwd',
        elapsedMs: coldElapsedMs,
        abortBudgetMs: 30000,
        rpcBudgetMs: 45000,
        completed: result.outcomes.length,
        delivered: result.references.length,
      }),
    );
    // The cold-only proof ends at native tool execution and history delivery.
    // Workspace skill watching is a separate matrix with its own refresh contract.
    if (coldStartOnly) return;
    await verifySkillDiscovery();
  }
  const prepared = await requestTeam('teamDiscussion.prepare', {
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
  const admittedAt = Date.now();
  await requestTeam('teamDiscussion.start', serviceInput);
  if (historyToggleOnly)
    console.log(
      JSON.stringify({ check: 'bound-product-start-accepted', elapsedMs: Date.now() - admittedAt }),
    );
  let receipt;
  const serviceDeadline = Date.now() + (historyToggleOnly ? 90000 : 20000);
  do {
    receipt = await requestTeam('teamDiscussion.status', {
      roomId: 'service',
      discussionId: 'service-discussion',
    });
    if (receipt.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < serviceDeadline);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.executions.length, 2);
  for (const execution of receipt.executions) {
    const member = prepared.members.find(item => item.agentId === execution.agentId);
    assert.ok(member);
    assert.equal(execution.sessionId, member.sessionId);
    assert.equal(execution.lifecycleRevision, member.lifecycleRevision);
    assert.equal(execution.outcome, 'completed');
  }
  const afterService = modelRequests;
  await requestTeam('teamDiscussion.start', serviceInput);
  assert.equal(modelRequests, afterService, 'replaying admission must not call models');
  if (historyToggleOnly) {
    await verifyHistoryToggle(serviceInput, prepared.members);
    console.log(
      JSON.stringify({
        ok: true,
        disabledHistoryUnavailableVerified: true,
        reenabledHistoryPreservedVerified: true,
        disabledReceiptReconciliationVerified: true,
        scope: 'isolated Gateway history registration and toggle checks',
      }),
    );
    return;
  }
  const cancelled = await requestTeam('teamDiscussion.stop', {
    roomId: 'service',
    discussionId: 'cancel-before-start',
  });
  assert.equal(cancelled.state, 'cancelled');
  await requestTeam('teamDiscussion.start', {
    ...serviceInput,
    discussionId: 'cancel-before-start',
  });
  assert.equal(modelRequests, afterService, 'late admission after stop must remain cancelled');
  const messageMembers = await requestTeam('teamDiscussion.prepare', {
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
  await requestTeam('teamDiscussion.start', {
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
    receipt = await requestTeam('teamDiscussion.status', {
      roomId: 'message-room',
      discussionId: 'message-discussion',
    });
    if (receipt.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < messageDeadline);
  assert.equal(receipt.state, 'completed');
  const messageHistory = await requestTeam('teamDiscussion.history', {
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
  await requestTeam('teamProbe.run', { hold: true });
  const holdDeadline = Date.now() + 15000;
  while (!heldRequests && Date.now() < holdDeadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(heldRequests, 'native model execution must start before cancellation');
  const stopped = await requestTeam('teamProbe.stop', {}, { timeoutMs: 15000 });
  assert.equal(stopped.stopped, true);
  assert.ok(heldRequests <= 2, 'cancellation must prevent a second group round');
  // Public production dispatcher limiter: real native runs, tools, late settled events and multiple rounds.
  for (const capacity of skipConcurrencyMatrix ? [] : [1, 2, 6]) {
    const roomId = `limited-${capacity}`;
    const preparedLimit = await requestTeam('teamDiscussion.prepare', {
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
    await requestTeam('teamDiscussion.start', {
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
      limited = await requestTeam('teamDiscussion.status', { roomId, discussionId: roomId });
      if (limited.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadlineLimit);
    assert.equal(limited.state, 'completed');
    await checkTracking(capacity, 5);
    assert.equal(limited.executions.length, 5);
  }
  const heldBeforeLimit = heldRequests;
  const cancelledMembers = (
    await requestTeam('teamDiscussion.prepare', {
      roomId: 'limited-1',
      agentIds: ['alice', 'bob'],
      cwd: project,
      permissionMode: 'ask',
    })
  ).members;
  await startTracking();
  await requestTeam('teamDiscussion.start', {
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
  let cancelledLimit = await requestTeam(
    'teamDiscussion.stop',
    { roomId: 'limited-1', discussionId: 'limited-cancel' },
    { timeoutMs: 15000 },
  );
  const cancelledDeadline = Date.now() + 15000;
  while (cancelledLimit.state === 'unknown' && Date.now() < cancelledDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    cancelledLimit = await requestTeam('teamDiscussion.status', {
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
        `export {AgentTeamSettingsService} from ${JSON.stringify(path.join(pluginRoot, "host/data/agentTeamSettingsService"))}; export {TeamDiscussionCoordinator} from ${JSON.stringify(path.join(pluginRoot, "host/discussion/teamDiscussionCoordinator"))}; export {CollaborationCoordinator} from ${JSON.stringify(path.join(pluginRoot, "host/collaboration/collaborationCoordinator"))}; export {initializeTeamDiscussionTables} from ${JSON.stringify(path.join(pluginRoot, "host/data/teamDiscussionStore"))}; export {initializeCollaborationTables,CollaborationStore} from ${JSON.stringify(path.join(pluginRoot, "host/data/collaborationStore"))};`,
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
  // Host entry points capture their registration once; nested requests retain
  // that admission across awaits, as they do in the actual Main host.
  const requestGateway = (method, params) =>
    appClient.request(method, params, { timeoutMs: 45000 });
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
  hostHandler = payload => withAppBinding(() => collaborationHost.handle(payload));
  hostLifecycleObserver = payload =>
    withAppBinding(() => collaborationHost.observeExecution(payload));
  const callDiscussionHost = (method, ...args) =>
    withAppBinding(() => discussionHost[method](...args));
  // Progress reads use exact Native receipts; history is loaded after settlement.
  const readSettledDiscussion = async (roomId, deadline) => {
    const run = discussionHost.metadata.latestRun(roomId);
    assert.ok(run, 'a sent discussion must have an exact native run');
    let status;
    while (Date.now() < deadline) {
      status = await requestTeam(
        'teamDiscussion.status',
        {
          roomId,
          discussionId: run.discussionId,
        },
        { timeoutMs: Math.max(1, deadline - Date.now()) },
      );
      if (status.state === 'completed' || status.state === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(
      Date.now() <= deadline && ['completed', 'failed'].includes(status?.state),
      'the exact native discussion must settle within the original budget',
    );
    assert.equal(status.discussionId, run.discussionId);
    assert.equal(status.roomId, roomId);
    const result = await callDiscussionHost('read', roomId);
    assert.ok(Date.now() <= deadline, 'native history must load within the original budget');
    return result;
  };
  await client.request('sessions.create', {
    key: 'agent:alice:justdo:organizer',
    cwd: project,
    permissionMode: 'guarded',
  });
  const launchSource = (
    await requestTeam('teamDiscussion.summary', {
      operation: 'source',
      sessionKey: 'agent:alice:justdo:organizer',
    })
  ).source;
  await requestTeam('agentTeam.launch.register', {
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
      const run = discussionHost.metadata.latestRun(room.id);
      if (run) {
        const status = await requestTeam('teamDiscussion.status', {
          roomId: room.id,
          discussionId: run.discussionId,
        });
        if (status.state === 'completed') {
          organized = await callDiscussionHost('read', room.id);
          break;
        }
      }
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
  await requestTeam('agentTeam.launch.confirm', {
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
    organizerContextChecks.every(
      check => check.sender && check.bot && check.relay && check.authorization,
    ),
    'native model input must identify the assistant relay and its authorization boundary',
  );
  assert.ok(
    organized.room.summarySource?.sessionId,
    'Main must pin the original native source for automatic summaries',
  );
  const summaryDeadline = Date.now() + 20000;
  let summary;
  do {
    await callDiscussionHost('reconcile');
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
  await callDiscussionHost('reconcile');
  assert.equal(modelRequests, countAfterSummary, 'delivered summaries must not be resent');
  const settleRoomSummaries = async roomId => {
    const deadline = Date.now() + 30000;
    while (discussionHost.metadata.hasUnsettledSummary(roomId) && Date.now() < deadline) {
      await callDiscussionHost('reconcile');
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
  const sourceBefore = await requestTeam('teamProbe.sessionPolicy', { key: sourceKey });
  const participating = await callDiscussionHost('setParticipation', {
    roomId: organized.room.id,
    expectedRevision: organized.room.revision,
    enabled: true,
  });
  assert.equal(participating.members.filter(member => member.ownership === 'source').length, 1);
  await startTracking();
  await callDiscussionHost('send', {
    roomId: participating.id,
    requestId: 'source-participation',
    expectedRevision: participating.revision,
    message: 'LIMIT_NATIVE_FIXTURE: discuss a second point with the organizer.',
    selectedAgentIds: [],
    rounds: 1,
  });
  const sourceWaitStartedAt = Date.now();
  const sourceRound = await readSettledDiscussion(participating.id, sourceWaitStartedAt + 25000);
  assert.equal(
    sourceRound.latestRun?.state,
    'completed',
    'production source participation must settle',
  );
  console.log(
    JSON.stringify({
      check: 'source-participation-settlement',
      elapsedMs: Date.now() - sourceWaitStartedAt,
      budgetMs: 25000,
    }),
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
  const sourceAfter = await requestTeam('teamProbe.sessionPolicy', { key: sourceKey });
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
  await callDiscussionHost('send', {
    roomId: participating.id,
    requestId: 'source-only',
    expectedRevision: participating.revision,
    message: 'A direct question for the organizer.',
    selectedAgentIds: ['alice'],
    rounds: 1,
  });
  const directRound = await readSettledDiscussion(participating.id, Date.now() + 25000);
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
  await callDiscussionHost('setParticipation', {
    roomId: participating.id,
    expectedRevision: participating.revision,
    enabled: false,
  });
  const afterDisable = await callDiscussionHost('read', participating.id, undefined, [
    sourceRound.latestRun.discussionId,
  ]);
  assert.ok(
    afterDisable.messages.some(message => message.agentId === 'alice'),
    'public source replies survive opting out',
  );
  await callDiscussionHost('stop', participating.id);
  await client.request('sessions.patch', { key: sourceKey, toolOverrides: { webSearch: false } });
  const restrictedDescription = await client.request('sessions.describe', { key: sourceKey });
  assert.equal(
    restrictedDescription.session.toolOverrides.webSearch,
    false,
    'source overrides must persist independently of global config',
  );
  const restrictedSource = await requestTeam('teamProbe.sessionPolicy', { key: sourceKey });
  assert.equal(restrictedSource.toolOverrides.webSearch, false);
  for (const action of ['create', 'send']) {
    await requestTeam('collaboration.bind', {
      sessionKey: sourceKey,
      runId: nativeSourceRun,
      toolCallId: `restricted-${action}`,
    });
    await assert.rejects(
      requestTeam('collaboration.dispatch', {
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
  const plannedSource = await requestTeam('teamProbe.sessionPolicy', { key: sourceKey });
  assert.equal(
    plannedSource.planEnabled,
    true,
    'native getSessionEntry must retain the registered Plan state used by collaboration',
  );
  await requestTeam('collaboration.bind', {
    sessionKey: sourceKey,
    runId: nativeSourceRun,
    toolCallId: 'planned-create',
  });
  await assert.rejects(
    requestTeam('collaboration.dispatch', {
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
  reviewMetadata.beginRound('quality-room', 'quality-batch', 'review-source');
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
  const afterSourceDelete = await callDiscussionHost('read', participating.id, undefined, [
    sourceRound.latestRun.discussionId,
  ]);
  assert.equal(afterSourceDelete.historyUnavailable, false);
  assert.ok(
    afterSourceDelete.messages.some(message => message.agentId === 'alice'),
    'public source replies survive source transcript deletion',
  );
  hostHandler = undefined;
  hostDb.close();
  await verifyHistoryToggle(serviceInput, prepared.members);
  console.log(
    JSON.stringify(
      {
        ok: true,
        stateDirectory: state,
        modelRequests,
        executions: coldResult.executions.length,
        references: coldResult.references.length,
        projectReadVerified: true,
        commandsRejected: true,
        historyVerified: true,
        nativeCancellationVerified: true,
        productionServiceVerified: true,
        admissionReplayVerified: true,
        messageToolVerified: true,
        disabledHistoryUnavailableVerified: true,
        reenabledHistoryPreservedVerified: true,
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
}
try {
  await runChecks();
} catch (error) {
  console.error(error.stack ?? error.message);
  const metrics = await client
    ?.request('teamProbe.metrics', {}, { timeoutMs: 2000 })
    .catch(() => undefined);
  console.error(
    JSON.stringify({
      modelRequests,
      organizerContextChecks,
      tools: toolObservations.map(item => ({
        offered: item.offered?.length,
        results: item.results?.length,
      })),
      lifecycleObservations,
      metrics,
    }),
  );
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
  await childClosed;
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  writeFileSync(path.join(state, 'probe.log'), output.replaceAll(token, '<fixture-token>'));
  console.log(`Fixture log: ${path.join(state, 'probe.log')}`);
}
