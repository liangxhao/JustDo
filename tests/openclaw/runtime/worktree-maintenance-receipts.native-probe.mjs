// Executes the native maintenance owner; only scheduling and filesystem work are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const { runtimeRoot, identity } = resolveNativeSmokeTarget();
const artifacts = path.resolve('.agent-tasks/runtime/worktree-maintenance');
await fs.mkdir(artifacts, { recursive: true });
const state = await fs.mkdtemp(path.join(artifacts, 'receipt-'));
for (const name of Object.keys(process.env)) {
  const upper = name.toUpperCase();
  if (
    upper.startsWith('OPENCLAW_') ||
    ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(upper)
  ) {
    delete process.env[name];
  }
}
Object.assign(process.env, {
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
  OPENCLAW_NO_RESPAWN: '1',
});
const config = {
  agents: {
    ownership: 'explicit',
    entries: { main: {} },
    defaults: { embeddedAgent: { cyberFailover: { mode: 'off' } } },
  },
  plugins: { enabled: false, allow: [], entries: {} },
  update: { checkOnStart: false, auto: { enabled: false } },
};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
const dist = path.join(runtimeRoot, 'dist');
const owners = [];
for (const file of (await fs.readdir(dist)).filter(name =>
  /^worktree-maintenance-.*\.mjs$/.test(name),
)) {
  const source = await fs.readFile(path.join(dist, file), 'utf8');
  const tail = source.slice(source.lastIndexOf('\nexport {'));
  const alias = name => tail.match(new RegExp(`\\b${name}(?: as (\\w+))?\\s*[,}]`))?.[1] ?? name;
  if (
    source.includes('function startWorktreeMaintenance(') &&
    tail.includes('requestGatewayWorktreeMaintenance')
  ) {
    owners.push({
      file,
      start: alias('startWorktreeMaintenance'),
      request: alias('requestGatewayWorktreeMaintenance'),
    });
  }
}
assert.equal(owners.length, 1);
const selected = owners[0];
const native = await import(pathToFileURL(path.join(dist, selected.file)).href);
const start = native[selected.start];
const request = native[selected.request];
assert.equal(typeof start, 'function');
assert.equal(typeof request, 'function');
const cases = [];
for (const mode of ['completed', 'failed']) {
  const controller = new AbortController();
  const jobs = new Map();
  let executions = 0;
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const scheduler = {
    scope() {
      return this;
    },
    signal: controller.signal,
    now: () => Date.now(),
    schedule(job) {
      jobs.set(job.id, job);
    },
    async stop() {
      controller.abort();
    },
  };
  const getRuntimeConfig = () => config;
  const owner = start({
    scheduler,
    getRuntimeConfig,
    onComplete() {},
    onError() {},
    runGc: async () => {
      executions += 1;
      await gate;
      if (mode === 'failed') throw new Error('Native fixture maintenance rejected');
      return { removed: ['native-fixture-tree'], orphansDeleted: 1, snapshotsPruned: 2 };
    },
  });
  try {
    const queued = request(getRuntimeConfig, {});
    assert.equal(queued.state, 'queued');
    assert.equal(request(getRuntimeConfig, {}).jobId, queued.jobId);
    assert.equal(executions, 0);
    const runningTask = jobs.get('maintenance:worktrees:run').run();
    for (let turn = 0; turn < 20 && executions === 0; turn += 1) await Promise.resolve();
    assert.equal(executions, 1);
    const running = request(getRuntimeConfig, { jobId: queued.jobId });
    assert.equal(running.state, 'running');
    assert.throws(() => request(getRuntimeConfig, { jobId: 'wrong-native-job' }), /latest job/);
    release();
    await runningTask;
    const terminal = request(getRuntimeConfig, { jobId: queued.jobId });
    assert.equal(terminal.state, mode);
    assert.equal(terminal.jobId, queued.jobId);
    assert.equal(executions, 1);
    const changedCopy = request(getRuntimeConfig, { jobId: queued.jobId });
    changedCopy.state = 'forged';
    assert.equal(request(getRuntimeConfig, { jobId: queued.jobId }).state, mode);
    cases.push({ mode, queued, running, terminal, executions });
  } finally {
    release();
    await owner.stop();
  }
}
const result = {
  identity,
  owner: selected.file,
  cases,
  limits:
    'No Gateway or worktree filesystem operations; native scheduler boundary and runGc are controlled.',
};
await fs.writeFile(path.join(state, 'result.json'), JSON.stringify(result, null, 2));
console.log(`NATIVE_WORKTREE_RECEIPTS=${JSON.stringify(result)}`);
