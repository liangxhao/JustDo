import type { Agent } from '../../coworkStore';

type BuildManagedAgentEntriesInput = {
  agents: Agent[];
  fallbackPrimaryModel: string;
  displayNameMap?: Record<string, string>;
};

type ProviderModelCatalog = Record<string, { models: Array<{ id: string }> }>;

export type ManagedSessionModelTarget = {
  providerId: string;
  modelId: string;
  primaryModel: string;
};

export type QualifiedAgentModelRefResolution =
  | { status: 'qualified'; primaryModel: string }
  | { status: 'ambiguous'; modelId: string; providerIds: string[] }
  | { status: 'unresolved'; modelId: string };

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

export function resolveManagedSessionModelTarget(options: {
  agentModel: string;
  fallbackPrimaryModel: string;
  availableProviders: ProviderModelCatalog;
  currentProviderId?: string;
}): ManagedSessionModelTarget {
  const fallbackTarget = parsePrimaryModelRef(options.fallbackPrimaryModel);
  const explicitModel = options.agentModel.trim();
  const currentProviderId = options.currentProviderId?.trim() || '';

  if (!explicitModel) {
    if (fallbackTarget) return fallbackTarget;
    return {
      providerId: currentProviderId,
      modelId: '',
      primaryModel: currentProviderId ? `${currentProviderId}/` : '',
    };
  }

  const explicitTarget = parsePrimaryModelRef(explicitModel);
  if (explicitTarget) {
    return explicitTarget;
  }

  const matchingProviders = Object.entries(options.availableProviders)
    .filter(([, config]) => config.models.some(model => model.id === explicitModel))
    .map(([providerId]) => providerId);

  if (fallbackTarget && matchingProviders.includes(fallbackTarget.providerId)) {
    return {
      providerId: fallbackTarget.providerId,
      modelId: explicitModel,
      primaryModel: `${fallbackTarget.providerId}/${explicitModel}`,
    };
  }

  if (matchingProviders.length === 1) {
    return {
      providerId: matchingProviders[0],
      modelId: explicitModel,
      primaryModel: `${matchingProviders[0]}/${explicitModel}`,
    };
  }

  if (currentProviderId) {
    return {
      providerId: currentProviderId,
      modelId: explicitModel,
      primaryModel: `${currentProviderId}/${explicitModel}`,
    };
  }

  if (fallbackTarget) {
    return {
      providerId: fallbackTarget.providerId,
      modelId: explicitModel,
      primaryModel: `${fallbackTarget.providerId}/${explicitModel}`,
    };
  }

  return {
    providerId: '',
    modelId: explicitModel,
    primaryModel: explicitModel,
  };
}

export function resolveQualifiedAgentModelRef(options: {
  agentModel: string;
  availableProviders: ProviderModelCatalog;
}): QualifiedAgentModelRefResolution {
  const explicitModel = options.agentModel.trim();
  if (!explicitModel) {
    return { status: 'unresolved', modelId: '' };
  }

  const explicitTarget = parsePrimaryModelRef(explicitModel);
  if (explicitTarget) {
    return {
      status: 'qualified',
      primaryModel: explicitTarget.primaryModel,
    };
  }

  const matchingProviders = Object.entries(options.availableProviders)
    .filter(([, config]) => config.models.some(model => model.id === explicitModel))
    .map(([providerId]) => providerId);

  if (matchingProviders.length === 1) {
    return {
      status: 'qualified',
      primaryModel: `${matchingProviders[0]}/${explicitModel}`,
    };
  }

  if (matchingProviders.length > 1) {
    return {
      status: 'ambiguous',
      modelId: explicitModel,
      providerIds: matchingProviders,
    };
  }

  return {
    status: 'unresolved',
    modelId: explicitModel,
  };
}

export function buildAgentEntry(
  agent: Agent,
  fallbackPrimaryModel: string,
  displayNameMap?: Record<string, string>,
): Record<string, unknown> {
  let primaryModel = parsePrimaryModelRef(agent.model.trim())?.primaryModel || fallbackPrimaryModel;

  // Normalize provider to lowercase (Gateway uses lowercase for all providers)
  const slashIndex = primaryModel.indexOf('/');
  if (slashIndex > 0) {
    const providerName = primaryModel.slice(0, slashIndex);
    const modelId = primaryModel.slice(slashIndex + 1);

    // If provider uses custom_* format, replace with displayName first
    let normalizedProvider = providerName;
    if (displayNameMap && providerName.startsWith('custom_')) {
      const displayName = displayNameMap[providerName];
      if (displayName) {
        normalizedProvider = displayName;
      }
    }

    // Always lowercase the provider (Gateway normalizes all providers to lowercase)
    primaryModel = `${normalizedProvider.toLowerCase()}/${modelId}`;
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
  displayNameMap,
}: BuildManagedAgentEntriesInput): Array<Record<string, unknown>> {
  return agents
    .filter(agent => agent.id !== 'main' && agent.enabled)
    .map(agent => buildAgentEntry(agent, fallbackPrimaryModel, displayNameMap));
}
