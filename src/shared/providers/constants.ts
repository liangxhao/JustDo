/**
 * Provider Constants & Registry — Single Source of Truth
 *
 * All LLM provider identifiers, default configurations, and metadata are
 * defined here as a unified registry. Both main and renderer processes
 * import from this module.
 *
 * When adding a new provider:
 * 1. Add the provider key to ProviderName
 * 2. Add the OpenClaw provider ID to OpenClawProviderId (if different)
 * 3. Add one record to the PROVIDER_DEFINITIONS array
 *    — that's it, types and lookups are derived automatically.
 *
 * Follows the same pattern as PlatformRegistry in src/shared/platform/.
 * String literal constants follow AGENTS.md "String Literal Constants" spec,
 * modeled after src/scheduledTask/constants.ts.
 */

// ═══════════════════════════════════════════════════════
// 1. String Literal Constants
// ═══════════════════════════════════════════════════════

// ─── Provider Name ──────────────────────────────────────────────────────
// providerName identifies the GucciAI internal provider (config key).
// Only Ollama and Custom providers are retained.
export const ProviderName = {
  Ollama: 'ollama',
  Custom: 'custom',
} as const;
export type ProviderName = (typeof ProviderName)[keyof typeof ProviderName];

// ─── OpenClaw Provider ID ───────────────────────────────────────────────
// OpenClaw gateway provider identifiers. May differ from ProviderName.
// Only Ollama is retained as built-in provider.
export const OpenClawProviderId = {
  Ollama: 'ollama',
  GucciAI: 'gucciai',
} as const;
export type OpenClawProviderId = (typeof OpenClawProviderId)[keyof typeof OpenClawProviderId];

// ─── OpenClaw API Protocol ──────────────────────────────────────────────
export const OpenClawApi = {
  AnthropicMessages: 'anthropic-messages',
  OpenAICompletions: 'openai-completions',
  OpenAIResponses: 'openai-responses',
  GoogleGenerativeAI: 'google-generative-ai',
} as const;
export type OpenClawApi = (typeof OpenClawApi)[keyof typeof OpenClawApi];

// ─── API Format (provider default protocol format) ──────────────────────
export const ApiFormat = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Gemini: 'gemini',
} as const;
export type ApiFormat = (typeof ApiFormat)[keyof typeof ApiFormat];

// ─── Auth Type ──────────────────────────────────────────────────────────
export const AuthType = {
  ApiKey: 'api-key',
} as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

// ═══════════════════════════════════════════════════════
// 2. Provider Definition Shape
// ═══════════════════════════════════════════════════════

interface ProviderDefInput {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
  /** Default base URL */
  readonly defaultBaseUrl: string;
  /** Default API format */
  readonly defaultApiFormat: ApiFormat;
  /** Whether this provider supports codingPlan mode */
  readonly codingPlanSupported: boolean;
  /**
   * Coding Plan dedicated endpoints (only for codingPlanSupported=true providers).
   * openai: OpenAI-compatible format endpoint
   * anthropic: Anthropic-compatible format endpoint
   */
  readonly codingPlanUrls?: {
    readonly openai: string;
    readonly anthropic: string;
  };
  /**
   * When set, resolveCodingPlanBaseUrl will use this format (and its URL) regardless
   * of the caller's current apiFormat. Use for providers whose coding plan endpoint
   * only supports a single protocol (e.g. Zhipu coding plan is openai-only).
   */
  readonly preferredCodingPlanFormat?: 'openai' | 'anthropic';
  /**
   * Default baseUrl when switching apiFormat.
   * Used by Settings UI to auto-switch baseUrl when toggling anthropic/openai format.
   * If omitted, both formats use defaultBaseUrl.
   */
  readonly switchableBaseUrls?: {
    readonly anthropic: string;
    readonly openai: string;
  };
  /** Region grouping for UI visibility */
  readonly region: 'china' | 'global';
  /** Priority ordering for English locale display (lower = higher priority, 0 = no special priority) */
  readonly enPriority: number;
  /** Default model list */
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly contextLength?: number;
  }[];
  /**
   * Coding Plan dedicated model list (only meaningful when codingPlanSupported=true).
   * When the user toggles codingPlanEnabled in Settings, the model list is replaced
   * with this list. When unset, coding plan mode keeps the same models as defaultModels.
   */
  readonly codingPlanModels?: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly contextLength?: number;
  }[];
  /**
   * The OpenClaw gateway provider ID used when building model refs (e.g. "provider/modelId").
   * Most providers share the same value as `id`, but some differ
   * (e.g. zhipu → zai, gemini → google).
   * Used by renderer to construct scheduled-task model references without
   * importing main-process-only openclawConfigSync.
   */
  readonly openClawProviderId: OpenClawProviderId;
}

