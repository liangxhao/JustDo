import { DEFAULT_FLOW_AGENT, FLOW_LIMITS, type FlowAgent, type FlowNode } from './contract.js';
import { validateBatchPlan } from './batch-plan.js';
/** Invalid planner structure can be corrected before any work is admitted. */
export class PlanFormatError extends Error {}

export function planningInstructions(batchAvailable: boolean): string {
  const task = {
    id: 'task-id',
    title: 'short title',
    task: 'complete brief and acceptance criteria',
    deps: [],
    access: 'read or write',
    agentId: 'main',
    ...(batchAvailable ? { batch: null } : {}),
  };
  return (
    'Return only JSON ' +
    JSON.stringify({
      tasks: [task],
      stages: { verify: { agentId: 'main' }, deliver: { agentId: 'main' } },
      unresolvedAssignments: [],
    }) +
    '. Create 1-8 tasks with acyclic dependencies, choosing meaningful parallel work. Each task ID is a unique non-empty reference label. Prefer short labels. Dependencies must reference exact task IDs. The service converts these labels and their dependencies into internal node IDs. Do not create verification or delivery tasks; the service adds those gates. All tasks and gates default to main regardless of the originating chat agent. ONLY when the user explicitly assigns a stage to another existing agent, set its exact availableAgents ID and include agentRequest with a verbatim excerpt of assignmentRequest naming that agent. Only assignmentRequest is authoritative for agent assignments; the goal may be a rewritten task brief. Resolve names using availableAgents; never invent agents or silently replace unavailable/ambiguous assignments with main. Put unresolved assignments in unresolvedAssignments. Assign verification/delivery gates with stages, do not add duplicates. This planning pass is main orchestration; if the user assigns design/planning work to a specialist, create a separate work task for that agent. Tasks need no further conversation context. Mark any possible modification as write.' +
    (batchAvailable
      ? ' Every task MUST include a top-level batch field: null for an ordinary task, or {"source":{"kind":"jsonl","path":"project-relative/input.jsonl"}} / {"source":{"kind":"files","path":"project-relative/data","pattern":"*.json"}} for a batch task. batch is a sibling of id/title/task/deps/access/agentId, NEVER text embedded inside task. The service, not a worker, expands a batch into independent runs. A batch task describes only what ONE item must do with input.json and output/; it must not ask that worker to expand the batch, dispatch agents or aggregate other items. A normal preparation task may generate the manifest at a fixed, explicitly authorized project-relative path; the batch must depend on it and use that exact path. Do not silently change that path based on preparation output. Add a dependent ordinary task to aggregate actual batch results.'
      : ' Batch execution is unavailable in this flow; do not declare a batch or ask a worker to expand one.')
  );
}
export function resolveAssignedAgent(value: unknown, agents: FlowAgent[], goal: string): string {
  if (value === undefined) return DEFAULT_FLOW_AGENT;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PlanFormatError('Invalid agent assignment.');
  const { agentId, agentRequest } = value as Record<string, unknown>;
  if (agentId === undefined) return DEFAULT_FLOW_AGENT;
  if (typeof agentId !== 'string') throw new PlanFormatError('Invalid assigned agent identity.');
  const agent = agents.find(item => item.id === agentId);
  if (!agent) throw new Error('Requested agent is unavailable: ' + agentId);
  if (
    agentId !== DEFAULT_FLOW_AGENT &&
    (typeof agentRequest !== 'string' ||
      !agentRequest.trim() ||
      !goal.includes(agentRequest) ||
      ![agent.id, agent.name].some(name => agentRequest.toLowerCase().includes(name.toLowerCase())))
  )
    throw new Error('Non-main agents require a matching explicit user assignment: ' + agentId);
  return agentId;
}

