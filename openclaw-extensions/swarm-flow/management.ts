import { createHash } from 'node:crypto';

import {
  type Flow,
  FLOW_LIMITS,
  FLOW_MANAGEMENT_TOOLS,
  type FlowAction,
  flowActions,
  type FlowNode,
} from './contract.js';
import type { FlowEngine } from './engine.js';
import { interventionAvailability } from './intervention.js';
import type { FlowStore } from './store.js';

export interface ManagementHost {
  current(): { store: FlowStore; engine: FlowEngine };
  assertParentIdentity(flow: Flow): void;
  assertParent(flow: Flow): void;
  invocation(toolCallId: string, name: string): { runId: string; assertCurrent(): void };
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const terminal = (flow: Flow) => ['completed', 'cancelled'].includes(flow.status);
const live = (node: FlowNode) => ['running', 'preparing', 'uncertain'].includes(node.status);
const bounded = (value?: string, length = 1200) =>
  value && (value.length <= length ? value : value.slice(0, length) + '…');
function nodeActions(flow: Flow, node: FlowNode) {
  const actions = interventionAvailability(flow, node);
  const reason = !actions.canNote
    ? 'Input unavailable: flow ended/stopping/delivering, node done/cancelled/deliver, or note limit reached.'
    : (node.attempt ?? 1) >= FLOW_LIMITS.attempts
      ? 'Execution attempt limit reached; input may still be saved.'
      : flow.nodes.some(live)
        ? 'Wait for all active/uncertain native runs to settle; input is for the next execution.'
        : node.status !== 'failed'
          ? 'Only failed nodes can continue or rerun.'
          : !node.deps.every(dep => flow.nodes.find(item => item.id === dep)?.status === 'done')
            ? 'Complete the dependencies first.'
            : flow.error
              ? 'Resolve the flow-level error first.'
              : !actions.canRetry
                ? 'Pause/block the flow before retrying.'
                : !actions.canContinue
                  ? 'There is no conclusively ended native run to continue; retry in a new session if available.'
                  : undefined;
  return { ...actions, unavailableReason: reason };
}

export function managementStatus(flow: Flow, nodeId?: string) {
  const node = nodeId ? flow.nodes.find(item => item.id === nodeId) : undefined;
  if (nodeId && !node) throw new Error('Flow node was not found. Query status for valid node IDs.');
  return {
    id: flow.id,
    revision: flow.revision,
    status: flow.status,
    goal: bounded(flow.goal),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    error: bounded(flow.error),
    actions: flowActions(flow),
    actionGuidance: {
      pause: 'Pause future dispatch only; active runs may finish.',
      resume: 'Only a paused flow without failed or uncertain nodes can resume.',
      retry:
        'Retries ALL conclusive failed nodes after every active run settles, within the attempt limit. Use intervene for one node.',
      stop: 'Requests cancellation; stopping is not yet cancelled.',
      unavailable:
        'Ended/delivering flows cannot be changed; uncertain runs must be resolved before replay.',
    },
    notificationUnconfirmed: flow.notices?.some(notice => notice.state !== 'sent') ?? false,
    counts: {
      total: flow.nodes.length,
      done: flow.nodes.filter(item => item.status === 'done').length,
      active: flow.nodes.filter(live).length,
      failed: flow.nodes.filter(item => item.status === 'failed').length,
    },
    nodes: flow.nodes.map(item => ({
      id: item.id,
      title: item.title,
      agent: '@' + (item.agentName || item.agentId || 'main'),
      kind: item.kind,
      status: item.status,
      deps: item.deps,
      attempt: item.attempt ?? 1,
      remainingAttempts: Math.max(0, FLOW_LIMITS.attempts - (item.attempt ?? 1)),
      error: bounded(item.error),
      result: bounded(item.result),
      ...nodeActions(flow, item),
    })),
    ...(node
      ? {
          node: {
            id: node.id,
            task: bounded(node.task, FLOW_LIMITS.goal),
            result: bounded(node.result, 8000),
            error: bounded(node.error),
            completion: node.completion && {
              outcome: node.completion.outcome,
              passed: node.completion.passed,
              summary: node.completion.summary,
              evidence: node.completion.evidence.slice(0, 4),
              evidenceTruncated: node.completion.evidence.length > 4,
            },
            attempts: (node.attempts ?? []).map(attempt => ({
              attempt: attempt.attempt,
              status: attempt.status,
              endedAt: attempt.endedAt,
              error: bounded(attempt.error),
              summary: bounded(attempt.receipt?.summary),
            })),
            interventionCount: node.interventions?.length ?? 0,
            interventions: (node.interventions ?? []).slice(-5).map(note => ({
              id: note.id,
              action: note.action,
              createdAt: note.createdAt,
              text: bounded(note.text, 1500),
            })),
            ...nodeActions(flow, node),
            inputDelivery:
              'Saved input is read on the next execution; it is not sent into an active run.',
          },
        }
      : {}),
  };
}

export const MANAGEMENT_GUIDANCE =
  'This conversation owns a durable Swarm flow. Use swarm_flow_status to read current state before answering progress questions or changing work; do not infer status from old chat. Use swarm_flow_control for pause/resume/stop/retry-all, and swarm_flow_intervene for node input/continue/retry-one. Act only on explicit user intent. Select exact IDs from status; clarify ambiguous targets. Existing flow management does not require selecting Swarm again. Never restart completed work, force acceptance, bypass permissions or execute the node task yourself. Input saved during a run is read on its next execution, not delivered live. Accepted control is a request, not proof of completion. Revision conflicts require another status read; do not automatically replay a changed operation.';

/** Plugin-owned task metadata only; no native chat history is read or cached here. */
export function createManagementTools(parentKey: string, host: ManagementHost) {
  const owned = () =>
    host
      .current()
      .store.all()
      .filter(flow => flow.parentKey === parentKey);
  const select = (id: unknown) => {
    const flows = owned();
    const flow =
      id === undefined
        ? (flows.find(item => !terminal(item)) ?? flows[0])
        : flows.find(item => item.id === id);
    if (id !== undefined && !flow)
      throw new Error('Flow does not belong to this conversation. Query status for valid IDs.');
    return flow;
  };
  const names = [
    FLOW_MANAGEMENT_TOOLS.status,
    ...(owned().length ? [FLOW_MANAGEMENT_TOOLS.control, FLOW_MANAGEMENT_TOOLS.intervene] : []),
  ];
  return names.map(name => ({
    name,
    label:
      name === FLOW_MANAGEMENT_TOOLS.status
        ? 'Query Swarm flow'
        : name === FLOW_MANAGEMENT_TOOLS.control
          ? 'Control Swarm flow'
          : 'Provide Swarm node input',
    description:
      name === FLOW_MANAGEMENT_TOOLS.status
        ? 'Read current conversation Swarm status, blockers, results and available actions. Defaults to unfinished or latest flow; specify nodeId for evidence and attempt/input details. No task execution or transcript copy.'
        : name === FLOW_MANAGEMENT_TOOLS.control
          ? 'Manage this conversation flow ONLY at user request. Read status first and supply its revision. pause stops future dispatch; resume unpauses; stop requests cancellation; retry retries ALL failed nodes. Use intervene to retry one node. Never infer acceptance or bypass an unavailable action.'
          : 'At explicit user request, save node input (note), continue a settled failed node in its existing session (continue), or rerun ONE failed node in a fresh session (retry). Query status first. Input is labelled as relayed by the main assistant. Running/uncertain nodes cannot be restarted; note is for the next execution, not live steering. Continue/retry share the three-attempt limit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        flowId: { type: 'string', minLength: 1, maxLength: 80 },
        ...(name !== FLOW_MANAGEMENT_TOOLS.control
          ? { nodeId: { type: 'string', minLength: 1, maxLength: 80 } }
          : {}),
        ...(name !== FLOW_MANAGEMENT_TOOLS.status
          ? {
              revision: { type: 'integer', minimum: 1 },
              action: {
                type: 'string',
                enum:
                  name === FLOW_MANAGEMENT_TOOLS.control
                    ? ['pause', 'resume', 'stop', 'retry']
                    : ['note', 'continue', 'retry'],
              },
            }
          : {}),
        ...(name === FLOW_MANAGEMENT_TOOLS.intervene
          ? { text: { type: 'string', maxLength: 3900 } }
          : {}),
      },
      required:
        name === FLOW_MANAGEMENT_TOOLS.status
          ? []
          : name === FLOW_MANAGEMENT_TOOLS.control
            ? ['flowId', 'revision', 'action']
            : ['flowId', 'nodeId', 'revision', 'action'],
    },
    async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
      try {
        const invocation = host.invocation(toolCallId, name);
        const assertCurrent = () => {
          if (signal?.aborted) throw new Error('Flow operation cancelled.');
          invocation.assertCurrent();
        };
        assertCurrent();
        const allowed =
          name === FLOW_MANAGEMENT_TOOLS.status
            ? ['flowId', 'nodeId']
            : name === FLOW_MANAGEMENT_TOOLS.control
              ? ['flowId', 'revision', 'action']
              : ['flowId', 'nodeId', 'revision', 'action', 'text'];
        if (
          !object(input) ||
          Object.keys(input).some(key => !allowed.includes(key)) ||
          ['flowId', 'nodeId'].some(
            key =>
              input[key] !== undefined &&
              (typeof input[key] !== 'string' || !input[key] || (input[key] as string).length > 80),
          )
        )
          throw new Error('Invalid management arguments. No operation was accepted.');
        let flow = select(input.flowId);
        if (name === FLOW_MANAGEMENT_TOOLS.status) {
          const flows = owned();
          const result = flow
            ? {
                ...managementStatus(flow, input.nodeId as string | undefined),
                flows: flows.slice(0, 20).map(item => ({
                  id: item.id,
                  status: item.status,
                  goal: bounded(item.goal, 160),
                  createdAt: item.createdAt,
                })),
                historyTruncated: flows.length > 20,
              }
            : { flow: null, message: 'No Swarm flow exists in this conversation.' };
          return {
            details: result,
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        }
        if (
          !flow ||
          typeof input.flowId !== 'string' ||
          !Number.isSafeInteger(input.revision) ||
          (input.revision as number) < 1
        )
          throw new Error('Specify a flowId and revision from status before changing work.');
        const action = input.action;
        const isControl = name === FLOW_MANAGEMENT_TOOLS.control;
        if (
          typeof action !== 'string' ||
          !(
            isControl ? ['pause', 'resume', 'stop', 'retry'] : ['note', 'continue', 'retry']
          ).includes(action)
        )
          throw new Error('Invalid management action.');
        if (isControl && (action === 'pause' || action === 'stop')) host.assertParentIdentity(flow);
        else host.assertParent(flow);
        if (
          !isControl &&
          (typeof input.nodeId !== 'string' ||
            (input.text !== undefined &&
              (typeof input.text !== 'string' || input.text.length > 3900)))
        )
          throw new Error('Invalid node input.');
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (!isControl && action === 'note' && !text) throw new Error('A note requires text.');
        const operationId =
          'm-' +
          createHash('sha256')
            .update(
              JSON.stringify([
                parentKey,
                invocation.runId,
                toolCallId,
                name,
                flow.id,
                input.nodeId ?? null,
                action,
                text,
              ]),
            )
            .digest('hex');
        const replayed = isControl
          ? (flow.operations?.some(item => item.id === operationId) ?? false)
          : flow.nodes.some(item => item.interventions?.some(note => note.id === operationId));
        if (!replayed && flow.revision !== input.revision)
          throw new Error('Flow revision conflict.');
        if (isControl && !replayed && !flowActions(flow)[action as FlowAction])
          throw new Error(
            'This control action is unavailable. Query status and inspect the action guidance.',
          );
        assertCurrent();
        const { engine } = host.current();
        if (isControl)
          flow = engine.control(
            flow.id,
            input.revision as number,
            action as FlowAction,
            operationId,
          );
        else {
          const chinese = /[\p{Script=Han}]/u.test(flow.goal);
          const relayed =
            text ||
            (action === 'continue'
              ? chinese
                ? '继续已分配任务，遵守原有约束并提交结果。'
                : 'Continue the assigned task within the existing constraints and submit its result.'
              : '');
          flow = engine.intervene(flow.id, input.nodeId as string, input.revision as number, {
            id: operationId,
            action,
            text: relayed
              ? (chinese ? '主助手转交：\n' : 'Relayed by the main assistant:\n') + relayed
              : '',
          });
        }
        const result = {
          accepted: true,
          replayed,
          action,
          flow: managementStatus(flow),
          message: isControl
            ? 'Control accepted; read the actual flow status. Completion/cancellation may still be pending.'
            : action === 'note'
              ? 'Input saved for the next execution; not delivered to an active run.'
              : 'Node execution requested; wait for its new accepted result and native terminal outcome.',
        };
        return {
          details: result,
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const result = {
          accepted: false,
          error: String(error),
          nextStep:
            'Read swarm_flow_status, inspect available actions, and correct arguments. Do not claim success or silently retry a different operation.',
        };
        return {
          isError: true,
          details: result,
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      }
    },
  }));
}