// ═══════════════════════════════════════════════════════
// 3. Provider Definitions — the single source of truth
//    Array order = Chinese UI display order
//    (CHINA first, then GLOBAL, matching existing config.ts order).
// ═══════════════════════════════════════════════════════

const PROVIDER_DEFINITIONS = [
  // Only Ollama is retained as the built-in provider
  // Custom providers (custom_0...custom_9) are handled dynamically
  {
    id: ProviderName.Ollama,
    openClawProviderId: OpenClawProviderId.Ollama,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'http://localhost:11434',
      openai: 'http://localhost:11434/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [],
  },
] as const satisfies readonly ProviderDefInput[];

// ═══════════════════════════════════════════════════════
// 4. Provider Definition Interface (public)
// ═══════════════════════════════════════════════════════

export interface ProviderDef {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
  /** Default base URL */
  readonly defaultBaseUrl: string;
  /** Default API format */
  readonly defaultApiFormat: ApiFormat;
  /** Whether this provider supports codingPlan mode */
  readonly codingPlanSupported: boolean;
  /** Coding Plan dedicated endpoints */
  readonly codingPlanUrls?: {
    readonly openai: string;
    readonly anthropic: string;
  };
  /** When set, overrides caller's apiFormat for coding plan URL resolution. */
  readonly preferredCodingPlanFormat?: 'openai' | 'anthropic';
  /** Default baseUrl per apiFormat for UI switching */
  readonly switchableBaseUrls?: {
    readonly anthropic: string;
    readonly openai: string;
  };
  /** Region grouping for UI visibility */
  readonly region: 'china' | 'global';
  /** Priority ordering for English locale display (lower = higher priority, 0 = no special priority) */
  readonly enPriority: number;
  /** Default model list */
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly contextLength?: number;
  }[];
  readonly codingPlanModels?: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly contextLength?: number;
  }[];
  readonly openClawProviderId: OpenClawProviderId;
}

// ═══════════════════════════════════════════════════════
// 5. Registry Implementation
// ═══════════════════════════════════════════════════════

class ProviderRegistryImpl {
  private readonly defs: readonly ProviderDef[];
  private readonly idIndex: ReadonlyMap<string, ProviderDef>;

  constructor(definitions: readonly ProviderDef[]) {
    this.defs = definitions;
    const idx = new Map<string, ProviderDef>();
    for (const def of definitions) {
      idx.set(def.id, def);
    }
    this.idIndex = idx;
  }

  /** All provider IDs in definition order. */
  get providerIds(): readonly string[] {
    return this.defs.map(d => d.id);
  }

  /** Get full definition for a provider. Returns undefined for unknown IDs. */
  get(id: string): ProviderDef | undefined {
    return this.idIndex.get(id);
  }

  /** Whether a provider supports codingPlan. */
  supportsCodingPlan(id: string): boolean {
    return this.idIndex.get(id)?.codingPlanSupported ?? false;
  }

  /** Providers filtered by region, preserving definition order. */
  byRegion(region: 'china' | 'global'): readonly ProviderDef[] {
    return this.defs.filter(d => d.region === region);
  }

  getCodingPlanUrl(id: string, format: 'openai' | 'anthropic'): string | undefined {
    const def = this.idIndex.get(id);
    if (!def?.codingPlanSupported || !def.codingPlanUrls) return undefined;
    return def.codingPlanUrls[format];
  }

  getSwitchableBaseUrl(id: string, format: 'openai' | 'anthropic'): string | undefined {
    return this.idIndex.get(id)?.switchableBaseUrls?.[format];
  }

  getOpenClawProviderId(providerName: string): string {
    return (
      this.idIndex.get(providerName)?.openClawProviderId ??
      providerName ??
      OpenClawProviderId.GucciAI
    );
  }

  /** Provider IDs filtered by region. */
  idsByRegion(region: 'china' | 'global'): readonly string[] {
    return this.defs.filter(d => d.region === region).map(d => d.id);
  }

  /**
   * Provider IDs for English locale display:
   * EN_PRIORITY providers first (sorted by enPriority), then CHINA, then remaining GLOBAL.
   * ollama and custom are always pushed to the end, with custom last.
   */
  idsForEnLocale(): readonly string[] {
    const priority = this.defs
      .filter(d => d.enPriority > 0)
      .sort((a, b) => a.enPriority - b.enPriority)
      .map(d => d.id);
    const china = this.idsByRegion('china');
    const global = this.idsByRegion('global');

    const orderedProviders = [...priority, ...china, ...global];
    const unique = [...new Set(orderedProviders)];

    // Move ollama to the end (custom providers are appended dynamically by Settings)
    const ollamaIdx = unique.indexOf(ProviderName.Ollama);
    if (ollamaIdx !== -1) {
      unique.splice(ollamaIdx, 1);
    }
    unique.push(ProviderName.Ollama);
    return unique;
  }
}

export const ProviderRegistry = new ProviderRegistryImpl(PROVIDER_DEFINITIONS);
