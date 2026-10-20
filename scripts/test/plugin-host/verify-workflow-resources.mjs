// Disposable complete Workflow database fixtures. No user Gateway or account state.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildSync } from 'esbuild';

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
const { FlowStore } = compile('plugins/extensions/swarm-workflow/data/store.ts');
const { workflowResources } = compile('plugins/extensions/swarm-workflow/host/resources.ts');
const { register } = compile('plugins/extensions/swarm-workflow/host/app.ts');
const { SwarmWorkflowGateway } = compile('plugins/extensions/swarm-workflow/contracts/workflow.ts');
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
    getNativeStateDirectory: () => temporary,
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
  let stopParentKeys = [parentKey];
  let controlFailure = 'none';
  const registration = register({
    manifest: { id: 'swarm-workflow' },
    getNativeStateDirectory: () => temporary,
    getSessions: () => ({
      getSessionByNativeKey: key => (key === parentKey ? { id: source } : null),
      getSession: () => ({ id: source }),
    }),
    getExecution: () => execution,
    getRuntime: () => ({ getSessionKeysForSession: () => stopParentKeys }),
    requestConnectedGateway: (method, params) => {
      // The existing native UI List RPC intentionally returns only its first 20.
      if (method === SwarmWorkflowGateway.List)
        return Promise.resolve({ flows: stopFlows.slice(0, 20) });
      assert.equal(method, SwarmWorkflowGateway.Control);
      controls.push(params);
      if (params.id === stopFlows[0].id) {
        if (controlFailure === 'sync') throw new Error('synchronous unresolved stop');
        if (controlFailure === 'async') return Promise.reject(new Error('unresolved stop'));
      }
      return Promise.resolve({ success: true });
    },
  });
  await registration.submission.cancel(source);
  checks.stopCoversAllOwnedFlows = stopFlows.every(item =>
    controls.some(
      control =>
        control.id === item.id && control.revision === item.revision && control.action === 'stop',
    ),
  );
  controls.length = 0;
  controlFailure = 'async';
  let stopFailed = false;
  try {
    await registration.submission.cancel(source);
  } catch {
    stopFailed = true;
  }
  checks.stopFailureStillAttemptsOtherFlows =
    stopFailed && stopFlows.every(item => controls.some(control => control.id === item.id));
  controls.length = 0;
  controlFailure = 'sync';
  stopFailed = false;
  try {
    await registration.submission.cancel(source);
  } catch {
    stopFailed = true;
  }
  checks.synchronousStopFailureStillAttemptsOtherFlows =
    stopFailed && stopFlows.every(item => controls.some(control => control.id === item.id));
  controls.length = 0;
  controlFailure = 'none';
  stopParentKeys = undefined;
  stopFailed = false;
  try {
    await registration.submission.cancel(source);
  } catch {
    stopFailed = true;
  }
  checks.missingRuntimeIdentityCannotSilentlySkipOwnedStops =
    stopFailed || stopFlows.every(item => controls.some(control => control.id === item.id));
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
