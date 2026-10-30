const { hostRoot, pluginRoot, hostRequire } = require('../probe-paths.cjs');
'use strict';

// Opt-in proof of generated JSONL inputs and planner correction. Uses only
// isolated state/processes and a deterministic model protocol fixture.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { buildSync } = hostRequire('esbuild');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = hostRequire('ws');
const gatewayBundleLauncher = hostRequire(path.join(hostRoot, 'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'));

const runtime = process.env.SWARM_WORKFLOW_TEST_RUNTIME;
if (!runtime) throw new Error('Set SWARM_WORKFLOW_TEST_RUNTIME to an isolated, verified runtime.');
const base = path.resolve(hostRoot, '.agent-tasks/swarm-workflow/native-orders-smoke-' + Date.now());
const stateDir = path.join(base, 'state');
const project = path.join(base, 'projects', 'room');
const plugin = path.join(base, 'extensions', 'swarm-workflow');
const port = 43245;
const modelPort = 43246;
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(plugin, { recursive: true });
fs.mkdirSync(path.join(base, 'node_modules'), { recursive: true });
fs.symlinkSync(path.resolve(runtime), path.join(base, 'node_modules', 'openclaw'), 'junction');
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Preserve order inputs. Write each item result only in its assigned output directory.');
buildSync({ entryPoints: [path.join(pluginRoot, 'index.ts')], outfile: path.join(plugin, 'index.js'), bundle: true, platform: 'node', format: 'esm', external: ['openclaw/plugin-sdk/*'] });
fs.copyFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), path.join(plugin, 'openclaw.plugin.json'));
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'orders-proof-plugin', type: 'module', openclaw: { extensions: ['./index.js'] } }));
const goal = 'Prepare 12 orders in swarm-demo/orders.jsonl: quantity=i, unitPriceFen=100, reportedTotalFen=i*100 plus 1 when i is divisible by 4. Process each order in a batch, write independent results, aggregate all actual artifacts and independently verify. Allow creating these inputs and reports; preserve generated inputs.';
const configPath = path.join(stateDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  logging: { file: path.join(base, 'native.log'), level: 'info' },
  update: { checkOnStart: false, auto: { enabled: false } },
  gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token: 'isolated-orders-proof' } },
  agents: { defaults: { workspace: project, skipBootstrap: true, maxConcurrent: 4, model: { primary: 'fixture/fixture' } } },
  tools: { codeMode: { enabled: false }, exec: { host: 'gateway', security: 'full', ask: 'off' } },
  models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'fixture-only', api: 'openai-completions', agentRuntime: { id: 'openclaw' }, request: { allowPrivateNetwork: true }, models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  plugins: { allow: ['swarm-workflow'], entries: { 'swarm-workflow': { enabled: true, config: { availableAgentIds: ['main'], globalConcurrency: 3 } } } },
}));
// Use the same Windows observation and inherited-environment policy as Main.
// Only the fixture paths differ; tool permissions and execution budgets do not.
const launchHelperPath = path.join(base, 'launch-environment.cjs');
buildSync({
  stdin: {
    contents: "export {buildGatewayLaunchEnvironment} from './src/main/openclaw/runtime/launch/gatewayLaunchArgs';",
    resolveDir: hostRoot, loader: 'ts',
  },
  outfile: launchHelperPath, bundle: true, platform: 'node', format: 'cjs',
});
const { buildGatewayLaunchEnvironment } = require(launchHelperPath);
const launchEnv = {
  ...buildGatewayLaunchEnvironment(
    gatewayBundleLauncher.buildOpenClawCompileCacheEnvironment(process.env, path.join(stateDir, '.compile-cache')),
    { appStartedAtMs: Date.now(), stateDir },
  ),
  OPENCLAW_HOME: path.join(base, 'home'),
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_PROFILE: 'default',
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(base, 'extensions'),
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1',
  VITEST: 'true',
  OPENCLAW_SKIP_CRON: '1',
};
const timingPath = path.join(base, 'phase-timings.jsonl');
const timingStartedAt = Date.now();
let observationFailure;
function observe(type, metadata = {}) {
  try {
    fs.appendFileSync(timingPath, JSON.stringify({ type, observedAt: Date.now(), sinceStartMs: Date.now() - timingStartedAt, ...metadata }) + '\n');
  } catch (error) { observationFailure ??= error; }
}
observe('launch.policy', {
  platform: process.platform, polling: launchEnv.CHOKIDAR_USEPOLLING,
  customPollingInterval: launchEnv.CHOKIDAR_INTERVAL !== undefined,
  shellSnapshot: launchEnv.OPENCLAW_EXEC_SHELL_SNAPSHOT,
  inheritedCompileCache: process.env.NODE_COMPILE_CACHE !== undefined,
  inheritedCompileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE === '1',
  compileCache: launchEnv.NODE_DISABLE_COMPILE_CACHE === '1' ? 'disabled' :
    launchEnv.NODE_COMPILE_CACHE === path.join(stateDir, '.compile-cache') ? 'private-env' : 'default',
});
function reportFailure(error) {
  const errorType = typeof error?.name === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
  const errorCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
  observe('fixture.failure', { errorType, errorCode });
  // A provider/tool failure can contain task text in its message and stack.
  // Preserve the actual rejection/HTTP response, but keep test output closed.
  console.error('Orders fixture failed:', JSON.stringify({ errorType, errorCode, timings: timingPath }));
}
async function prepareProjectBaseline() {
  const startedAt = Date.now();
  const realBase = fs.realpathSync(base);
  const realProject = fs.realpathSync(project);
  assert.equal(realBase, path.join(fs.realpathSync('.work'), path.basename(base)));
  assert.equal(realProject, path.join(realBase, 'projects', 'room'));
  assert.equal(fs.readdirSync(realProject).includes('.git'), false);
  const hooks = path.join(realBase, 'empty-git-hooks');
  const globalConfig = path.join(realBase, 'empty-git-config');
  fs.mkdirSync(hooks);
  fs.writeFileSync(globalConfig, '', { flag: 'wx' });
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) if (key.toUpperCase().startsWith('GIT_')) delete gitEnv[key];
  gitEnv.GIT_CONFIG_NOSYSTEM = '1';
  gitEnv.GIT_CONFIG_GLOBAL = globalConfig;
  const git = args => new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.hooksPath=' + hooks, '-c', 'init.templateDir=' + hooks,
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@invalid.local', ...args],
    { cwd: realProject, env: gitEnv, windowsHide: true, timeout: 10000, maxBuffer: 4096 },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  observe('git.baseline.begin', { project: realProject });
  // Native captures a checkout baseline before a new session starts. Keep that
  // real Git behavior inside this fixture instead of scanning its host worktree.
  await git(['init', '--quiet']);
  assert.equal(fs.realpathSync(path.join(realProject, '.git')), path.join(realProject, '.git'));
  assert.equal(fs.lstatSync(path.join(realProject, '.git')).isSymbolicLink(), false);
  assert.equal(await git(['rev-parse', '--show-toplevel']), realProject.split(path.sep).join('/'));
  await git(['add', '--', 'AGENTS.md']);
  await git(['commit', '--quiet', '-m', 'test fixture baseline']);
  observe('git.baseline.finish', { project: realProject, isolated: true, committed: true,
    elapsedMs: Date.now() - startedAt });
}
const phaseValues = new Map();
let phaseDatabase;
function observeWorkflow(flowId) {
  const file = path.join(stateDir, 'swarm-workflow', 'flows.sqlite');
  if (!fs.existsSync(file)) return;
  try {
    phaseDatabase ??= new DatabaseSync(file, { readOnly: true });
    const scalarFields = `json_extract(n.value,'$.id') AS id,
      json_extract(n.value,'$.kind') AS kind, json_extract(n.value,'$.status') AS status,
      json_extract(n.value,'$.attempt') AS attempt, json_extract(n.value,'$.runId') AS runId,
      json_extract(n.value,'$.intendedRunId') AS intendedRunId,
      json_extract(n.value,'$.dispatch.createdAt') AS dispatchAt,
      json_extract(n.value,'$.startedAt') AS startedAt,
      json_extract(n.value,'$.endedAt') AS endedAt,
      json_extract(n.value,'$.cleanupSettled') AS cleanupSettled,
      json_extract(n.value,'$.completion.outcome') AS submissionOutcome,
      json_extract(n.value,'$.completion.createdAt') AS submissionAt,
      json_type(n.value,'$.error') IS NOT NULL AS hasError`;
    const rows = phaseDatabase.prepare(`SELECT ${scalarFields} FROM flows f,
      json_each(f.payload,'$.nodes') n WHERE f.id=?`).all(flowId);
    const items = phaseDatabase.prepare(`SELECT ${scalarFields} FROM batch_items b,
      json_each(json_array(json(b.payload))) n WHERE b.flow_id=? ORDER BY b.ordinal`).all(flowId);
    for (const [scope, entries] of [['node', rows], ['item', items]]) {
      for (const entry of entries) {
        const key = `${flowId}:${scope}:${entry.id}`;
        const value = JSON.stringify(entry);
        if (phaseValues.get(key) === value) continue;
        phaseValues.set(key, value);
        observe('workflow.phase', { flowId, scope, ...entry });
      }
    }
  } catch (error) {
    // Observation does not replace execution or receipt results. Missing rows
    // remain unknown; record only an error kind, never a payload or transcript.
    observe('workflow.observation-unavailable', { errorType: error?.name ?? 'Error' });
  }
}
function providerPhase(task) {
  if (!task) return 'intake';
  if (task.instruction?.includes('Return only JSON')) return 'plan';
  if (task.batchItem) return 'item';
  if (task.assignedTask?.startsWith('Generate exactly')) return 'prepare';
  if (task.assignedTask?.startsWith('Read all accepted')) return 'aggregate';
  if (task.instruction?.includes('Independently inspect')) return 'verify';
  if (task.instruction?.includes('Produce the final user-facing answer')) return 'deliver';
  return 'unclassified';
}
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
const unwrap = text => { try { const value = JSON.parse(text); return value?.result?.details ?? value?.details ?? value?.result ?? value; } catch { return undefined; } };
function envelope(text) {
  const start = text.indexOf('{"goal":');
  if (start < 0) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && !--depth) return JSON.parse(text.slice(start, i + 1));
  }
}
const plan = { tasks: [
  { id: 'prepare', title: 'Prepare orders', task: 'Generate exactly 12 orders in swarm-demo/orders.jsonl.', access: 'write', deps: [], batch: null },
  { id: 'check', title: 'Check orders', task: 'Read this item input.json; calculate expectedTotalFen, reportedTotalFen, diff and anomalous, and write output/result.json. A discovered amount anomaly is a successful result.', access: 'write', deps: ['prepare'], batch: { source: { kind: 'jsonl', path: 'swarm-demo/orders.jsonl' } } },
  { id: 'aggregate', title: 'Aggregate orders', task: 'Read all accepted item artifacts and write swarm-demo/summary.json and swarm-demo/report.md.', access: 'write', deps: ['check'], batch: null },
] };
const expected = { count: 12, normal: 9, anomalies: ['order-004', 'order-008', 'order-012'], expectedTotalFen: 7800, reportedTotalFen: 7803, diff: 3 };
const nodeCommand = script => 'node -e "eval(Buffer.from(\'' + Buffer.from(script).toString('base64') + '\',\'base64\').toString(\'utf8\'))"';
const command = script => ({ command: nodeCommand(script), workdir: project });
let calls = 0, plannerCalls = 0, corrected = false, maxOccupied = 0, fixtureFailure;
const processed = new Set();
const provider = http.createServer((req, res) => {
  const arrivedAt = Date.now();
  let call, phase = 'unparsed', itemId;
  res.once('finish', () => observe('provider.finish', { call, phase, itemId, statusCode: res.statusCode, elapsedMs: Date.now() - arrivedAt }));
  res.once('close', () => { if (!res.writableFinished) observe('provider.closed', { call, phase, itemId, elapsedMs: Date.now() - arrivedAt }); });
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const input = JSON.parse(body); calls++; call = calls;
      assert.ok(calls <= 120, 'Model-call budget exceeded.');
      const messages = input.messages ?? [];
      const user = messages.findLast(message => message.role === 'user' && envelope(textOf(message.content)));
      const task = user && envelope(textOf(user.content));
      phase = providerPhase(task);
      itemId = typeof task?.batchItem?.id === 'string' ? task.batchItem.id : undefined;
      observe('provider.begin', { call, phase, itemId, arrivedAt, requestBytes: Buffer.byteLength(body), stream: input.stream === true });
      const toolMessages = messages.filter(message => message.role === 'tool');
      const toolValues = toolMessages.map(message => unwrap(textOf(message.content)));
      const accepted = toolMessages.some(message => textOf(message.content).includes('Submission persisted.'));
      const marker = value => toolMessages.some(message => textOf(message.content).includes(value));
      const rejected = toolMessages.find(message => {
        const result = unwrap(textOf(message.content));
        return /^(?:Error:|Tool .* not found)/u.test(textOf(message.content)) || result?.accepted === false || result?.isError === true || (Number.isInteger(result?.exitCode) && result.exitCode !== 0);
      });
      if (rejected) throw new Error('Unexpected tool rejection: ' + textOf(rejected.content).slice(0, 1000));
      let name, args, content = 'Orders stage complete.';
      if (!task && !toolMessages.length) { name = 'swarm_workflow_start'; args = { goal, mode: 'auto' }; }
      else if (task?.instruction.includes('Return only JSON')) {
        plannerCalls++;
        if (!task.planningCorrection) {
          // Reproduce the user's failure: structural batch descriptor is text
          // inside the worker brief, and no task declares the batch field.
          content = JSON.stringify({ tasks: plan.tasks.map(({ batch, ...item }) => ({ ...item, ...(batch ? { task: 'Use batch:{source:{kind:"jsonl",path:"swarm-demo/orders.jsonl"}} to expand twelve workers.' } : {}) })) });
        } else {
          assert.equal(task.planningCorrection.round, 1);
          assert.match(task.planningCorrection.error, /top-level batch field/);
          corrected = true; content = JSON.stringify(plan);
        }
      } else if (task?.assignedTask.startsWith('Generate exactly') && !accepted) {
        if (!marker('orders-prepared')) { name = 'exec'; args = command("const f=require('fs');f.mkdirSync('swarm-demo');const rows=Array.from({length:12},(_,j)=>{const i=j+1;return {id:'order-'+String(i).padStart(3,'0'),title:'Order '+i,data:{quantity:i,unitPriceFen:100,reportedTotalFen:i*100+(i%4===0?1:0)}}});const lf=String.fromCharCode(10);f.writeFileSync('swarm-demo/orders.jsonl',rows.map(r=>JSON.stringify(r)).join(lf)+lf);console.log('orders-prepared')"); }
        else { name = 'swarm_workflow_complete'; args = { summary: 'Prepared twelve orders.', evidence: ['swarm-demo/orders.jsonl'] }; }
      } else if (task?.batchItem && !accepted) {
        if (!marker('order-written')) {
          name = 'exec'; args = { command: nodeCommand("const f=require('fs');const i=JSON.parse(f.readFileSync('input.json','utf8'));const expectedTotalFen=i.data.quantity*i.data.unitPriceFen;const reportedTotalFen=i.data.reportedTotalFen;const diff=reportedTotalFen-expectedTotalFen;setTimeout(()=>{f.writeFileSync('output/result.json',JSON.stringify({id:i.id,expectedTotalFen,reportedTotalFen,diff,anomalous:diff!==0}));console.log('order-written')},500)") };
        } else { processed.add(task.batchItem.id); name = 'swarm_workflow_complete'; args = { summary: 'Checked ' + task.batchItem.id, evidence: ['output/result.json'] }; }
      } else if (task?.assignedTask.startsWith('Read all accepted') && !accepted) {
        const pages = toolValues.filter(value => value?.stageId === 'task-2' && Array.isArray(value.items));
        const last = pages.at(-1);
        if (!last || last.cursor) { name = 'swarm_workflow_results'; args = { stageId: 'task-2', ...(last?.cursor ? { cursor: last.cursor } : {}) }; }
        else if (!marker('orders-aggregated')) {
          const items = pages.flatMap(page => page.items); assert.equal(items.length, 12);
          const paths = items.map(item => item.result.artifacts[0].path);
          name = 'exec'; args = command("const f=require('fs');const rows=" + JSON.stringify(paths) + ".map(p=>JSON.parse(f.readFileSync(p,'utf8')));const s={count:rows.length,normal:rows.filter(r=>!r.anomalous).length,anomalies:rows.filter(r=>r.anomalous).map(r=>r.id).sort(),expectedTotalFen:rows.reduce((s,r)=>s+r.expectedTotalFen,0),reportedTotalFen:rows.reduce((s,r)=>s+r.reportedTotalFen,0),diff:rows.reduce((s,r)=>s+r.diff,0)};f.writeFileSync('swarm-demo/summary.json',JSON.stringify(s));f.writeFileSync('swarm-demo/report.md','# Order checks'+String.fromCharCode(10)+JSON.stringify(s));console.log('orders-aggregated')");
        } else { name = 'swarm_workflow_complete'; args = { summary: 'Read twelve actual artifacts; nine normal, three anomalies; totals 7800/7803 and difference 3 fen.', evidence: ['swarm-demo/summary.json', 'swarm-demo/report.md'] }; }
      } else if (task?.instruction.includes('Independently inspect') && !accepted) {
        const pages = toolValues.filter(value => value?.stageId === 'task-2' && Array.isArray(value.items));
        const last = pages.at(-1);
        if (!last || last.cursor) { name = 'swarm_workflow_results'; args = { stageId: 'task-2', ...(last?.cursor ? { cursor: last.cursor } : {}) }; }
        else if (!marker('orders-verified')) {
          const paths = pages.flatMap(page => page.items).map(item => item.result.artifacts[0].path);
          name = 'exec'; args = command("const f=require('fs');const a=require('assert/strict');const source=f.readFileSync('swarm-demo/orders.jsonl','utf8').trim().split(String.fromCharCode(10)).map(l=>JSON.parse(l));a.equal(source.length,12);source.forEach((r,j)=>a.deepEqual(r.data,{quantity:j+1,unitPriceFen:100,reportedTotalFen:(j+1)*100+((j+1)%4===0?1:0)}));const rows=" + JSON.stringify(paths) + ".map(p=>JSON.parse(f.readFileSync(p,'utf8')));a.deepEqual(rows.map(r=>r.id).sort(),source.map(r=>r.id).sort());for(const r of rows){const s=source.find(s=>s.id===r.id).data;const expectedTotalFen=s.quantity*s.unitPriceFen;const diff=s.reportedTotalFen-expectedTotalFen;a.deepEqual(r,{id:r.id,expectedTotalFen,reportedTotalFen:s.reportedTotalFen,diff,anomalous:diff!==0});}a.deepEqual(JSON.parse(f.readFileSync('swarm-demo/summary.json','utf8'))," + JSON.stringify(expected) + ");console.log('orders-verified')");
        } else { name = 'swarm_workflow_verify'; args = { passed: true, summary: 'Independently verified coverage, original inputs and totals.', evidence: ['swarm-demo/orders.jsonl', 'swarm-demo/summary.json'] }; }
      } else if (task?.instruction.includes('Produce the final user-facing answer')) content = 'Verified 12 orders: nine normal, three anomalies, difference 3 fen. Reports: swarm-demo/summary.json and swarm-demo/report.md.';
      const deferred = (input.tools ?? []).some(tool => tool.function?.name === 'tool_call');
      const toolCall = name && { id: 'orders-call-' + calls, type: 'function', function: { name: deferred ? 'tool_call' : name, arguments: JSON.stringify(deferred ? { id: name, args } : args) } };
      observe('provider.response', { call, phase, itemId, tool: name, deferred: !!toolCall && deferred, elapsedMs: Date.now() - arrivedAt });
      if (input.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'orders-' + calls, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: toolCall ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] } : { role: 'assistant', content }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'orders-' + calls, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'orders-' + calls, object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: toolCall ? { role: 'assistant', content: null, tool_calls: [toolCall] } : { role: 'assistant', content }, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      }
    } catch (error) { observe('provider.failure', { call, phase, itemId, errorType: error?.name ?? 'Error' }); fixtureFailure = error; res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket;
async function connectOnce() {
  for (let i = 0; i < 60; i++) {
    try { socket = await new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.once('open', () => resolve(ws)); ws.once('error', reject); }); break; }
    catch { if (child.exitCode !== null) throw new Error('Isolated Gateway exited.'); await delay(1000); }
  }
  assert.ok(socket, 'Gateway startup deadline exceeded.');
  const pending = new Map(); let sequence = 0;
  socket.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.stream === 'lifecycle' &&
      ['start', 'end', 'error'].includes(msg.payload.data?.phase)) {
      observe('native.lifecycle', { runId: msg.payload.runId, sessionKey: msg.payload.sessionKey,
        phase: msg.payload.data.phase, executionSettled: msg.payload.data.executionSettled === true });
    }
    if (msg.type === 'res') {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        observe('rpc.finish', { id: msg.id, method: entry.method, ok: msg.ok === true,
          errorCode: msg.ok ? undefined : msg.error?.code, elapsedMs: Date.now() - entry.startedAt });
        msg.ok ? entry.resolve(msg.payload) : entry.reject(new Error(JSON.stringify(msg.error)));
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = String(++sequence), startedAt = Date.now();
    observe('rpc.begin', { id, method });
    const timer = setTimeout(() => { pending.delete(id); observe('rpc.timeout', { id, method, elapsedMs: Date.now() - startedAt }); reject(new Error('Timed out: ' + method)); }, 30000);
    pending.set(id, { method, startedAt, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  await rpc('connect', { minProtocol: 4, maxProtocol: 4, client: { id: 'cli', version: 'proof', platform: 'win32', mode: 'cli' }, role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'], auth: { token: 'isolated-orders-proof' } });
  return rpc;
}
async function connect() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { return await connectOnce(); }
    catch (error) {
      socket?.close();
      if (child.exitCode !== null || !String(error).includes('startup-sidecars')) throw error;
      await delay(1000);
    }
  }
  throw new Error('Gateway sidecars did not become ready.');
}
(async () => {
  try {
    await prepareProjectBaseline();
    await new Promise(resolve => provider.listen(modelPort, '127.0.0.1', resolve));
    child = spawn(process.execPath, [path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', String(port), '--bind', 'loopback'], { cwd: base, windowsHide: true, env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    observe('gateway.spawn', { pid: child.pid });
    child.once('exit', (code, signal) => observe('gateway.exit', { code, signal }));
    const append = chunk => fs.appendFileSync(path.join(base, 'gateway.log'), chunk);
    child.stdout.on('data', append); child.stderr.on('data', append);
    await delay(15000);
    const rpc = await connect(); const parentKey = 'agent:main:justdo:orders-proof';
    await rpc('sessions.create', { key: parentKey, cwd: project, permissionMode: 'full' });
    const intake = await rpc('chat.send', { sessionKey: parentKey, idempotencyKey: 'orders-proof-once', message: goal + '\n\n<swarm-workflow mode="auto"/>' });
    let done;
    for (let i = 0; i < 180; i++) {
      if (fixtureFailure || observationFailure) throw fixtureFailure ?? observationFailure;
      const flow = (await rpc('swarmWorkflow.list', { parentKeys: [parentKey] })).flows[0];
      if (!flow && i === 10) {
        const ended = await rpc('agent.wait', { runId: intake.runId, timeoutMs: 1 });
        if (ended.endedAt) throw new Error('Intake ended without creating the flow.');
      }
      if (flow) {
        observeWorkflow(flow.id);
        const counts = flow.nodes.find(node => node.kind === 'batch')?.batchCounts;
        if (counts) { const active = counts.preparing + counts.running + counts.uncertain; maxOccupied = Math.max(maxOccupied, active); assert.ok(active <= 3); }
        if (flow.status === 'blocked') throw new Error('Orders workflow blocked; inspect closed phase metadata.');
        if (flow.status === 'completed') { done = flow; break; }
        if (i % 10 === 0) console.log('ORDERS', flow.status, counts ?? 'planning/preparing');
      }
      await delay(1000);
    }
    assert.ok(done, 'Orders workflow did not complete.');
    assert.equal(plannerCalls, 2); assert.equal(corrected, true); assert.equal(processed.size, 12);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'swarm-demo/summary.json'), 'utf8')), expected);
    const db = new DatabaseSync(path.join(stateDir, 'swarm-workflow/flows.sqlite'), { readOnly: true });
    try {
      const saved = JSON.parse(db.prepare('SELECT payload FROM flows WHERE id=?').get(done.id).payload);
      assert.equal(saved.nodes.find(node => node.id === 'plan').planningRepair.passes, 1);
      const batchRoot = path.join(project, '.agent-tasks', 'swarm-workflow', done.id, 'task-2');
      assert.equal(path.dirname(path.dirname(saved.nodes.find(node => node.id === 'task-2').batchInput.manifestPath)), batchRoot);
      const rows = db.prepare('SELECT payload FROM batch_items WHERE flow_id=?').all(done.id).map(row => JSON.parse(row.payload));
      assert.equal(rows.length, 12); assert.ok(rows.every(row => row.status === 'done' && row.attempt === 1 && row.cleanupSettled && row.artifacts.artifacts.length === 1));
      for (const row of rows) {
        assert.equal(row.batchItem.workspace, path.join(batchRoot, row.id, 'attempt-1'));
        assert.equal(row.artifacts.artifacts[0].path, path.join(row.batchItem.workspace, 'output', 'result.json'));
      }
      assert.equal(fs.existsSync(path.join(project, '.justdo-tasks')), false);
      assert.equal(fs.existsSync(path.join(project, '.swarm-tasks')), false);
      assert.equal(db.prepare('SELECT count(*) AS count FROM execution_leases').get().count, 0);
    } finally { db.close(); }
    const history = await rpc('chat.history', { sessionKey: parentKey, limit: 8 });
    assert.ok(history.messages.some(message => textOf(message.content).includes('Verified 12 orders')));
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ passed: true, calls, plannerCalls, corrected, items: 12, maxOccupied, summary: expected }, null, 2));
    console.log('PASS generated JSONL, malformed-plan correction, 12 native item runs, actual aggregation, independent verification and main-chat delivery');
  } catch (error) { reportFailure(error); process.exitCode = 1; }
  finally {
    phaseDatabase?.close();
    socket?.close();
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else child.kill(); });
    provider.close(); console.log('FIXTURE ' + base);
  }
})().catch(error => { reportFailure(error); process.exitCode = 1; });
