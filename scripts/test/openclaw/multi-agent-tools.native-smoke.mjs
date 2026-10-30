// Opt-in public-SDK proof: independent managed agents, real tool admission,
// question routing, cancellation and execution approvals. Browser transport is
// deliberately a deterministic Main responder; guest/page isolation is tested
// by the host browser tests, rather than claimed by this Gateway-only probe.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { build } from 'esbuild';
import WebSocket from 'ws';

import launcher from '../../../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs';
import { prepareDevelopmentProjectBaseline } from '../plugin-host/project-development-runtime.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
assert.ok(
  process.argv[2] && process.argv.length === 3,
  'Pass one explicitly selected frozen runtime directory',
);
const runtime = fs.realpathSync(path.resolve(process.argv[2]));
const {
  verifyFrozenOpenClawRuntime,
  readOpenClawSourceLock,
} = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
const { hostTarget, targetContract } = require('../../../scripts/runtime/setup-node-runtime.cjs');
const app = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
// This probe overlays current extension source onto an existing frozen Native
// runtime. Verify its immutable bytes and locked npm identity, rather than
// claiming that it was rebuilt from today's application build recipe.
const { buildInfo, manifest } = verifyFrozenOpenClawRuntime(runtime, {
  expectedVersion: app.openclaw.version,
  expectedTarget: hostTarget(),
  requireBundle: true,
});
const sourceLock = readOpenClawSourceLock(repo, buildInfo.openclawVersion);
assert.equal(buildInfo.npmIntegrity, sourceLock.integrity);
assert.equal(buildInfo.npmTarballSha256, sourceLock.tarballSha256);
assert.equal(buildInfo.target, hostTarget());
const executable = path.join(runtime, 'node-runtime', targetContract(hostTarget()).executable);
assert.equal(
  fs.realpathSync(process.execPath),
  fs.realpathSync(executable),
  'Use the selected frozen runtime Node',
);
const identity = {
  runtimeRoot: runtime,
  openclawVersion: buildInfo.openclawVersion,
  target: buildInfo.target,
  nodeVersion: process.version,
  gatewayBundleSha256: manifest.gatewayBundle.sha256,
  buildRecipeSha256: buildInfo.buildRecipeSha256,
  npmTarballSha256: buildInfo.npmTarballSha256,
  currentExtensionsOverlay: true,
};
console.log('NATIVE_RUNTIME_IDENTITY=' + JSON.stringify(identity));
await mkdir(path.join(repo, '.work'), { recursive: true });
const root = await mkdtemp(path.join(repo, '.work/app-plugin-hot-multi-agent-'));
const project = path.join(root, 'profile/project');
const state = path.join(root, 'state');
const extensions = path.join(root, 'extensions');
await mkdir(project, { recursive: true });
await mkdir(state);
await mkdir(extensions);
await prepareDevelopmentProjectBaseline({ repo, root });
await mkdir(path.join(root, 'node_modules'));
fs.symlinkSync(
  runtime,
  path.join(root, 'node_modules/openclaw'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
for (const id of ['embedded-browser', 'ask-user-question']) {
  const directory = path.join(extensions, id);
  await mkdir(directory);
  await build({
    entryPoints: [path.join(repo, 'plugins/extensions', id, 'index.ts')],
    outfile: path.join(directory, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: {
      '@app-plugin/sdk/execution-source': path.join(
        repo,
        'plugins/sdk/app-plugin-sdk/execution-source.ts',
      ),
    },
    external: ['openclaw/plugin-sdk/*'],
  });
  fs.copyFileSync(
    path.join(repo, 'plugins/extensions', id, 'openclaw.plugin.json'),
    path.join(directory, 'openclaw.plugin.json'),
  );
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: id, type: 'module', openclaw: { extensions: ['./index.js'] } }),
  );
}
const probe = path.join(extensions, 'execution-tools-probe');
await mkdir(probe);
await writeFile(
  path.join(probe, 'openclaw.plugin.json'),
  JSON.stringify({
    id: 'execution-tools-probe',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  }),
);
await writeFile(
  path.join(probe, 'package.json'),
  JSON.stringify({
    name: 'execution-tools-probe',
    type: 'module',
    openclaw: { extensions: ['./index.js'] },
  }),
);
await writeFile(
  path.join(probe, 'index.js'),
  `import fs from 'node:fs';
  const observe = (phase) => fs.appendFileSync(${JSON.stringify(path.join(root, 'phases.jsonl'))}, JSON.stringify({phase,at:Date.now()})+'\\n');
  export default { id: 'execution-tools-probe', register(api) {
  const firstToolReceipts = [];
  api.on('before_tool_call', async (event, context) => {
    if (event.toolName !== 'browser' || !context.sessionKey?.startsWith('agent:main:subagent:swarm-workflow-tools-')) return;
    try {
      const receipt = await api.runtime.subagent.describeRun({runId:context.runId});
      firstToolReceipts.push({sessionKey:context.sessionKey,runId:context.runId,receipt});
    } catch { firstToolReceipts.push({sessionKey:context.sessionKey,runId:context.runId,unavailable:true}); }
  });
  api.registerGatewayMethod('execution-tools-probe.ready', ({respond}) => respond(true, {ready:true,firstToolReceipts}), {scope:'operator.read'});
  for (const operation of ['run', 'describe', 'cancel']) api.registerGatewayMethod('execution-tools-probe.' + operation, async ({params, respond}) => {
    try {
      let result;
      if (operation === 'run') {
        observe('create.begin');
        const created = await api.runtime.gateway.request('sessions.create', {key: params.key, agentId: 'main', cwd: ${JSON.stringify(project)}, permissionMode: 'guarded'}, {scopes:['operator.admin']});
        observe('create.end');
        observe('run.begin');
        result = await api.runtime.subagent.run({sessionKey: created.key, message: params.message, disableTools: false, managedToolsLifetime: 'run', timeoutSeconds: 120, idempotencyKey: params.id});
        observe('run.end');
      } else result = await api.runtime.subagent[operation === 'describe' ? 'describeRun' : 'cancelRun']({runId: params.runId});
      respond(true, result);
    } catch (error) { respond(false, undefined, {code:'UNAVAILABLE', message:String(error)}); }
  }, {scope:'operator.admin'});
} };`,
);

