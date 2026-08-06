export const SlashCommandIpc = {
  List: 'slashCommands:list',
} as const;

const SLASH_COMMAND_PATTERN = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

export const SlashCommandExecution = {
  Blocked: 'blocked',
  Gateway: 'gateway',
  Local: 'local',
} as const;

export type SlashCommandExecution =
  (typeof SlashCommandExecution)[keyof typeof SlashCommandExecution];

export const SlashCommandBeforeSendHook = {
  EnsureSessionEntry: 'ensure-session-entry',
} as const;

export type SlashCommandBeforeSendHook =
  (typeof SlashCommandBeforeSendHook)[keyof typeof SlashCommandBeforeSendHook];

export interface ParsedSlashCommand {
  name: string;
  argumentsText: string;
}

export interface SlashCommandBehavior {
  execution: SlashCommandExecution;
  beforeSend?: readonly SlashCommandBeforeSendHook[];
  clearComposerBeforeExecution?: boolean;
}

const DEFAULT_SLASH_COMMAND_BEHAVIOR: Readonly<SlashCommandBehavior> = {
  execution: SlashCommandExecution.Gateway,
};

const MANAGED_SLASH_COMMANDS = new Set([
  'allowlist',
  'approve',
  'config',
  'cron',
  'elev',
  'elevated',
  'exec',
  'node',
  'nodes',
]);

/**
 * Only commands whose transport differs from a normal Gateway chat message
 * belong here. New Gateway-native commands require no JustDo-side entry.
 */
const SPECIAL_SLASH_COMMAND_BEHAVIORS: Readonly<Record<string, SlashCommandBehavior>> = {
  compact: {
    execution: SlashCommandExecution.Local,
    clearComposerBeforeExecution: true,
  },
  goal: {
    execution: SlashCommandExecution.Gateway,
    beforeSend: [SlashCommandBeforeSendHook.EnsureSessionEntry],
  },
};

export const parseSlashCommand = (value: string): ParsedSlashCommand | null => {
  const match = SLASH_COMMAND_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    argumentsText: match[2]?.trim() ?? '',
  };
};

export const resolveSlashCommandBehavior = (
  value: string,
): (ParsedSlashCommand & SlashCommandBehavior) | null => {
  const command = parseSlashCommand(value);
  if (!command) return null;
  return {
    ...command,
    ...(MANAGED_SLASH_COMMANDS.has(command.name)
      ? { execution: SlashCommandExecution.Blocked }
      : (SPECIAL_SLASH_COMMAND_BEHAVIORS[command.name] ?? DEFAULT_SLASH_COMMAND_BEHAVIOR)),
  };
};

export const hasSlashCommandBeforeSendHook = (
  value: string,
  hook: SlashCommandBeforeSendHook,
): boolean => resolveSlashCommandBehavior(value)?.beforeSend?.includes(hook) ?? false;

export const shouldClearSlashCommandComposerBeforeExecution = (value: string): boolean =>
  resolveSlashCommandBehavior(value)?.clearComposerBeforeExecution ?? false;
const GOAL_CONTROL_ACTIONS = new Set([
  'block',
  'blocked',
  'clear',
  'complete',
  'done',
  'pause',
  'resume',
  'status',
]);
const GOAL_CREATE_ACTIONS = new Set(['create', 'set', 'start']);

export const isGoalSlashCommand = (value: string): boolean =>
  parseSlashCommand(value)?.name === 'goal';

/** Returns the objective only when the command starts a new goal. */
export const parseGoalStartObjective = (value: string): string | null => {
  const trimmed = value.trim();
  const command = parseSlashCommand(trimmed);
  if (command?.name !== 'goal') return null;
  const { argumentsText } = command;
  if (!argumentsText) return null;

  const [first = '', ...rest] = argumentsText.split(/\s+/);
  const action = first.toLowerCase();
  if (GOAL_CONTROL_ACTIONS.has(action)) return null;
  const objectiveText = GOAL_CREATE_ACTIONS.has(action) ? rest.join(' ') : argumentsText;
  const objective = objectiveText.trim();
  return objective || null;
};

export const SlashCommandBlacklist: ReadonlySet<string> = new Set([
  'help',
  'commands',
  'status',
  'tasks',
  'dreaming',
  'new',
  'reset',
  'stop',
  'name',
  'clear',
  'session',
  'model',
  'models',
  'think',
  'fast',
  'verbose',
  'reasoning',
  'usage',
  'trace',
  'elevated',
  'exec',
  'queue',
  'agents',
  'subagents',
  'steer',
  'redirect',
  'btw',
  'acp',
  'diagnostics',
  'export-session',
  'export-trajectory',
  'tts',
  'whoami',
  'bash',
  'config',
  'mcp',
  'plugins',
  'debug',
  'restart',
  'allowlist',
  'approve',
  'activation',
  'send',
  'focus',
  'unfocus',
  'crestodian',
]);

export const SlashCommandCategory = {
  Session: 'session',
  Model: 'model',
  Agents: 'agents',
  Tools: 'tools',
} as const;

export type SlashCommandCategory = (typeof SlashCommandCategory)[keyof typeof SlashCommandCategory];

export const SlashCommandTier = {
  Essential: 'essential',
  Standard: 'standard',
  Power: 'power',
} as const;

export type SlashCommandTier = (typeof SlashCommandTier)[keyof typeof SlashCommandTier];

export interface SlashCommand {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  category?: SlashCommandCategory;
  executeLocal?: boolean;
  argOptions?: string[];
  tier?: SlashCommandTier;
}

export interface ListSlashCommandsOptions {
  agentId?: string | null;
}

export interface ListSlashCommandsResult {
  success: boolean;
  commands?: SlashCommand[];
  error?: string;
  gatewayOffline?: boolean;
}
