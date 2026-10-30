import {
  isAppExecutionSessionQuery,
  type AppExecutionSessionQuery,
} from '@app-plugin/sdk/execution-source';

import type { WorkflowContext } from './context';
import { entry } from './native-context';

/** Read-only association; Native invocation policy remains the tool's authority. */
export async function readWorkflowExecutionSession(
  context: WorkflowContext,
  query: AppExecutionSessionQuery,
) {
  if (
    !isAppExecutionSessionQuery(query) ||
    !query.runId ||
    (query.ownerPluginId !== undefined && query.ownerPluginId !== context.api.id)
  )
    return null;
  const { store, engine } = context.ensure();
  const generation = context.state.generation;
  const locate = () => {
    if (context.state.generation !== generation) return null;
    const current = context.ensure();
    if (current.store !== store || current.engine !== engine) return null;
    const batch = store.batches.owner(query.sessionKey, query.runId!);
    const candidates = batch
      ? [store.get(batch.flowId, batch.nodeId)].filter(value => value !== undefined)
      : store.all().filter(flow => flow.nodes.some(node => node.sessionKey === query.sessionKey));
    if (candidates.length !== 1) return null;
    const flow = candidates[0];
    const node = flow.nodes.find(item => item.sessionKey === query.sessionKey);
    const native = entry(query.sessionKey);
    const parent = entry(flow.parentKey);
    if (
      !node ||
      !['running', 'paused', 'blocked'].includes(flow.status) ||
      !['preparing', 'running', 'uncertain'].includes(node.status) ||
      !node.dispatch ||
      query.runId !== (node.runId ?? node.intendedRunId) ||
      native?.sessionId !== query.nativeSessionId ||
      (query.lifecycleRevision !== undefined &&
        (native.lifecycleRevision ?? null) !== query.lifecycleRevision) ||
      (native.pluginOwnerId !== undefined && native.pluginOwnerId !== context.api.id) ||
      parent?.sessionId !== flow.parentId
    )
      return null;
    return {
      flow,
      node,
      fingerprint: JSON.stringify([
        flow.id,
        flow.parentKey,
        flow.parentId,
        flow.status,
        flow.controlVersion,
        node.id,
        node.sessionKey,
        node.agentId,
        node.attempt,
        node.status,
        node.runId,
        node.intendedRunId,
        node.dispatch.createdAt,
        native.sessionId,
        native.lifecycleRevision,
      ]),
    };
  };
  const before = locate();
  if (!before) return null;
  // A durable dispatch can precede run()'s accepted response. Native's exact
  // live receipt must independently confirm the intended ID before association.
  const run = await context.nativeSubagent().describeRun({ runId: query.runId });
  const current = locate();
  if (
    !current ||
    current.fingerprint !== before.fingerprint ||
    run.runId !== query.runId ||
    run.sessionKey !== query.sessionKey ||
    run.executionSettled ||
    !['accepted', 'running'].includes(run.state)
  )
    return null;
  return {
    sessionKey: query.sessionKey,
    nativeSessionId: query.nativeSessionId,
    runId: query.runId,
    parentKey: current.flow.parentKey,
    parentNativeSessionId: current.flow.parentId,
    label: `${current.node.agentName} · ${current.node.title}`
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .trim()
      .slice(0, 256),
  };
}