const token = randomBytes(24).toString('hex');
const reservation = createNetServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const gatewayPort = reservation.address().port;
let modelCalls = 0;
let providerFailure;
const stages = new Map();
const observedToolResults = [];
const provider = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => {
    body += chunk;
  });
  request.on('end', () => {
    try {
      assert.ok(++modelCalls <= 32, 'Bounded synthetic model calls');
      const input = JSON.parse(body);
      const messages = input.messages ?? [];
      const actor = JSON.stringify(messages.filter(message => message.role === 'user')).match(
        /TOOLS_ACTOR_([ABC])/u,
      )?.[1];
      assert.ok(actor, 'Synthetic actor is present');
      const stage = stages.get(actor) ?? 0;
      stages.set(actor, stage + 1);
      const previous = messages.findLast(message => message.role === 'tool');
      if (previous) observedToolResults.push({ actor, stage, result: previous.content });
      if (previous)
        assert.doesNotMatch(
          JSON.stringify(previous.content),
          /"isError":true|Tool .* not found|no current native execution authority/u,
        );
      if (stage === 1) assert.match(JSON.stringify(previous?.content), /deterministic-main/u);
      if (stage === 2) assert.match(JSON.stringify(previous?.content), /answered/u);
      if (stage === 3) {
        const executed = JSON.parse(previous.content).result;
        assert.equal(executed.details.exitCode, 0, 'Actual executable succeeded after approval');
        assert.match(executed.details.aggregated, /tools-exec-approved/u);
      }
      const steps = [
        { name: 'browser', args: { action: 'doctor' } },
        {
          name: 'ask_user_question',
          args: {
            timeoutEnabled: false,
            questions: [
              {
                id: 'choice',
                question: 'Continue with the shared command?',
                options: [
                  { id: 'yes', label: 'Continue' },
                  { id: 'no', label: 'Cancel' },
                ],
              },
            ],
          },
        },
        {
          name: 'exec',
          args: {
            command:
              'node -e "eval(Buffer.from(\'' +
              Buffer.from("process.stdout.write('tools-exec-approved')").toString('base64') +
              "','base64').toString('utf8'))\"",
            ask: 'always',
          },
        },
      ];
      const step = steps[stage];
      const deferred = input.tools?.some(tool => tool.function?.name === 'tool_call');
      const tool = step && {
        id: 'tools-' + actor + '-' + stage,
        type: 'function',
        function: {
          name: deferred ? 'tool_call' : step.name,
          arguments: JSON.stringify(deferred ? { id: step.name, args: step.args } : step.args),
        },
      };
      const message = tool
        ? { role: 'assistant', content: null, tool_calls: [tool] }
        : { role: 'assistant', content: 'Finished tools actor ' + actor };
      const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
      if (input.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          'data: ' +
            JSON.stringify({
              id: 'tools-' + modelCalls,
              object: 'chat.completion.chunk',
              model: 'fixture',
              choices: [
                {
                  index: 0,
                  delta: tool
                    ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] }
                    : message,
                  finish_reason: null,
                },
              ],
            }) +
            '\n\n',
        );
        response.write(
          'data: ' +
            JSON.stringify({
              id: 'tools-' + modelCalls,
              object: 'chat.completion.chunk',
              model: 'fixture',
              choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
              usage,
            }) +
            '\n\n',
        );
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'tools-' + modelCalls,
            object: 'chat.completion',
            model: 'fixture',
            choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
            usage,
          }),
        );
      }
    } catch (error) {
      providerFailure ??= error;
      response.writeHead(500);
      response.end('Synthetic provider failed');
    }
  });
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const modelPort = provider.address().port;
const config = path.join(state, 'config.json');
await writeFile(
  config,
  JSON.stringify({
    update: { checkOnStart: false, auto: { enabled: false } },
    discovery: { mdns: { mode: 'off' } },
    gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'token', token } },
    agents: {
      defaults: {
        workspace: project,
        skipBootstrap: true,
        maxConcurrent: 4,
        model: { primary: 'fixture/fixture' },
      },
    },
    tools: { exec: { host: 'gateway', security: 'allowlist', ask: 'always' } },
    models: {
      mode: 'replace',
      catalogRefresh: { enabled: false },
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          apiKey: 'fixture-only',
          api: 'openai-completions',
          agentRuntime: { id: 'openclaw' },
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: 'fixture',
              name: 'fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 131072,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    plugins: {
      allow: ['execution-tools-probe', 'embedded-browser', 'ask-user-question'],
      entries: {
        'execution-tools-probe': { enabled: true },
        'embedded-browser': { enabled: true },
        'ask-user-question': { enabled: true },
      },
    },
  }),
);
const launchHelper = path.join(root, 'launch.cjs');
await build({
  stdin: {
    contents:
      "export {buildGatewayLaunchEnvironment} from './src/main/openclaw/runtime/launch/gatewayLaunchArgs';",
    resolveDir: repo,
    loader: 'ts',
  },
  outfile: launchHelper,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { buildGatewayLaunchEnvironment } = require(launchHelper);
const offlineAttempts = path.join(root, 'offline-attempts.jsonl');
const offlineGuard = path
  .join(repo, 'scripts/test/plugin-host/block-public-network.cjs')
  .replaceAll('\\', '/');
const env = {
  ...buildGatewayLaunchEnvironment(
    launcher.buildOpenClawCompileCacheEnvironment(process.env, path.join(state, '.compile-cache')),
    { appStartedAtMs: Date.now(), stateDir: state },
  ),
  OPENCLAW_HOME: path.join(root, 'home'),
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: config,
  OPENCLAW_PROFILE: 'default',
  OPENCLAW_BUNDLED_PLUGINS_DIR: extensions,
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
  OPENCLAW_SKIP_CRON: '1',
  VITEST: 'true',
  NODE_OPTIONS: `--require="${offlineGuard}"`,
  APP_PLUGIN_OFFLINE_ATTEMPT_LOG: offlineAttempts,
};
const log = fs.openSync(path.join(root, 'gateway.log'), 'a');
let child;
let socket;
let rpc;
let failure;
const terminal = [];
const browsers = [];
const approvals = [];
const pending = new Map();
let sequence = 0;
const wait = async (read, label, timeout = 30000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (providerFailure) throw providerFailure;
    const result = await read();
    if (result) return result;
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error('Gateway exited during ' + label);
    await delay(100);
  }
  throw new Error('Deadline exceeded: ' + label);
};
try {
  await new Promise(resolve => reservation.close(resolve));
  child = spawn(
    executable,
    [
      path.join(runtime, 'gateway-launcher.cjs'),
      'gateway',
      'run',
      '--port',
      String(gatewayPort),
      '--allow-unconfigured',
    ],
    { cwd: project, env, windowsHide: true, stdio: ['ignore', log, log] },
  );
  await wait(
    async () => {
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        socket = ws;
        return true;
      } catch {
        return false;
      }
    },
    'private Gateway start',
    60000,
  );
  rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('RPC timed out: ' + method));
      }, 30000);
      pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  const handleMessage = raw => {
    const message = JSON.parse(raw);
    if (message.type === 'res') {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        message.ok
          ? entry.resolve(message.payload)
          : entry.reject(
              Object.assign(new Error(message.error?.message ?? 'Gateway request failed'), {
                code: message.error?.code,
                details: message.error?.details,
              }),
            );
      }
    } else if (message.type === 'event') {
      if (
        message.event === 'agent' &&
        message.payload?.stream === 'lifecycle' &&
        message.payload.data?.executionSettled === true
      )
        terminal.push(message.payload);
      if (message.event === 'exec.approval.requested') approvals.push(message.payload);
      if (message.event === 'plugin.embedded-browser.requested') {
        browsers.push(message.payload);
        void rpc('embeddedBrowser.resolve', {
          requestId: message.payload.requestId,
          ok: true,
          result: {
            ok: true,
            transport: 'deterministic-main',
            actorSessionKey: message.payload.sessionKey,
          },
        }).catch(error => {
          failure ??= error;
        });
      }
    }
  };
  socket.on('message', handleMessage);
  const connection = {
    minProtocol: 4,
    maxProtocol: 4,
    client: { id: 'cli', version: 'fixture', platform: process.platform, mode: 'cli' },
    role: 'operator',
    caps: ['tool-events', 'exec-approvals'],
    scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals'],
    auth: { token },
  };
  await wait(async () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const next = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
      await new Promise((resolve, reject) => {
        next.once('open', resolve);
        next.once('error', reject);
      });
      socket = next;
      socket.on('message', handleMessage);
    }
    try {
      await rpc('connect', connection);
      return true;
    } catch (error) {
      if (error.details?.reason === 'startup-sidecars') {
        socket.terminate();
        socket = undefined;
        return false;
      }
      throw error;
    }
  }, 'authenticated Gateway readiness');
  await wait(async () => {
    try {
      return (await rpc('execution-tools-probe.ready', {})).ready === true;
    } catch (error) {
      if (error.details?.reason === 'startup-sidecars') return false;
      throw error;
    }
  }, 'read-only plugin readiness');
  const runs = [];
  for (const actor of ['A', 'B', 'C']) {
    const key = `agent:main:subagent:swarm-workflow-tools-${actor.toLowerCase()}`;
    runs.push(
      await rpc('execution-tools-probe.run', {
        key,
        message: 'TOOLS_ACTOR_' + actor,
        id: 'tools-actor-' + actor,
      }),
    );
  }
  const questions = await wait(async () => {
    const value = (await rpc('askUserQuestion.list', {})).requests;
    return value.length === 3 ? value : null;
  }, 'three independent questions');
  assert.equal(new Set(questions.map(request => request.requestId)).size, 3);
  assert.equal(new Set(questions.map(request => request.sessionKey)).size, 3);
  assert.ok(
    questions.every(
      request =>
        typeof request.source?.nativeSessionId === 'string' &&
        typeof request.source?.toolCallId === 'string',
    ),
    'Questions preserve real Native incarnation',
  );
  assert.equal(browsers.length, 3, 'All three managed agents reach current browser hooks');
  const { firstToolReceipts } = await rpc('execution-tools-probe.ready', {});
  assert.equal(firstToolReceipts.length, 3);
  assert.ok(
    firstToolReceipts.every(
      ({ sessionKey, runId, receipt }) =>
        receipt?.sessionKey === sessionKey &&
        receipt.runId === runId &&
        receipt.executionSettled === false &&
        ['accepted', 'running'].includes(receipt.state),
    ),
    'Owned Native receipt is readable during the first tool before caller reconciliation',
  );
  assert.equal(new Set(browsers.map(request => request.run.sessionId)).size, 3);
  const ownQuestion = actor =>
    questions.find(request => request.sessionKey.endsWith('-' + actor.toLowerCase()));
  assert.deepEqual(ownQuestion('A').questions, ownQuestion('B').questions);
  assert.deepEqual(ownQuestion('B').questions, ownQuestion('C').questions);
  const answer = (request, source = request.source) =>
    rpc('askUserQuestion.resolve', {
      requestId: request.requestId,
      source,
      behavior: 'submit',
      answers: { choice: { selected: ['yes'] } },
    });
  const invalidAnswer = request =>
    assert.rejects(request, error => error.code === 'invalid_request');
  await invalidAnswer(answer(ownQuestion('A'), ownQuestion('B').source));
  assert.deepEqual(
    (await rpc('askUserQuestion.list', {})).requests.map(request => request.requestId).sort(),
    questions.map(request => request.requestId).sort(),
    'A reply with another actor source cannot settle any question',
  );
  await rpc('execution-tools-probe.cancel', { runId: runs[2].runId });
  await wait(async () => {
    const live = (await rpc('askUserQuestion.list', {})).requests;
    return (
      live.length === 2 && live.every(request => request.requestId !== ownQuestion('C').requestId)
    );
  }, 'cancelling C removes only C question');
  await invalidAnswer(answer(ownQuestion('C')));
  await answer(ownQuestion('A'));
  await invalidAnswer(answer(ownQuestion('A')));
  const remaining = (await rpc('askUserQuestion.list', {})).requests;
  assert.deepEqual(
    remaining.map(request => request.requestId),
    [ownQuestion('B').requestId],
    'Answer A cannot resolve B',
  );
  const approvalA = await wait(
    () => approvals.find(approval => approval.request.sessionKey === ownQuestion('A').sessionKey),
    'A execution approval while B remains waiting for its answer',
  );
  assert.equal(approvals.length, 1);
  assert.deepEqual(
    (await rpc('askUserQuestion.list', {})).requests.map(request => request.requestId),
    [ownQuestion('B').requestId],
    'An execution approval does not consume a peer question',
  );
  await rpc('exec.approval.resolve', { id: approvalA.id, decision: 'allow-once' });
  const settledRun = run =>
    wait(async () => {
      const state = await rpc('execution-tools-probe.describe', { runId: run.runId });
      return state.executionSettled === true && state.cleanupSettled === true ? state : null;
    }, 'exact managed terminal and cleanup');
  assert.equal((await settledRun(runs[0])).outcome, 'ok');
  assert.deepEqual(
    (await rpc('askUserQuestion.list', {})).requests.map(request => request.requestId),
    [ownQuestion('B').requestId],
    'A whole-run completion leaves B question pending',
  );
  assert.equal(stages.get('B'), 2, 'B cannot execute before its own answer');
  assert.equal(stages.get('C'), 2, 'Cancelled C never reaches execution');
  assert.equal(approvals.length, 1, 'A approval grants no permission to B');
  assert.deepEqual(
    observedToolResults.filter(item => item.stage === 3).map(item => item.actor),
    ['A'],
    'Only A executed the command approved for A',
  );
  await answer(ownQuestion('B'));
  const approvalB = await wait(
    () => approvals.find(approval => approval.request.sessionKey === ownQuestion('B').sessionKey),
    'B requires its own approval for the identical command',
  );
  assert.equal(approvals.length, 2);
  assert.equal(new Set(approvals.map(request => request.id)).size, 2);
  assert.deepEqual(
    approvals.map(approval => approval.request.sessionKey).sort(),
    [ownQuestion('A').source.sessionKey, ownQuestion('B').source.sessionKey].sort(),
  );
  for (const approval of approvals) {
    const question = questions.find(item => item.source.sessionKey === approval.request.sessionKey);
    // Native exec can omit these optional fields for managed runs. Never fill
    // them from another tool's context or pretend such requests offer a grant.
    if (approval.request.sessionId != null)
      assert.equal(approval.request.sessionId, question.source.nativeSessionId);
    if (approval.request.runId != null)
      assert.equal(approval.request.runId, question.source.runId);
  }
  assert.equal(typeof approvalA.request.command, 'string');
  assert.ok(approvalA.request.command.length > 0);
  assert.equal(approvalA.request.command, approvalB.request.command);
  await rpc('exec.approval.resolve', { id: approvalB.id, decision: 'allow-once' });
  for (const [index, run] of runs.entries()) {
    const settled = await settledRun(run);
    assert.equal(settled.runId, run.runId);
    if (index < 2) assert.equal(settled.outcome, 'ok', 'Uncancelled peers complete successfully');
    else
      assert.equal(settled.outcome, 'cancelled', 'Cancellation requires the actual settled result');
  }
  assert.equal((await rpc('askUserQuestion.list', {})).requests.length, 0);
  assert.ok(
    runs.every(run =>
      terminal.some(
        event =>
          event.runId === run.runId &&
          event.sessionKey === run.sessionKey &&
          ['end', 'error'].includes(event.data.phase),
      ),
    ),
    'Exact settled lifecycle for every actor',
  );
  assert.equal(failure, undefined);
  if (fs.existsSync(offlineAttempts))
    assert.equal((await readFile(offlineAttempts, 'utf8')).trim(), '');
  await writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        identity,
        agents: 3,
        browserTransports: browsers.length,
        firstToolReceipts: firstToolReceipts.length,
        independentQuestions: questions.length,
        identicalQuestions: true,
        rejectedWrongSourceReply: true,
        rejectedDuplicateReply: true,
        rejectedCancelledReply: true,
        approvals: approvals.length,
        identicalCommandsRequireIndependentApprovals: true,
        completedActorLeavesPeerQuestionPending: true,
        cancelledActors: 1,
        modelCalls,
        browserGuestScope: 'host tests, no real guest in this probe',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      agents: 3,
      approvals: approvals.length,
      evidence: path.join(root, 'result.json'),
    }),
  );
} catch (error) {
  let inventory = [];
  try {
    inventory = (await rpc?.('exec.approval.list', {})) ?? [];
  } catch {
    /* Preserve the primary error. */
  }
  await writeFile(
    path.join(root, 'failure.json'),
    JSON.stringify(
      {
        reason: error.message,
        modelCalls,
        providerError: providerFailure?.message,
        stages: [...stages],
        browserCalls: browsers.length,
        approvalEvents: approvals.length,
        pendingApprovalCount: inventory.length,
        toolResults: observedToolResults,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  socket?.close();
  // Stop only the process started above and require its actual exit. This is
  // fixture cleanup, not a proof of the product's graceful shutdown sequence.
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Owned Gateway did not exit after shutdown')),
        180000,
      );
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  fs.closeSync(log);
  await new Promise(resolve => provider.close(resolve));
  console.log('FIXTURE ' + root);
}
