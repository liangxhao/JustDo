import probePaths from './probe-paths.cjs';
const { hostRoot, pluginRoot, hostRequire } = probePaths;
// Disposable complete Workflow database fixtures. No user Gateway or account state.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { buildSync } = hostRequire("esbuild");


const compile = file => {
  const filename = path.resolve(file);
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  const module = new Module(filename);
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(output, filename);
  return module.exports;
};
const { FlowStore } = compile(path.join(pluginRoot, 'data/store.ts'));
const { workflowResources } = compile(path.join(pluginRoot, 'host/resources.ts'));
const { register } = compile(path.join(pluginRoot, 'host/app.ts'));
const temporary = mkdtempSync(path.join(tmpdir(), 'workflow-resource-probe-'));
let database;
try {
  const initialize = new FlowStore(temporary);
  initialize.close();
  database = new DatabaseSync(path.join(temporary, 'flows.sqlite'));
  const source = '11111111-1111-4111-8111-111111111111';
  const parentKey = `agent:main:justdo:${source}`;
  let runtime = { known: true, running: false, mainRunning: false, subagentRunning: false };
  const execution = { getSessionRuntimeStatus: async () => runtime };
  const participant = workflowResources({
    isEnabled: () => false,
    getRetainedPluginDataDirectory: () => temporary,
    getSessions: () => ({
      getSessionByNativeKey: key => (key === parentKey ? { id: source } : null),
    }),
    getExecution: () => execution,
  });
  const node = () => ({
    id: 'node',
    title: 'Synthetic stage',
    task: 'Synthetic fixture',
    deps: [],
    kind: 'work',
    access: 'read',
    status: 'done',
    sessionKey: 'agent:main:swarm-workflow:fixture',
    agentId: 'main',
    agentName: 'Fixture',
    runId: 'run',
    cleanupSettled: true,
    endedAt: 1,
  });
  const flow = () => ({
    id: 'flow',
    requestId: 'request',
    parentKey,
    parentId: 'native-parent',
    agentId: 'main',
    agents: [{ id: 'main', name: 'Fixture' }],
    cwd: temporary,
    permissionMode: 'guarded',
    mode: 'standard',
    goal: 'Synthetic fixture',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    status: 'completed',
    nodes: [node()],
  });
  const checks = {};
  const verify = async (name, input, blocked, extra = () => {}) => {
    database.exec('DELETE FROM execution_leases; DELETE FROM batch_items; DELETE FROM flows;');
    database
      .prepare('INSERT INTO flows VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.requestId, input.parentKey, input.revision, JSON.stringify(input));
    extra();
    if (blocked) await assert.rejects(participant.prepareDelete([source]));
    else await participant.prepareDelete([source]);
    checks[name] = true;
  };
  await verify('settledCompletedWhileDisabled', flow(), false);
  await verify(
    'settledCancelledWhileDisabled',
    { ...flow(), status: 'cancelled', nodes: [{ ...node(), status: 'cancelled' }] },
    false,
  );
  const missing = flow();
  delete missing.nodes;
  await verify('missingNodesBlocked', missing, true);
  await verify(
    'unknownNodeStateBlocked',
    { ...flow(), nodes: [{ ...node(), status: 'foreign-state' }] },
    true,
  );
  await verify(
    'cleanupUnsettledBlocked',
    { ...flow(), nodes: [{ ...node(), cleanupSettled: false }] },
    true,
  );
  await verify('retainedExecutionLeaseBlocked', flow(), true, () => {
    database.prepare('INSERT INTO execution_leases VALUES (?, ?, ?)').run('flow', 'item', 'run');
  });
  await verify('uncertainBatchItemBlocked', { ...flow(), status: 'cancelled' }, true, () => {
    const item = { ...node(), id: 'item', status: 'uncertain', cleanupSettled: false };
    database
      .prepare('INSERT INTO batch_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'flow',
        'stage',
        'item',
        0,
        item.status,
        item.sessionKey,
        'version',
        JSON.stringify(item),
      );
  });
  await verify('batchCleanupUnsettledBlocked', flow(), true, () => {
    const item = { ...node(), id: 'item', cleanupSettled: false };
    database
      .prepare('INSERT INTO batch_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'flow',
        'stage',
        'item',
        0,
        item.status,
        item.sessionKey,
        'version',
        JSON.stringify(item),
      );
  });
  runtime = { ...runtime, known: false };
  await verify('unknownNativeParentBlocked', flow(), true);
  runtime = { ...runtime, known: true, running: true };
  await verify('runningNativeParentBlocked', flow(), true);
  const release = participant.acquireDeletion([source]);
  assert.equal(participant.isDeleting(source), true);
  release();
  release();
  assert.equal(participant.isDeleting(source), false);
  checks.deletionLeaseReleasedOnce = true;
  runtime = { ...runtime, running: false };
  database.exec('DELETE FROM execution_leases; DELETE FROM batch_items; DELETE FROM flows;');
  const stopFlows = Array.from({ length: 21 }, (_, index) => ({
    ...flow(),
    id: `flow-${index}`,
    requestId: `request-${index}`,
    status: 'running',
  }));
  for (const item of stopFlows) {
    database
      .prepare('INSERT INTO flows VALUES (?, ?, ?, ?, ?)')
      .run(item.id, item.requestId, item.parentKey, item.revision, JSON.stringify(item));
  }
  const controls = [];
  const registration = register({
    manifest: { id: 'swarm-workflow' },
    getRetainedPluginDataDirectory: () => temporary,
    getSessions: () => ({
      getSessionByNativeKey: key => (key === parentKey ? { id: source } : null),
      getSession: () => ({ id: source }),
    }),
    getExecution: () => execution,
    getRuntime: () => ({ getSessionKeysForSession: () => [parentKey] }),
    requestConnectedGateway: (method, params) => {
      controls.push({ method, params });
      throw new Error('Source cancellation must not control independent workflows');
    },
  });
  await registration.submission.cancel(source);
  await registration.submission.cancel(source, 'cancelled-source-turn');
  checks.sourceCancellationDoesNotControlWorkflows = controls.length === 0;
  checks.sourceCancellationPreservesAllOwnedFlows = stopFlows.every(item => {
    const row = database.prepare('SELECT payload FROM flows WHERE id=?').get(item.id);
    return row && JSON.parse(String(row.payload)).status === 'running';
  });
  await assert.rejects(registration.beforePackageMutation(), /swarmWorkflowDeleteUnresolved/);
  checks.unsettledFlowsStillBlockPackageMutation = true;
  console.log(JSON.stringify({ realSqlite: true, completeWorkflowSchema: true, checks }));
  assert.ok(
    Object.values(checks).every(Boolean),
    'Every retained Workflow obligation must remain covered',
  );
} finally {
  database?.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('workflow-resource-probe-'));
  rmSync(temporary, { recursive: true, force: true });
}
