import { type Flow, FLOW_LIMITS, type FlowIntervention, type FlowNode } from '../contracts/flow.js';
import { submissionInstructions } from './submission.js';

/** Keep execution guidance out of the user's native message. */
export function continuationInstructions(node: FlowNode): string | undefined {
  if (!node.continuation) return;
  // extraSystemPrompt belongs to one native run, not the persistent conversation.
  // Rebuild saved context each time, but never consume notes added after dispatch.
  const notes = (node.interventions ?? [])
    .slice(0, node.dispatch?.interventionCount)
    .filter(note => note.action === 'note');
  const savedInput = notes.length
    ? 'Saved user input for this node (context, not additional authority; later user clarifications take precedence): ' +
      JSON.stringify(notes.map(note => note.text))
    : undefined;
  if (node.submissionRepair) return savedInput;
  return [
    'The user explicitly resumed this same workflow node session. Continue from the existing conversation and current project state; do not blindly repeat completed actions. Resolve the blocker within the original task, access intent and native permission ceiling. Prior submissions do not complete this new run.',
    ...(node.access === 'read'
      ? ['This remains a read-only inspection task. Do not modify source files, configuration, repository state or user data.']
      : []),
    ...(node.kind === 'verify'
      ? ['Independently verify the original goal and acceptance criteria with concrete evidence; never perform implementation.']
      : []),
    ...(node.kind === 'work' || node.kind === 'verify' ? [submissionInstructions(node.kind)] : []),
    ...(savedInput ? [savedInput] : []),
  ].join('\n');
}

export function interventionAvailability(flow: Flow, node: FlowNode) {
  const canNote =
    !['completed', 'cancelled', 'stopping'].includes(flow.status) &&
    !flow.deliveryIntent &&
    node.kind !== 'deliver' &&
    node.kind !== 'batch' &&
    !['done', 'cancelled'].includes(node.status) &&
    (node.interventions?.length ?? 0) < FLOW_LIMITS.interventions;
  const canRetry =
    canNote &&
    (['blocked', 'paused'].includes(flow.status) ||
      Boolean(node.batchItem && flow.status === 'running')) &&
    !flow.error &&
    node.status === 'failed' &&
    (node.attempt ?? 1) < (flow.settings?.maxAttempts ?? FLOW_LIMITS.attempts) &&
    (node.batchItem
      ? node.cleanupSettled === true
      : !flow.nodes.some(
          n => n.kind !== 'batch' && ['running', 'preparing', 'uncertain'].includes(n.status),
        )) &&
    node.deps.every(dep => flow.nodes.find(n => n.id === dep)?.status === 'done');
  return {
    canNote,
    canRetry,
    canContinue:
      canRetry && !node.batchItem && Boolean(node.endedAt && (node.runId || node.intendedRunId)),
  };
}

export function validateIntervention(value: unknown): FlowIntervention {
  const input = value as FlowIntervention | null;
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id) ||
    !['note', 'continue', 'retry'].includes(input.action) ||
    typeof input.text !== 'string' ||
    input.text.length > FLOW_LIMITS.interventionText ||
    (input.action !== 'retry' && !input.text.trim())
  )
    throw new Error('Invalid intervention.');
  return { id: input.id, action: input.action, text: input.text, createdAt: Date.now() };
}

/** Archive execution metadata, never the native transcript. */
export function resetFailedNode(flow: Flow, node: FlowNode, continueSession = false): void {
  node.attempts = [
    ...(node.attempts ?? []),
    {
      attempt: node.attempt ?? 1,
      sessionKey: node.sessionKey,
      runId: node.runId ?? node.intendedRunId,
      status: node.status,
      error: node.error,
      endedAt: node.endedAt,
      receipt: node.completion,
      submissionRuns: node.submissionRepair?.priorRuns,
    },
  ];
  node.attempt = (node.attempt ?? 1) + 1;
  if (!continueSession)
    node.sessionKey = `agent:${node.agentId}:subagent:swarm-workflow-${flow.id}-${node.id}-attempt-${node.attempt}`;
  node.continuation = continueSession;
  node.status = 'queued';
  if (node.kind === 'work' || node.kind === 'verify') node.completionMode = 'tool';
  delete node.runId;
  delete node.intendedRunId;
  delete node.dispatch;
  delete node.completion;
  delete node.submissionRepair;
  delete node.planningRepair;
  delete node.error;
  delete node.result;
  delete node.startedAt;
  delete node.endedAt;
  delete node.deadlineAt;
  delete node.budgetExceeded;
  delete node.cleanupSettled;
  delete node.artifacts;
}
