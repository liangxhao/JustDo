export const SlashCommandIpc = {
  List: 'slashCommands:list',
} as const;

const GOAL_COMMAND_PATTERN = /^\/goal(?:\s|$)/i;
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
const GOAL_TOKEN_BUDGET_PATTERN = /^--tokens(?:=|\s+)\S+\s*/i;

export const isGoalSlashCommand = (value: string): boolean =>
  GOAL_COMMAND_PATTERN.test(value.trim());

/** Returns the objective only when the command starts a new goal. */
export const parseGoalStartObjective = (value: string): string | null => {
  const trimmed = value.trim();
  if (!GOAL_COMMAND_PATTERN.test(trimmed)) return null;
  const argumentsText = trimmed.replace(/^\/goal(?:\s+|$)/i, '').trim();
  if (!argumentsText) return null;

  const [first = '', ...rest] = argumentsText.split(/\s+/);
  const action = first.toLowerCase();
  if (GOAL_CONTROL_ACTIONS.has(action)) return null;
  const objectiveText = GOAL_CREATE_ACTIONS.has(action) ? rest.join(' ') : argumentsText;
  const objective = objectiveText.replace(GOAL_TOKEN_BUDGET_PATTERN, '').trim();
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
