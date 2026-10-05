// Background workers have their own native ownership. Only policies expressible
// through the public session-create API are supported; never drop stronger caps.
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The service run API cannot carry native spawn's effective inherited tool or
 * sandbox envelope. Cross-agent execution is only supported without agent-scoped
 * policies; do not infer equivalence from matching serialized configuration.
 * Read the live runtime config again at native admission, not just at planning.
 */
export function assertCrossAgentPolicy(
  config: unknown,
  parentAgentId: string,
  targetAgentId: string,
): void {
  if (parentAgentId === targetAgentId) return;
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Current agent execution policy is unavailable.');
  const current = record(config);
  const entries = record(record(current.agents).entries);
  for (const agentId of [parentAgentId, targetAgentId]) {
    const agent = record(entries[agentId]);
    for (const key of ['tools', 'sandbox']) {
      if (agent[key] != null)
        throw new Error(
          'Cross-agent Swarm execution cannot safely inherit configured ' +
            key +
            ' policy for ' +
            agentId +
            '. Use the same agent or native delegation.',
        );
    }
  }
  // Selecting another agent may select another provider and hence another tool
  // policy. The service API cannot preserve the original provider's upper bound.
  if (record(current.tools).byProvider != null)
    throw new Error('Cross-agent Swarm execution cannot inherit provider-scoped tool policy.');
}

export function parentPolicy(parent: Record<string, unknown>): string {
  for (const key of [
    'sandbox',
    'execNode',
    'execHost',
    'cronRunContinuation',
    'inheritedToolPolicyVersion',
    'inheritedToolAllow',
    'inheritedToolDeny',
    'restartRecoveryForceSafeTools',
  ]) {
    if (parent[key] != null && parent[key] !== false)
      throw new Error('This parent execution policy is not supported by Swarm Flow: ' + key);
  }
  if (parent.agentRuntimeOverride && parent.agentRuntimeOverride !== 'openclaw')
    throw new Error('Swarm Flow requires the native OpenClaw runtime.');
  if (Boolean(parent.modelOverride) !== Boolean(parent.providerOverride))
    throw new Error('Parent model selection is incomplete.');
  return JSON.stringify({
    toolOverrides: parent.toolOverrides ?? {},
    model: parent.modelOverride ? `${parent.providerOverride}/${parent.modelOverride}` : undefined,
  });
}
