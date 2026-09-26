export const ExternalAgentCommandToken = {
  NodeExecutable: '${NODE_EXECUTABLE}',
  AcpxPluginRoot: '${ACPX_PLUGIN_ROOT}',
  OpenClawRoot: '${OPENCLAW_ROOT}',
} as const;

export interface ExternalAgentAdapterDefinition {
  /** Executable or one of ExternalAgentCommandToken. */
  command: string;
  /** Arguments may also contain ExternalAgentCommandToken values. */
  args?: readonly string[];
}

export interface ExternalAgentDefinition {
  /** Stable lowercase identifier written to OpenClaw's ACP allowlist. */
  id: string;
  /** Product name shown in settings. */
  name: string;
  /** Translation key for the short user-facing description. */
  descriptionKey: string;
  /** New and newly added agents should normally remain opt-in. */
  defaultEnabled: boolean;
  /**
   * Omit when ACPX already supplies a safe bundled command for this id.
   * Set this when the product must provide an explicit structured command,
   * whether it targets a separately installed CLI or a bundled adapter.
   * Runtime downloads and user-entered command overrides are unsupported.
   */
  adapter?: ExternalAgentAdapterDefinition;
}

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * Validates the build-time catalog and preserves literal ids for consumers.
 *
 * To ship another ACP agent, add one entry below. For an adapter implemented
 * as a bundled Node module, use NodeExecutable as the command and an
 * AcpxPluginRoot-relative entry file as the first argument. Then add the
 * package to openclaw-extensions/acpx/package.json and its display strings to
 * both translation tables. See docs/external-agent-integration-guide.md.
 */
export const defineExternalAgentCatalog = <const T extends readonly ExternalAgentDefinition[]>(
  definitions: T,
): T => {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (!AGENT_ID_PATTERN.test(definition.id)) {
      throw new Error(`Invalid external agent id: ${definition.id}`);
    }
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate external agent id: ${definition.id}`);
    }
    if (
      !definition.name.trim() ||
      definition.name.includes('\0') ||
      !definition.descriptionKey.trim()
    ) {
      throw new Error(`External agent ${definition.id} requires display metadata.`);
    }
    if (definition.adapter) {
      if (!definition.adapter.command.trim() || definition.adapter.command.includes('\0')) {
        throw new Error(`External agent ${definition.id} requires an adapter command.`);
      }
      if (
        definition.adapter.args?.some(argument => !argument.trim() || argument.includes('\0'))
      ) {
        throw new Error(`External agent ${definition.id} has an invalid adapter argument.`);
      }
    }
    ids.add(definition.id);
  }
  return definitions;
};

export const EXTERNAL_AGENT_CATALOG = defineExternalAgentCatalog([
  {
    id: 'claude',
    name: 'Claude',
    descriptionKey: 'externalAgentsClaudeDescription',
    defaultEnabled: false,
  },
  {
    id: 'codex',
    name: 'Codex',
    descriptionKey: 'externalAgentsCodexDescription',
    defaultEnabled: false,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    descriptionKey: 'externalAgentsOpenCodeDescription',
    defaultEnabled: false,
    adapter: {
      command: 'opencode',
      args: ['acp'],
    },
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    descriptionKey: 'externalAgentsDeepSeekHarnessDescription',
    defaultEnabled: false,
    adapter: {
      command: 'dsh',
      args: ['--profile', 'acp'],
    },
  },
  {
    id: 'hermes',
    name: 'Hermes',
    descriptionKey: 'externalAgentsHermesDescription',
    defaultEnabled: false,
    adapter: {
      command: 'hermes',
      args: ['acp'],
    },
  },
] as const);

export type ExternalAgentId = (typeof EXTERNAL_AGENT_CATALOG)[number]['id'];

export const EXTERNAL_AGENT_IDS = EXTERNAL_AGENT_CATALOG.map(definition => definition.id);

export const getExternalAgentDefinition = (id: string): ExternalAgentDefinition | undefined =>
  EXTERNAL_AGENT_CATALOG.find(definition => definition.id === id);
