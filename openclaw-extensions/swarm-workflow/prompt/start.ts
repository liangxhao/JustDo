export const START_TOOL = 'swarm_workflow_start';
export const START_LIMITS = { corrections: 3, pending: 128, lifetimeMs: 30 * 60 * 1000 } as const;

/** The source may prepare the brief; the service owns the execution DAG and delivery. */
export function startInstructions(mode: string, requestId: string): string {
  const args = {
    goal: 'A self-contained task brief preserving the user request',
    mode,
    sourceRequestId: requestId,
  };
  return (
    'The user explicitly selected Swarm Workflow for this request. Honor this execution choice. ' +
    `If the objective and essential context are sufficiently clear, promptly call ${START_TOOL} with a self-contained goal; do not add unnecessary preliminary analysis or planning. Only when material uncertainty or missing context prevents a reliable brief, use normally available tools as needed to inspect the project, read attachments, research, analyze requirements or prepare a preliminary plan. Resolve only the necessary gaps, then promptly call ${START_TOOL}; do not stop after analysis or a plan. Existing permissions, approvals and tool restrictions remain in force; this selection grants no additional access. ` +
    'Assistant discovery and existing Team discussion reads may inform preparation. Do not prepare Team peers, start a competing Team discussion or dispatch work to product conversations instead of the selected workflow. ' +
    'Keep preparation proportionate to the request. Do not complete the delegated task yourself or substitute another execution mode. The Swarm Workflow service owns the execution DAG, worker scheduling, verification, progress tracking and delivery. Preliminary analysis and planning should inform the goal, not replace the service planner. ' +
    'Use this conversation and the current attachments to resolve references such as "the above plan" into a self-contained goal. Preserve the user constraints and exact agent-assignment wording. ' +
    'Include accessible project file paths for attachments; describe relevant visible image details. The independent workers cannot see this conversation or its images. ' +
    'If essential content is inaccessible, state what is missing and do not invent it or claim a workflow started. ' +
    `Once the objective and essential context are clear, call ${START_TOOL} with the named arguments ${JSON.stringify(args)}. Replace goal with the complete brief, including any relevant preparation findings, and keep mode and sourceRequestId unchanged. Include optional concurrency only for an explicit user-requested lower ceiling. ` +
    `If using Code Mode tool_call, use exactly one wrapper: ${JSON.stringify({ id: START_TOOL, args })}. ` +
    'Do not nest another args, payload or result object. Correct a confirmed argument rejection without repeating preparation or side effects. Never blindly retry an unknown launch result or substitute another execution mode. Preparation tool results do not establish workflow acceptance. ' +
    'Only after the tool confirms acceptance, briefly acknowledge and end this turn. Progress appears in the Swarm Workflow tab and the final result will arrive here.'
  );
}

/** Inspect the current hook projection, without retaining native chat content. */
export function lastStartError(messages: unknown[] | undefined, runId: string): string | undefined {
  if (!Array.isArray(messages)) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    if (!value || typeof value !== 'object') continue;
    const message = value as Record<string, unknown>;
    if (message.role === 'user') return;
    const nested =
      message.role === 'custom' &&
      message.customType === 'openclaw.nested-tool.v1' &&
      message.details &&
      typeof message.details === 'object'
        ? (message.details as Record<string, unknown>)
        : undefined;
    if (
      nested
        ? nested.runId !== runId || nested.isError !== true
        : message.role !== 'toolResult' ||
          message.isError !== true ||
          (message.runId !== undefined && message.runId !== runId)
    )
      continue;
    const result =
      nested?.result && typeof nested.result === 'object'
        ? (nested.result as Record<string, unknown>)
        : message;
    const content =
      typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content
              .flatMap(part => {
                if (!part || typeof part !== 'object') return [];
                const text = (part as Record<string, unknown>).text;
                return typeof text === 'string' ? [text] : [];
              })
              .join('\n')
          : '';
    if (content) return content.slice(0, 2000);
  }
}
