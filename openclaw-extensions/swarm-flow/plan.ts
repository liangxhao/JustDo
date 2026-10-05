import { DEFAULT_FLOW_AGENT, FLOW_LIMITS, type FlowAgent, type FlowNode } from './contract.js';
export function resolveAssignedAgent(value: unknown, agents: FlowAgent[], goal: string): string {
  if (value === undefined) return DEFAULT_FLOW_AGENT;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid agent assignment.');
  const { agentId, agentRequest } = value as Record<string, unknown>;
  if (agentId === undefined) return DEFAULT_FLOW_AGENT;
  if (typeof agentId !== 'string') throw new Error('Invalid assigned agent identity.');
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
    throw new Error('Invalid stage assignments.');
  if (Object.keys(stages).some(key => !['verify', 'deliver'].includes(key)))
    throw new Error(
      'Only verification and delivery gate assignments are allowed. Put user planning/design stages in work tasks.',
    );
  return {
    verify: resolveAssignedAgent((stages as Record<string, unknown>).verify, agents, goal),
    deliver: resolveAssignedAgent((stages as Record<string, unknown>).deliver, agents, goal),
  };
}
export function parseJson(text: string): unknown {
  if (text.length > FLOW_LIMITS.result) throw new Error('Result exceeds flow limit.');
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
      throw new Error('Expected one unambiguous JSON result, optionally in a JSON code block.');
    try {
      return JSON.parse(blocks[0][1].trim());
    } catch {
      throw new Error('The structured result contains invalid JSON.');
    }
  }
}
export function validatePlan(
  value: unknown,
  agents: FlowAgent[] = [{ id: DEFAULT_FLOW_AGENT, name: DEFAULT_FLOW_AGENT }],
  goal = '',
): Array<Pick<FlowNode, 'id' | 'title' | 'task' | 'deps' | 'access' | 'agentId'>> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tasks?: unknown }).tasks))
    throw new Error('Planner must return tasks.');
  const tasks = (value as { tasks: unknown[] }).tasks;
  if (!tasks.length || tasks.length > FLOW_LIMITS.nodes)
    throw new Error('Plan task limit exceeded.');
  const ids = new Set<string>();
  const result = tasks.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid task.');
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id.trim())
      throw new Error('Invalid task reference: expected a non-empty string.');
    if (ids.has(t.id)) throw new Error('Duplicate task ID: ' + t.id);
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
      throw new Error('Invalid task fields.');
    return {
      id: t.id,
      title: t.title,
      task: t.task,
      deps: t.deps as string[],
      access: t.access as 'read' | 'write',
      agentId: resolveAssignedAgent(t, agents, goal),
    };
  });
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Cyclic plan.');
    if (visited.has(id)) return;
    const node = result.find(n => n.id === id);
    if (!node) throw new Error('Missing dependency.');
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
