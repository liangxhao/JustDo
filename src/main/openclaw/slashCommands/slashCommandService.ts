import {
  type ListSlashCommandsOptions,
  type SlashCommand,
  SlashCommandCategory,
  type SlashCommandCategory as SlashCommandCategoryValue,
  SlashCommandTier,
  type SlashCommandTier as SlashCommandTierValue,
} from '../../../shared/slashCommands';
import type { GatewayClientLike } from '../../engine/gateway/types';

type GatewayCommandArg = {
  name?: unknown;
  required?: unknown;
  choices?: unknown;
};

export type GatewayCommandEntry = {
  key?: unknown;
  name?: unknown;
  textAliases?: unknown;
  description?: unknown;
  args?: unknown;
  category?: unknown;
  tier?: unknown;
};

export interface SlashCommandPolicyContext {
  options: Readonly<ListSlashCommandsOptions>;
  source: Readonly<GatewayCommandEntry>;
}

export interface SlashCommandPolicy {
  include?: (command: Readonly<SlashCommand>, context: SlashCommandPolicyContext) => boolean;
  transform?: (command: Readonly<SlashCommand>, context: SlashCommandPolicyContext) => SlashCommand;
}

export interface SlashCommandServiceOptions {
  getGatewayClient: () => GatewayClientLike | null;
  policies?: readonly SlashCommandPolicy[];
}

const CATEGORY_OVERRIDES: Readonly<Record<string, SlashCommandCategoryValue>> = {
  help: SlashCommandCategory.Tools,
  commands: SlashCommandCategory.Tools,
  tools: SlashCommandCategory.Tools,
  skill: SlashCommandCategory.Tools,
  status: SlashCommandCategory.Tools,
  export_session: SlashCommandCategory.Tools,
  usage: SlashCommandCategory.Tools,
  tts: SlashCommandCategory.Tools,
  agents: SlashCommandCategory.Agents,
  subagents: SlashCommandCategory.Agents,
  steer: SlashCommandCategory.Agents,
  redirect: SlashCommandCategory.Agents,
  goal: SlashCommandCategory.Session,
  session: SlashCommandCategory.Session,
  stop: SlashCommandCategory.Session,
  reset: SlashCommandCategory.Session,
  new: SlashCommandCategory.Session,
  compact: SlashCommandCategory.Session,
  model: SlashCommandCategory.Model,
  models: SlashCommandCategory.Model,
  think: SlashCommandCategory.Model,
  verbose: SlashCommandCategory.Model,
  fast: SlashCommandCategory.Model,
  reasoning: SlashCommandCategory.Model,
  elevated: SlashCommandCategory.Model,
  queue: SlashCommandCategory.Model,
};

const LOCAL_COMMANDS = new Set([
  'help',
  'new',
  'reset',
  'stop',
  'compact',
  'model',
  'think',
  'fast',
  'verbose',
  'export-session',
  'usage',
  'agents',
  'steer',
  'redirect',
]);

const normalizeAlias = (alias: string): string => alias.trim().replace(/^\//u, '').toLowerCase();

const normalizeKey = (value: string): string => value.replace(/[:.-]/g, '_');

const formatArgs = (args: GatewayCommandArg[]): string | undefined => {
  const formatted = args
    .map(arg => {
      const name = typeof arg.name === 'string' ? arg.name.trim() : '';
      if (!name) return null;
      return arg.required === true ? `<${name}>` : `[${name}]`;
    })
    .filter((part): part is string => part !== null)
    .join(' ');
  return formatted || undefined;
};

const choiceToValue = (choice: unknown): string | null => {
  if (typeof choice === 'string') return choice;
  if (!choice || typeof choice !== 'object' || !('value' in choice)) return null;
  const value = (choice as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
};

const getArgOptions = (args: GatewayCommandArg[]): string[] | undefined => {
  const choices = args[0]?.choices;
  if (!Array.isArray(choices)) return undefined;
  const options = choices.map(choiceToValue).filter((value): value is string => !!value);
  return options.length > 0 ? options : undefined;
};

const mapCategory = (entry: GatewayCommandEntry): SlashCommandCategoryValue => {
  const key = typeof entry.key === 'string' ? normalizeKey(entry.key) : '';
  const override = CATEGORY_OVERRIDES[key];
  if (override) return override;

  switch (entry.category) {
    case 'session':
      return SlashCommandCategory.Session;
    case 'options':
      return SlashCommandCategory.Model;
    default:
      return SlashCommandCategory.Tools;
  }
};

const mapTier = (entry: GatewayCommandEntry): SlashCommandTierValue => {
  switch (entry.tier) {
    case SlashCommandTier.Essential:
    case SlashCommandTier.Standard:
    case SlashCommandTier.Power:
      return entry.tier;
    default:
      return SlashCommandTier.Standard;
  }
};

export const mapGatewaySlashCommand = (entry: GatewayCommandEntry): SlashCommand | null => {
  const aliases = Array.isArray(entry.textAliases)
    ? entry.textAliases.filter((alias): alias is string => typeof alias === 'string')
    : [];
  const name =
    aliases.map(normalizeAlias).find(Boolean) ??
    (typeof entry.name === 'string' ? normalizeAlias(entry.name) : '');
  if (!name) return null;

  const args = Array.isArray(entry.args) ? (entry.args as GatewayCommandArg[]) : [];
  const key = typeof entry.key === 'string' && entry.key.trim() ? entry.key.trim() : name;
  const normalizedAliases = aliases.map(normalizeAlias).filter(alias => alias && alias !== name);

  return {
    key,
    name,
    ...(normalizedAliases.length > 0 ? { aliases: normalizedAliases } : {}),
    description: typeof entry.description === 'string' ? entry.description : '',
    args: formatArgs(args),
    category: mapCategory(entry),
    executeLocal: LOCAL_COMMANDS.has(key),
    argOptions: getArgOptions(args),
    tier: mapTier(entry),
  };
};

export class SlashCommandService {
  private readonly getGatewayClient: () => GatewayClientLike | null;
  private readonly policies: readonly SlashCommandPolicy[];

  constructor(options: SlashCommandServiceOptions) {
    this.getGatewayClient = options.getGatewayClient;
    this.policies = options.policies ?? [];
  }

  async list(options: ListSlashCommandsOptions = {}): Promise<SlashCommand[]> {
    const gatewayClient = this.getGatewayClient();
    if (!gatewayClient) {
      throw new Error('Gateway client not connected');
    }

    const result = await gatewayClient.request<{ commands?: GatewayCommandEntry[] }>(
      'commands.list',
      {
        ...(options.agentId ? { agentId: options.agentId } : {}),
        includeArgs: true,
        scope: 'text',
      },
    );
    const entries = Array.isArray(result.commands) ? result.commands : [];

    return entries.flatMap(source => {
      let command = mapGatewaySlashCommand(source);
      if (!command) return [];

      const context = { options, source };
      for (const policy of this.policies) {
        if (policy.include && !policy.include(command, context)) return [];
        if (policy.transform) command = policy.transform(command, context);
      }
      return [command];
    });
  }
}