export function validateStageAssignments(
  value: unknown,
  agents: FlowAgent[],
  goal: string,
): { verify: string; deliver: string } {
  const plan = value as Record<string, unknown>;
  if (
    plan.unresolvedAssignments !== undefined &&
    (!Array.isArray(plan.unresolvedAssignments) || plan.unresolvedAssignments.length)
  )
    throw new Error(
      'Requested agent assignments could not be resolved. Use an existing agent name or ID.',
    );
  const stages = plan.stages ?? {};
  if (!stages || typeof stages !== 'object' || Array.isArray(stages))
    throw new PlanFormatError('Invalid stage assignments.');
  if (Object.keys(stages).some(key => !['verify', 'deliver'].includes(key)))
    throw new PlanFormatError(
      'Only verification and delivery gate assignments are allowed. Put user planning/design stages in work tasks.',
    );
  return {
    verify: resolveAssignedAgent((stages as Record<string, unknown>).verify, agents, goal),
    deliver: resolveAssignedAgent((stages as Record<string, unknown>).deliver, agents, goal),
  };
}
export function parseJson(text: string): unknown {
  if (text.length > FLOW_LIMITS.result) throw new PlanFormatError('Result exceeds flow limit.');
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Native terminal replies may wrap the structured result in commentary.
    // Accept one explicit JSON block, never infer a verdict from prose or pick
    // one of several competing structured results.
    const blocks = [
      ...trimmed.matchAll(
        /(?:^|\n)[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```(?=[ \t]*(?:\r?\n|$))/gi,
      ),
    ];
    if (blocks.length !== 1)
      throw new PlanFormatError(
        'Expected one unambiguous JSON result, optionally in a JSON code block.',
      );
    try {
      return JSON.parse(blocks[0][1].trim());
    } catch {
      throw new PlanFormatError('The structured result contains invalid JSON.');
    }
  }
}
export function validatePlan(
  value: unknown,
  agents: FlowAgent[] = [{ id: DEFAULT_FLOW_AGENT, name: DEFAULT_FLOW_AGENT }],
  goal = '',
  options: { batchAvailable?: boolean } = {},
): Array<Pick<FlowNode, 'id' | 'title' | 'task' | 'deps' | 'access' | 'agentId' | 'batch'>> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tasks?: unknown }).tasks))
    throw new PlanFormatError('Planner must return tasks.');
  const tasks = (value as { tasks: unknown[] }).tasks;
  if (!tasks.length || tasks.length > FLOW_LIMITS.nodes)
    throw new PlanFormatError('Plan task limit exceeded.');
  const ids = new Set<string>();
  const result = tasks.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new PlanFormatError('Invalid task.');
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id.trim())
      throw new PlanFormatError('Invalid task reference: expected a non-empty string.');
    if (ids.has(t.id)) throw new PlanFormatError('Duplicate task ID: ' + t.id);
    ids.add(t.id);
    if (
      typeof t.title !== 'string' ||
      !t.title.trim() ||
      t.title.length > 100 ||
      typeof t.task !== 'string' ||
      !t.task.trim() ||
      t.task.length > 4000 ||
      !Array.isArray(t.deps) ||
      t.deps.some(d => typeof d !== 'string') ||
      new Set(t.deps).size !== t.deps.length ||
      !['read', 'write'].includes(String(t.access))
    )
      throw new PlanFormatError('Invalid task fields.');
    if (options.batchAvailable === true && !Object.hasOwn(t, 'batch'))
      throw new PlanFormatError(
        'Task ' +
          t.id +
          ' must declare a top-level batch field: null for an ordinary task or {"source":{"kind":"jsonl","path":"inputs.jsonl"}} for a batch. A batch declaration inside task text does not create a batch.',
      );
    if (options.batchAvailable === false && t.batch != null)
      throw new Error('Batch execution is unavailable in this flow.');
    let batch: FlowNode['batch'];
    try {
      batch = t.batch != null ? validateBatchPlan(t.batch) : undefined;
    } catch (error) {
      throw new PlanFormatError('Task ' + t.id + ': ' + String(error));
    }
    return {
      id: t.id,
      title: t.title,
      task: t.task,
      deps: t.deps as string[],
      access: t.access as 'read' | 'write',
      agentId: resolveAssignedAgent(t, agents, goal),
      ...(batch ? { batch } : {}),
    };
  });
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new PlanFormatError('Cyclic plan.');
    if (visited.has(id)) return;
    const node = result.find(n => n.id === id);
    if (!node) throw new PlanFormatError('Missing dependency.');
    visiting.add(id);
    node.deps.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  result.forEach(t => visit(t.id));
  const internalIds = new Map(result.map((node, index) => [node.id, `task-${index + 1}`]));
  return result.map(node => ({
    ...node,
    id: internalIds.get(node.id)!,
    deps: node.deps.map(id => internalIds.get(id)!),
  }));
}
export function verdict(text: string): { passed: boolean; summary: string } {
  const value = parseJson(text) as Record<string, unknown>;
  if (
    !value ||
    typeof value.passed !== 'boolean' ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length ||
    value.evidence.some(e => typeof e !== 'string' || !e.trim())
  )
    throw new Error('Verification requires a verdict and evidence.');
  return { passed: value.passed, summary: value.summary };
}
