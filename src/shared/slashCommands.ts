export const SlashCommandIpc = {
  List: 'slashCommands:list',
} as const;

export const SlashCommandCategory = {
  Session: 'session',
  Model: 'model',
  Agents: 'agents',
  Tools: 'tools',
} as const;

export type SlashCommandCategory =
  (typeof SlashCommandCategory)[keyof typeof SlashCommandCategory];

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
