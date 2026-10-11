/** Restrictions on the source incarnation cannot be dropped by starting independent peers. */
export function hasUnsupportedDiscussionSourcePolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const nonempty = (items: unknown) => Array.isArray(items) && items.length > 0;
  const denied = (items: unknown) =>
    Boolean(
      items && typeof items === 'object' && Object.values(items).some(item => item === false),
    );
  const overrides = entry.toolOverrides as Record<string, unknown> | undefined;
  return (
    entry.sandbox === 'required' ||
    entry.execHost === 'sandbox' ||
    entry.execHost === 'node' ||
    nonempty(entry.inheritedToolDeny) ||
    (nonempty(entry.inheritedToolAllow) &&
      !(entry.inheritedToolAllow as unknown[]).includes('*')) ||
    Boolean(
      overrides &&
      (overrides.webSearch === false ||
        denied(overrides.mcpServers) ||
        denied(overrides.skills) ||
        (overrides.mcpToolsDeny &&
          typeof overrides.mcpToolsDeny === 'object' &&
          Object.values(overrides.mcpToolsDeny).some(nonempty))),
    )
  );
}

/** Only the embedded OpenClaw runtime has a verified per-turn tool boundary. */
export function assertDiscussionRuntime(config: unknown, agentId: string, value?: unknown): void {
  const cfg = config as {
    agents?: {
      defaults?: { models?: Record<string, { agentRuntime?: { id?: string } }> };
      entries?: Record<
        string,
        { runtime?: { type?: string }; models?: Record<string, { agentRuntime?: { id?: string } }> }
      >;
    };
  };
  const agent = cfg.agents?.entries?.[agentId];
  const entry = (value ?? {}) as {
    acp?: unknown;
    agentRuntimeOverride?: string;
    agentHarnessId?: string;
  };
  const alternative = (id?: string) => !!id && !['openclaw', 'auto', 'default'].includes(id);
  if (
    agent?.runtime?.type === 'acp' ||
    entry.acp ||
    alternative(entry.agentRuntimeOverride) ||
    alternative(entry.agentHarnessId) ||
    Object.values({ ...cfg.agents?.defaults?.models, ...agent?.models }).some(model =>
      alternative(model.agentRuntime?.id),
    )
  )
    throw new Error('teamDiscussionSourcePolicyUnsupported');
}
