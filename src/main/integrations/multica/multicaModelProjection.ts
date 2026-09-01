import crypto from 'crypto';

export type MulticaModelDiscoveryKind = 'config' | 'registry';

interface OpenClawModelDefinition {
  id?: unknown;
  name?: unknown;
}

interface OpenClawProviderDefinition {
  models?: unknown;
}

interface ProjectedModel {
  agentId: string;
  modelName: string;
  modelRef: string;
}

const CONFIG_DISCOVERY_ARGV = ['config', 'get', 'agents.list', '--json'] as const;
const REGISTRY_DISCOVERY_ARGV = ['agents', 'list', '--json'] as const;
export const MULTICA_MODEL_CATALOG_ARGV = ['config', 'get', 'models.providers', '--json'] as const;

const matchesArgv = (argv: readonly string[], expected: readonly string[]): boolean =>
  argv.length === expected.length && argv.every((value, index) => value === expected[index]);

export function getMulticaModelDiscoveryKind(
  argv: readonly string[],
): MulticaModelDiscoveryKind | null {
  if (matchesArgv(argv, CONFIG_DISCOVERY_ARGV)) return 'config';
  if (matchesArgv(argv, REGISTRY_DISCOVERY_ARGV)) return 'registry';
  return null;
}

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const buildAgentId = (modelRef: string): string =>
  `model-${crypto.createHash('sha256').update(modelRef).digest('hex').slice(0, 20)}`;

const readProjectedModels = (stdout: string): ProjectedModel[] | null => {
  let providers: unknown;
  try {
    providers = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return null;

  const projected: ProjectedModel[] = [];
  const seen = new Set<string>();
  for (const [providerIdRaw, providerValue] of Object.entries(providers)) {
    const providerId = asNonEmptyString(providerIdRaw);
    if (!providerId || !providerValue || typeof providerValue !== 'object') continue;
    const models = (providerValue as OpenClawProviderDefinition).models;
    if (!Array.isArray(models)) continue;
    for (const modelValue of models) {
      if (!modelValue || typeof modelValue !== 'object') continue;
      const model = modelValue as OpenClawModelDefinition;
      const modelId = asNonEmptyString(model.id);
      if (!modelId) continue;
      const modelRef = `${providerId}/${modelId}`;
      if (seen.has(modelRef)) continue;
      seen.add(modelRef);
      projected.push({
        agentId: buildAgentId(modelRef),
        modelName: asNonEmptyString(model.name) ?? modelId,
        modelRef,
      });
    }
  }
  return projected;
};

export function projectMulticaModelCatalog(
  stdout: string,
  kind: MulticaModelDiscoveryKind,
): string | null {
  const models = readProjectedModels(stdout);
  if (!models) return null;

  const entries = models.map(model =>
    kind === 'config'
      ? {
          id: model.agentId,
          model: { primary: model.modelRef },
          identity: { name: model.modelName },
        }
      : {
          id: model.agentId,
          name: model.modelName,
          model: model.modelRef,
        },
  );
  return `${JSON.stringify(entries, null, 2)}\n`;
}
