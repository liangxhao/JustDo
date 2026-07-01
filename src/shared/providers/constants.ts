export const ProviderName = {
  Ollama: 'ollama',
  Custom: 'custom',
} as const;
export type ProviderName = (typeof ProviderName)[keyof typeof ProviderName];

export const OpenClawProviderId = {
  Ollama: 'ollama',
  JustDo: 'justdo',
} as const;
export type OpenClawProviderId = (typeof OpenClawProviderId)[keyof typeof OpenClawProviderId];

export const OpenClawApi = {
  OpenAICompletions: 'openai-completions',
} as const;
export type OpenClawApi = (typeof OpenClawApi)[keyof typeof OpenClawApi];

export const ApiFormat = {
  OpenAI: 'openai',
} as const;
export type ApiFormat = (typeof ApiFormat)[keyof typeof ApiFormat];

export const AuthType = {
  ApiKey: 'api-key',
} as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

type ProviderModel = {
  readonly id: string;
  readonly name: string;
  readonly supportsImage: boolean;
  readonly contextLength?: number;
  readonly maxTokens?: number;
};

export interface ProviderDef {
  readonly id: string;
  readonly defaultBaseUrl: string;
  readonly defaultApiFormat: ApiFormat;
  readonly defaultModels: readonly ProviderModel[];
  readonly openClawProviderId: OpenClawProviderId;
}

const PROVIDER_DEFINITIONS = [
  {
    id: ProviderName.Ollama,
    openClawProviderId: OpenClawProviderId.Ollama,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    defaultModels: [],
  },
] as const satisfies readonly ProviderDef[];

class ProviderRegistryImpl {
  private readonly defs: readonly ProviderDef[];
  private readonly idIndex: ReadonlyMap<string, ProviderDef>;

  constructor(definitions: readonly ProviderDef[]) {
    this.defs = definitions;
    this.idIndex = new Map(definitions.map(def => [def.id, def]));
  }

  get providerIds(): readonly string[] {
    return this.defs.map(def => def.id);
  }

  get(id: string): ProviderDef | undefined {
    return this.idIndex.get(id);
  }

  getOpenClawProviderId(providerName: string): string {
    return this.idIndex.get(providerName)?.openClawProviderId ?? providerName ?? OpenClawProviderId.JustDo;
  }
}

export const ProviderRegistry = new ProviderRegistryImpl(PROVIDER_DEFINITIONS);
