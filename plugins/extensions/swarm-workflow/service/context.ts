import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { managedSubagent } from '@runtime-services/sdk/execution';
import { createRuntimeServicesClient } from '@runtime-services/sdk/native-client';
import {
  assertFilesystemAdmission,
  permissionFingerprint,
} from '@runtime-services/sdk/filesystem';
import { prepareItemWorkspace } from '../batch/snapshot';
import { DEFAULT_FLOW_AGENT, type Flow, type FlowAgent, type FlowNode } from '../contracts/flow';
import { assertCrossAgentPolicy, parentPolicy } from '../execution/policy';
import { entry, inPlanMode } from './native-context';
import { createResultBudgetTracker } from './result-budget';
import { state } from './state';

export function createWorkflowContext(api: OpenClawPluginApi) {
  const runtimeServices = createRuntimeServicesClient(api);
  let capabilityPreparation: Promise<boolean> | undefined;
  const prepareRuntimeServices = () => {
    if (runtimeServices.captureCapabilities()) return Promise.resolve(true);
    return capabilityPreparation ??= runtimeServices.bind().finally(() => {
      capabilityPreparation = undefined;
    });
  };
  const nativeSubagent = () => managedSubagent(api, runtimeServices.captureCapabilities());
  const resultBudgets = (state.resultBudgets ??= createResultBudgetTracker());
  const submissionCalls = state.submissionCalls;
  const managementCalls = state.managementCalls;
  const callKey = (sessionKey: string, toolCallId: string, name: string) =>
    JSON.stringify([sessionKey, toolCallId, name]);
  const rpc = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>) =>
    api.runtime.gateway.request<T>(method, params, {
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      timeoutMs: 15000,
    });
  const assertParentIdentity = (flow: Flow) => {
    const current = entry(flow.parentKey);
    if (!current || current.sessionId !== flow.parentId)
      throw new Error('Parent identity changed. Flow management is blocked.');
    return current;
  };
  const assertParent = (flow: Flow) => {
    if (flow.filesystemAdmission) assertFilesystemAdmission(flow.filesystemAdmission);
    const current = assertParentIdentity(flow);
    if (
      current.permissionMode !== flow.permissionMode ||
      current.sessionRoot !== flow.cwd ||
      parentPolicy(current) !== flow.policy ||
      (flow.filesystemAdmission &&
        permissionFingerprint(api.runtime.config.current(), flow.filesystemAdmission.agentIds) !==
          flow.filesystemAdmission.policy) ||
      inPlanMode(current)
    )
      throw new Error(
        'Parent identity, permissions or project changed. Flow admission is blocked.',
      );
  };
  const ensure = () => {
    if (!state.engine || !state.store) throw new Error('Swarm Workflow service is unavailable.');
    return { engine: state.engine, store: state.store };
  };
  const availableAgents = async (): Promise<FlowAgent[]> => {
    const result = await rpc<{ agents?: Array<Record<string, unknown>> }>('agents.list', {});
    if (!Array.isArray(result.agents)) throw new Error('Native agent roster is unavailable.');
    // Product availability only gates new Swarm Workflow stages; native history and
    // authorization for other entry points remain owned by OpenClaw.
    const configured =
      api.runtime.config.current().plugins?.entries?.['swarm-workflow']?.config?.availableAgentIds;
    if (
      configured !== undefined &&
      (!Array.isArray(configured) || !configured.every(id => typeof id === 'string'))
    ) {
      throw new Error('Product agent roster is unavailable.');
    }
    const available = new Set(configured ?? [DEFAULT_FLOW_AGENT]);
    return result.agents
      .filter(
        agent =>
          typeof agent.id === 'string' &&
          /^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent.id) &&
          available.has(agent.id) &&
          !agent.admissionRefusal,
      )
      .map(agent => ({
        id: agent.id as string,
        name:
          typeof agent.name === 'string' && agent.name.trim() ? agent.name : (agent.id as string),
      }));
  };
  const prepare = async (flow: Flow, node: FlowNode) => {
    nativeSubagent();
    assertParent(flow);
    assertCrossAgentPolicy(api.runtime.config.current(), flow.agentId, node.agentId);
    if (!(await availableAgents()).some(agent => agent.id === node.agentId))
      throw new Error('Assigned agent is no longer available: ' + node.agentId);
    const current = () => {
      assertParent(flow);
      const latest = ensure().store.get(flow.id, node.id);
      const item = latest?.nodes.find(candidate => candidate.id === node.id);
      if (
        !latest ||
        latest.status !== 'running' ||
        latest.controlVersion !== flow.controlVersion ||
        !item ||
        item.status !== 'preparing' ||
        item.sessionKey !== node.sessionKey ||
        item.attempt !== node.attempt
      )
        throw new Error('Native preparation admission revoked.');
    };
    current();
    if (node.batchItem) await prepareItemWorkspace(flow, node, current);
    current();
    // Task access classifies scheduling and task intent, not native authority.
    // Native read-only denies even inspection commands; preserve the user's
    // selected session permission ceiling for every stage instead.
    const permissionMode = flow.permissionMode;
    const policy = JSON.parse(flow.policy!);
    const created = await rpc<{
      key?: string;
      sessionId?: string;
      entry?: Record<string, unknown>;
    }>('sessions.create', {
      key: node.sessionKey,
      agentId: node.agentId,
      // These are plugin-owned execution sessions. The workflow owns the
      // association; native parent linkage is reserved for native spawning.
      cwd: node.batchItem?.workspace ?? flow.cwd,
      permissionMode,
      toolOverrides: policy.toolOverrides,
      ...(node.agentId === flow.agentId && policy.model ? { model: policy.model } : {}),
      displayName: node.title,
      // A deterministic native key provides create-or-adopt identity. The optional
      // session-create idempotency token requires a device principal unavailable
      // to service-owned calls; run admission uses its separate durable run ID.
    });
    if (
      created.key !== node.sessionKey ||
      created.entry?.permissionMode !== permissionMode ||
      created.entry?.sessionRoot !== (node.batchItem?.workspace ?? flow.cwd)
    )
      throw new Error('Native child policy could not be verified.');
    assertParent(flow);
    current();
  };

  return {
    api,
    runtimeServices,
    prepareRuntimeServices,
    nativeSubagent,
    state,
    resultBudgets,
    submissionCalls,
    managementCalls,
    callKey,
    rpc,
    assertParentIdentity,
    assertParent,
    ensure,
    availableAgents,
    prepare,
  };
}
export type WorkflowContext = ReturnType<typeof createWorkflowContext>;
