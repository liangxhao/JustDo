import type { Agent } from '../../data/coworkStore';

type BuildManagedAgentEntriesInput = {
  agents: Agent[];
  fallbackPrimaryModel: string;
};


export type ManagedSessionModelTarget = {
  providerId: string;
  modelId: string;
  primaryModel: string;
};

export function parsePrimaryModelRef(primaryModel: string): ManagedSessionModelTarget | null {
  const normalized = primaryModel.trim();
  const slashIndex = normalized.indexOf('/');
  if (!normalized || slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null;
  }

  const providerId = normalized.slice(0, slashIndex).trim();
  const modelId = normalized.slice(slashIndex + 1).trim();
  if (!providerId || !modelId) {
    return null;
  }

  return {
    providerId,
    modelId,
    primaryModel: `${providerId}/${modelId}`,
  };
}

export function buildAgentEntry(
  agent: Agent,
  fallbackPrimaryModel: string,
): Record<string, unknown> {
  let primaryModel =
    (agent.id === 'main' ? undefined : parsePrimaryModelRef(agent.model.trim())?.primaryModel) ||
    fallbackPrimaryModel;

  // Normalize provider to lowercase (Gateway uses lowercase for all providers)
  const slashIndex = primaryModel.indexOf('/');
  if (slashIndex > 0) {
    const providerName = primaryModel.slice(0, slashIndex);
    const modelId = primaryModel.slice(slashIndex + 1);

    primaryModel = `${providerName.toLowerCase()}/${modelId}`;
  }

  return {
    id: agent.id,
    ...(agent.isDefault ? { default: true } : {}),
    ...(agent.name || agent.icon
      ? {
          identity: {
            ...(agent.name ? { name: agent.name } : {}),
            ...(agent.icon ? { emoji: agent.icon } : {}),
          },
        }
      : {}),
    ...(agent.skillIds && agent.skillIds.length > 0 ? { skills: agent.skillIds } : {}),
    model: {
      primary: primaryModel,
    },
    // Enable reasoning stream so thinking events are emitted via WebSocket
    reasoningDefault: 'stream',
  };
}

export function buildManagedAgentEntries({
  agents,
  fallbackPrimaryModel,
}: BuildManagedAgentEntriesInput): Array<Record<string, unknown>> {
  return agents
    .filter(agent => agent.id !== 'main')
    .map(agent => buildAgentEntry(agent, fallbackPrimaryModel));
}
