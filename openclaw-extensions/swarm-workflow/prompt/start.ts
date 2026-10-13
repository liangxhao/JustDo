export const START_TOOL = 'swarm_workflow_start';
export const START_LIMITS = { corrections: 3, pending: 128, lifetimeMs: 30 * 60 * 1000 } as const;

/** This turn prepares a brief; the service owns planning, execution and progress. */
export function startInstructions(mode: string, requestId: string): string {
  const args = {
    goal: 'A self-contained task brief preserving the user request',
    mode,
    sourceRequestId: requestId,
  };
  return (
    'The user explicitly selected Swarm Workflow. This is ONLY a workflow launch turn. ' +
    'Do not perform the task, make a plan, or classify whether it merits Swarm Workflow. ' +
    'The Swarm Workflow service owns task planning, execution and progress tracking. General task instructions to plan, execute or maintain progress with other tools do not apply to this launch turn. ' +
    `The only permitted task action in this turn is ${START_TOOL}; use discovery and transport tools only to invoke it. ` +
    'Use this conversation and the current attachments to resolve references such as "the above plan" into a self-contained goal. Preserve the user constraints and exact agent-assignment wording. ' +
    'Include accessible project file paths for attachments; describe relevant visible image details. The independent workers cannot see this conversation or its images. ' +
    'If essential content is inaccessible, state what is missing and do not invent it or claim a workflow started. ' +
    `Otherwise call ${START_TOOL} now with the named arguments ${JSON.stringify(args)}. Replace goal with the complete brief and keep mode and sourceRequestId unchanged. Include optional concurrency only for an explicit user-requested lower ceiling. ` +
    `If using Code Mode tool_call, use exactly one wrapper: ${JSON.stringify({ id: START_TOOL, args })}. ` +
    'Do not nest another args, payload or result object. If the call is rejected, read the error, correct the arguments and try the launch tool again; do not substitute another tool. ' +
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
