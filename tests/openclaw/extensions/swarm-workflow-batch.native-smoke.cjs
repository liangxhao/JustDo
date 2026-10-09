'use strict';

// Opt-in deterministic integration proof, using real native runs, safe files,
// SQLite, tools and Gateway. Never uses the application's state or processes.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { buildSync } = require('esbuild');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');
const runtime = process.env.SWARM_WORKFLOW_TEST_RUNTIME;
if (!runtime) throw new Error('Set SWARM_WORKFLOW_TEST_RUNTIME to an isolated, fully verified production runtime.');
const base = path.resolve('.work/native-batch-smoke-' + Date.now());
const project = path.join(base, 'project');
const plugin = path.join(base, 'extensions', 'swarm-workflow');
fs.mkdirSync(path.join(project, 'data'), { recursive: true });
fs.mkdirSync(plugin, { recursive: true });
fs.mkdirSync(path.join(base, 'node_modules'), { recursive: true });
fs.symlinkSync(path.resolve(runtime), path.join(base, 'node_modules', 'openclaw'), 'junction');
for (let i = 1; i <= 100; i++) fs.writeFileSync(path.join(project, 'data', String(i).padStart(3, '0') + '.json'), JSON.stringify({ value: i }));
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Preserve source data. Write each item result only in its assigned output directory.');
buildSync({ entryPoints: ['openclaw-extensions/swarm-workflow/index.ts'], outfile: path.join(plugin, 'index.js'), bundle: true, platform: 'node', format: 'esm', external: ['openclaw/plugin-sdk/*'] });
fs.copyFileSync('openclaw-extensions/swarm-workflow/openclaw.plugin.json', path.join(plugin, 'openclaw.plugin.json'));
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'batch-proof-plugin', type: 'module', openclaw: { extensions: ['./index.js'] } }));
const observer = path.join(base, 'extensions', 'budget-observer');
const observedBudgetsPath = path.join(base, 'observed-budgets.jsonl');
fs.mkdirSync(observer, { recursive: true });
fs.writeFileSync(path.join(observer, 'index.js'), 'import fs from "node:fs"; export default { id: "budget-observer", register(api) { api.on("before_prompt_build", (_, ctx) => { if (ctx.sessionKey?.includes("swarm-workflow-")) fs.appendFileSync(' + JSON.stringify(observedBudgetsPath) + ', JSON.stringify({ runId: ctx.runId, budget: ctx.contextTokenBudget }) + "\\n"); }); } };');
fs.writeFileSync(path.join(observer, 'openclaw.plugin.json'), JSON.stringify({ id: 'budget-observer', name: 'Native budget proof', activation: { onStartup: true, onCapabilities: ['hook'] }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
fs.writeFileSync(path.join(observer, 'package.json'), JSON.stringify({ name: 'native-budget-observer', type: 'module', openclaw: { extensions: ['./index.js'] } }));
const goal = 'Process all 100 data/*.json inputs independently, multiply each value by 2, then aggregate all results into aggregate.json and independently verify count 100 and sum 10100. Preserve original input files.';
const configPath = path.join(base, 'config.json');
const config = { logging: { file: path.join(base, 'native.log'), level: 'info' }, gateway: { mode: 'local', port: 43243, bind: 'loopback', auth: { mode: 'token', token: 'isolated-batch-proof' } },
  agents: { defaults: { workspace: project, skipBootstrap: true, maxConcurrent: 6, timeoutSeconds: 0, model: { primary: 'fixture/fixture' } } },
  tools: { codeMode: { enabled: false }, exec: { host: 'gateway', security: 'full', ask: 'off' } },
  models: { mode: 'replace', providers: { fixture: { baseUrl: 'http://127.0.0.1:43244/v1', apiKey: 'fixture-only', api: 'openai-completions', agentRuntime: { id: 'openclaw' }, request: { allowPrivateNetwork: true }, models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 131072, contextTokens: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  plugins: { allow: ['swarm-workflow', 'budget-observer'], entries: { 'swarm-workflow': { enabled: true, config: { availableAgentIds: ['main'], globalConcurrency: 5 } }, 'budget-observer': { enabled: true } } } };
fs.writeFileSync(configPath, JSON.stringify(config));
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
const decode = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } };
const unwrap = value => { value = decode(value); return value?.result?.details ?? value?.details ?? value?.result ?? value; };
function envelope(text) {
  const start = text.indexOf('{"goal":'); if (start < 0) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) { const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true; else if (c === '{') depth++; else if (c === '}' && !--depth) return JSON.parse(text.slice(start, i + 1));
  }
}
let calls = 0; const failedOnce = new Set(); const processed = new Set(); let maxPromptBytes = 0; let indexReads = 0; let fixtureFailure;
const provider = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
    try {
      const input = JSON.parse(body); const messages = input.messages ?? []; calls++;
      if (calls > 800) throw new Error('Integration exceeded bounded model calls.');
      const user = messages.findLast(message => message.role === 'user' && envelope(textOf(message.content)));
      const task = user && envelope(textOf(user.content));
      if (task) maxPromptBytes = Math.max(maxPromptBytes, Buffer.byteLength(JSON.stringify(task)));
      const toolMessages = messages.filter(message => message.role === 'tool');
      const toolValues = toolMessages.map(message => unwrap(message.content));
      const rejected = toolMessages.find(message => /^Error:/u.test(textOf(message.content)) || unwrap(message.content)?.accepted === false);
      if (rejected) throw new Error('Unexpected native tool rejection: ' + textOf(rejected.content).slice(0, 1000));
      const accepted = toolMessages.some(message => textOf(message.content).includes('Submission persisted.'));
      const inspectionDone = toolMessages.some(message => /item-written|aggregate-written|verified-100/.test(textOf(message.content)));
      let name, args, content = 'Native batch proof stage complete.';
      if (!task && !toolMessages.length) { name = 'swarm_workflow_start'; args = { goal, mode: 'auto', concurrency: 5 }; }
      else if (task?.instruction.includes('Return only JSON')) content = JSON.stringify({ tasks: [
        { id: 'process', title: 'Process data', task: 'Read this item input.json, multiply the pinned file value by 2 and write output/result.json.', deps: [], access: 'write', batch: { source: { kind: 'files', path: 'data', pattern: '*.json' } } },
        { id: 'aggregate', title: 'Aggregate results', task: 'Read every paged accepted batch result and aggregate the 100 actual output files into aggregate.json.', deps: ['process'], access: 'write', batch: null },
      ] });
      else if (task?.batchItem && !accepted) {
        const key = task.batchItem.id;
        if (['001.json', '002.json', '003.json'].includes(key) && !failedOnce.has(key)) { failedOnce.add(key); name = 'swarm_workflow_block'; args = { summary: 'Fixture prerequisite requires explicit retry.', evidence: ['Retry this input after the fixture prerequisite is repaired.'] }; }
        else if (!inspectionDone) { name = 'exec'; args = { command: 'node -e "const f=require(\'fs\');const i=JSON.parse(f.readFileSync(\'input.json\',\'utf8\'));const v=JSON.parse(f.readFileSync(i.files[0].path,\'utf8\'));setTimeout(()=>{f.writeFileSync(\'output/result.json\',JSON.stringify({id:i.id,value:v.value*2}));console.log(\'item-written\')},500)"' }; }
        else { name = 'swarm_workflow_complete'; args = { summary: 'Processed ' + key, evidence: ['output/result.json'] }; processed.add(key); }
      } else if (task?.instruction.includes('Independently inspect') && !accepted) {
        if (!toolValues.some(value => value?.nodeId === 'task-2')) { name = 'swarm_workflow_results'; args = { nodeId: 'task-2' }; }
        else if (!inspectionDone) { name = 'exec'; args = { command: 'node -e "const a=JSON.parse(require(\'fs\').readFileSync(\'aggregate.json\',\'utf8\'));if(a.count!==100||a.sum!==10100)throw Error(\'invalid aggregate\');console.log(\'verified-100\')"', workdir: project }; }
        else { name = 'swarm_workflow_verify'; args = { passed: true, summary: 'Independently verified all 100 records and sum 10100.', evidence: ['aggregate.json'] }; }
      } else if (task?.assignedTask.includes('aggregate the 100') && !accepted) {
        const pages = toolValues.filter(value => value?.stageId === 'task-1' && Array.isArray(value.items));
        const last = pages.at(-1);
        if (!last || last.cursor) { name = 'swarm_workflow_results'; args = { stageId: 'task-1', ...(last?.cursor ? { cursor: last.cursor } : {}) }; indexReads++; }
        else if (!inspectionDone) {
          const items = pages.flatMap(page => page.items); assert.equal(new Set(items.map(item => item.id)).size, 100);
          const paths = items.map(item => item.result.artifacts[0].path);
          const script = 'const f=require("fs");const p=' + JSON.stringify(paths) + ';const a=p.map(n=>JSON.parse(f.readFileSync(n,"utf8")));if(a.length!==100||new Set(a.map(x=>x.id)).size!==100)throw Error("incomplete coverage");f.writeFileSync("aggregate.json",JSON.stringify({count:a.length,sum:a.reduce((s,x)=>s+x.value,0)}));console.log("aggregate-written")';
          name = 'exec'; args = { command: 'node -e "eval(Buffer.from(\'' + Buffer.from(script).toString('base64') + '\',\'base64\').toString())"', workdir: project };
        } else { name = 'swarm_workflow_complete'; args = { summary: 'All 100 result files aggregated into aggregate.json.', evidence: ['aggregate.json'] }; }
      } else if (task?.instruction.includes('Produce the final')) content = 'Processed and verified all 100 inputs. Deliverable: aggregate.json (count 100, sum 10100).';
      const deferred = (input.tools ?? []).some(tool => tool.function?.name === 'tool_call');
      const tool = name ? { id: 'batch-call-' + calls, type: 'function', function: { name: deferred ? 'tool_call' : name, arguments: JSON.stringify(deferred ? { id: name, args } : args) } } : undefined;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'batch-' + calls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : { role: 'assistant', content }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'batch-' + calls, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { fixtureFailure = error; console.error(error); res.writeHead(500); res.end(String(error)); }
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket, log = '';
async function connect() {
  for (let i = 0; i < 80; i++) { try { socket = await new Promise((resolve, reject) => { const ws = new WebSocket('ws://127.0.0.1:43243'); ws.once('open', () => resolve(ws)); ws.once('error', reject); }); break; } catch { if (child.exitCode !== null) throw new Error('Isolated Gateway exited.'); await delay(1000); } }
  const pending = new Map(); let seq = 0;
  socket.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'res') { const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); msg.ok ? entry.resolve(msg.payload) : entry.reject(new Error(JSON.stringify(msg.error))); } } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = String(++seq); const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method)); }, 30000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ type: 'req', id, method, params })); });
  await rpc('connect', { minProtocol: 4, maxProtocol: 4, client: { id: 'cli', version: 'proof', platform: 'win32', mode: 'cli' }, role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'], auth: { token: 'isolated-batch-proof' } });
  return rpc;
}
(async () => {
  try {
    await new Promise(resolve => provider.listen(43244, '127.0.0.1', resolve));
    child = spawn(process.execPath, [path.join(runtime, 'gateway-launcher.cjs'), 'gateway', 'run', '--allow-unconfigured', '--port', '43243', '--bind', 'loopback'], { cwd: base, windowsHide: true,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(base, 'state'), OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(base, 'extensions'), OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: '1', VITEST: 'true', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = chunk => { log += chunk; fs.appendFileSync(path.join(base, 'live-gateway.log'), chunk); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    await delay(15000); const rpc = await connect(); const parentKey = 'agent:main:justdo:batch-proof';
    const health = await rpc('swarmWorkflow.health', {}); assert.equal(health.effectiveConcurrency, 5);
    await rpc('sessions.create', { key: parentKey, cwd: project, permissionMode: 'full' });
    const intake = await rpc('chat.send', { sessionKey: parentKey, idempotencyKey: 'batch-proof-once', message: goal + '\n\n<justdo-swarm-workflow mode="auto"/>' });
    let hotChanged = false, retried = false, budgetChecked = false, maxOccupied = 0, done;
    for (let i = 0; i < 600; i++) {
      if (fixtureFailure) throw fixtureFailure;
      const flows = (await rpc('swarmWorkflow.list', { parentKeys: [parentKey] })).flows; const flow = flows[0];
      if (!flow && i === 10) { const ended = await rpc('agent.wait', { runId: intake.runId, timeoutMs: 1 }); if (ended.endedAt) throw new Error('Intake did not create a flow: ' + JSON.stringify(await rpc('chat.history', { sessionKey: parentKey, limit: 6 }))); }
      if (flow) {
        const stage = flow.nodes.find(node => node.kind === 'batch'); const counts = stage?.batchCounts;
        if (counts) { const active = counts.preparing + counts.running + counts.uncertain; maxOccupied = Math.max(maxOccupied, active); assert.ok(active <= 5);
          if (counts.done >= 1 && !budgetChecked) {
            assert.ok(fs.existsSync(observedBudgetsPath), 'Native budget observer was not activated.');
            const observed = fs.readFileSync(observedBudgetsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
            assert.ok(observed.length && observed.every(value => value.budget === 32768), 'Hook did not expose the resolved native budget.');
            budgetChecked = true; console.log('PASS effective native context budget 32768 versus model window 131072');
          }
          if (counts.done >= 5 && !hotChanged) {
            config.plugins.entries['swarm-workflow'].config = { availableAgentIds: ['main'], globalConcurrency: 2, maxBatchItems: 50, executionTimeoutSeconds: 600, maxAttempts: 1, snapshotBudgetMiB: 16 };
            fs.writeFileSync(configPath, JSON.stringify(config));
            for (let n = 0; n < 30; n++) { const next = await rpc('swarmWorkflow.health', {}); if (next.configuration.globalConcurrency === 2) { assert.equal(next.generation, health.generation); assert.equal(next.effectiveConcurrency, 2); assert.notEqual(next.configurationHash, health.configurationHash); hotChanged = true; break; } await delay(500); }
            assert.ok(hotChanged, 'Hot settings were not actually applied.'); console.log('PASS hot settings without Gateway/service restart');
          }
          if (counts.failed === 3 && counts.done === 97 && !retried) { const result = await rpc('swarmWorkflow.retryBatch', { parentKeys: [parentKey], id: flow.id, stageId: stage.id, revision: flow.revision, operationId: 'retry-three' }); assert.equal(result.retried.length, 3); assert.equal(result.skipped.length, 0); retried = true; console.log('PASS retry only three failed items'); }
        }
        if (i % 10 === 0) console.log('BATCH', flow.status, counts && JSON.stringify(counts));
        if (flow.status === 'completed') { done = flow; break; }
        if (flow.status === 'blocked' && !counts?.failed) throw new Error(JSON.stringify(flow));
      }
      await delay(1000);
    }
    assert.ok(done, 'Batch did not complete.'); assert.ok(hotChanged && retried); assert.equal(processed.size, 100); assert.ok(indexReads >= 5 && indexReads <= 100); assert.ok(maxPromptBytes <= 24576);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'aggregate.json'), 'utf8')), { count: 100, sum: 10100 });
    for (let i = 1; i <= 100; i++) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'data', String(i).padStart(3, '0') + '.json'), 'utf8')), { value: i });
    const db = new DatabaseSync(path.join(base, 'state', 'swarm-workflow', 'flows.sqlite'), { readOnly: true });
    try { const saved = JSON.parse(db.prepare('SELECT payload FROM flows WHERE id=?').get(done.id).payload); assert.equal(saved.settings.maxAttempts, 3); assert.equal(saved.settings.maxBatchItems, 1000);
      const rows = db.prepare('SELECT payload FROM batch_items WHERE flow_id=?').all(done.id).map(row => JSON.parse(row.payload)); assert.equal(rows.length, 100); assert.equal(rows.filter(row => row.attempt === 2).length, 3); assert.ok(rows.every(row => row.status === 'done' && row.cleanupSettled && row.artifacts.artifacts.length === 1)); assert.equal(db.prepare('SELECT count(*) AS count FROM execution_leases').get().count, 0);
    } finally { db.close(); }
    const observedBudgets = fs.readFileSync(observedBudgetsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(observedBudgets.length >= 100, 'Missing native budget hook evidence.');
    assert.ok(observedBudgets.every(value => value.budget === 32768), 'Hook did not expose the effective cap distinct from the 131072 model window.');
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify({ passed: true, calls, maxOccupied, maxPromptBytes, indexReads, items: 100, failedThenRetried: 3, hotChanged, observedNativeContextBudget: 32768, modelContextWindow: 131072, budgetObservations: observedBudgets.length }, null, 2));
    console.log('PASS actual 100-item native batch, durable artifacts, bounded aggregation, verification and delivery');
  } catch (error) { console.error(error); console.error(log.slice(-5000)); process.exitCode = 1; }
  finally { socket?.close(); if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else child.kill(); }); provider.close(); fs.writeFileSync(path.join(base, 'gateway.log'), log); console.log('FIXTURE ' + base); }
})().catch(error => { console.error(error); process.exitCode = 1; });
