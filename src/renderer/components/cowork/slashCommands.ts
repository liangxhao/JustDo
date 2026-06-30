export type SlashCommandCategory = 'session' | 'model' | 'agents' | 'tools';

export type SlashCommandTier = 'essential' | 'standard' | 'power';

export interface SlashCommandDef {
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

export const SlashCommandCategoryLabels: Record<SlashCommandCategory, string> = {
  session: 'Session',
  model: 'Model',
  agents: 'Agents',
  tools: 'Tools',
};

const TIER_ORDER: Record<SlashCommandTier, number> = {
  essential: 0,
  standard: 1,
  power: 2,
};

const CATEGORY_ORDER: SlashCommandCategory[] = ['session', 'model', 'tools', 'agents'];

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    key: 'help',
    name: 'help',
    description: 'Show available commands.',
    category: 'tools',
    executeLocal: true,
    tier: 'essential',
  },
  {
    key: 'commands',
    name: 'commands',
    description: 'List all slash commands.',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'tools',
    name: 'tools',
    description: 'List available runtime tools.',
    args: '[mode]',
    category: 'tools',
    argOptions: ['compact', 'verbose'],
    tier: 'standard',
  },
  {
    key: 'skill',
    name: 'skill',
    description: 'Run a skill by name.',
    args: '<name> [input]',
    category: 'tools',
    tier: 'standard',
  },
  {
    key: 'status',
    name: 'status',
    description: 'Show current status.',
    category: 'tools',
    tier: 'essential',
  },
  {
    key: 'goal',
    name: 'goal',
    description: 'Show or control the current goal.',
    args: '[action] [text]',
    category: 'tools',
    argOptions: ['status', 'start', 'pause', 'resume', 'complete', 'block', 'clear'],
    tier: 'standard',
  },
  {
    key: 'diagnostics',
    name: 'diagnostics',
    description: 'Explain Gateway diagnostics and Codex feedback upload options.',
    args: '[note]',
    category: 'tools',
    tier: 'standard',
  },
  {
    key: 'crestodian',
    name: 'crestodian',
    description: 'Run the Crestodian setup and repair helper.',
    category: 'tools',
    tier: 'essential',
  },
  {
    key: 'tasks',
    name: 'tasks',
    description: 'List background tasks for this session.',
    category: 'tools',
    tier: 'standard',
  },
  {
    key: 'allowlist',
    name: 'allowlist',
    description: 'List/add/remove allowlist entries.',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'approve',
    name: 'approve',
    description: 'Approve or deny exec requests.',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'context',
    name: 'context',
    description: 'Explain how context is built and used.',
    category: 'tools',
    tier: 'standard',
  },
  {
    key: 'btw',
    name: 'btw',
    aliases: ['side'],
    description: 'Ask a side question without changing future session context.',
    category: 'tools',
    tier: 'standard',
  },
  {
    key: 'export-session',
    name: 'export-session',
    aliases: ['export'],
    description: 'Export current session to HTML file with full system prompt.',
    args: '[path]',
    category: 'tools',
    executeLocal: true,
    tier: 'essential',
  },
  {
    key: 'export-trajectory',
    name: 'export-trajectory',
    aliases: ['trajectory'],
    description: 'Export a JSONL trajectory bundle for the active session.',
    args: '[path]',
    category: 'tools',
    tier: 'essential',
  },
  {
    key: 'tts',
    name: 'tts',
    description: 'Control text-to-speech (TTS).',
    args: '[action] [value]',
    category: 'tools',
    argOptions: ['on', 'off', 'status', 'provider', 'limit', 'summary', 'audio', 'help'],
    tier: 'standard',
  },
  {
    key: 'whoami',
    name: 'whoami',
    aliases: ['id'],
    description: 'Show your sender id.',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'session',
    name: 'session',
    description: 'Manage session-level settings (for example /session idle).',
    args: '[action] [value]',
    category: 'session',
    argOptions: ['idle', 'max-age'],
    tier: 'power',
  },
  {
    key: 'subagents',
    name: 'subagents',
    description: 'Inspect subagent runs for this session.',
    args: '[action] [target] [value]',
    category: 'agents',
    argOptions: ['list', 'log', 'info'],
    tier: 'standard',
  },
  {
    key: 'acp',
    name: 'acp',
    description: 'Manage ACP sessions and runtime options.',
    args: '[action] [value]',
    category: 'tools',
    argOptions: [
      'spawn',
      'cancel',
      'steer',
      'close',
      'sessions',
      'status',
      'set-mode',
      'set',
      'cwd',
      'permissions',
      'timeout',
      'model',
      'reset-options',
      'doctor',
      'install',
      'help',
    ],
    tier: 'power',
  },
  {
    key: 'focus',
    name: 'focus',
    description: 'Bind this thread (Discord) or topic/conversation (Telegram) to a session target.',
    args: '[target]',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'unfocus',
    name: 'unfocus',
    description: 'Remove the current thread (Discord) or topic/conversation (Telegram) binding.',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'agents',
    name: 'agents',
    description: 'List thread-bound agents for this session.',
    category: 'agents',
    executeLocal: true,
    tier: 'standard',
  },
  {
    key: 'steer',
    name: 'steer',
    aliases: ['tell'],
    description: 'Inject a message into the active run',
    args: '<message>',
    category: 'agents',
    executeLocal: true,
    tier: 'standard',
  },
  {
    key: 'config',
    name: 'config',
    description: 'Show or set config values.',
    args: '[action] [path] [value]',
    category: 'tools',
    argOptions: ['show', 'get', 'set', 'unset'],
    tier: 'power',
  },
  {
    key: 'mcp',
    name: 'mcp',
    description: 'Show or set OpenClaw MCP servers.',
    args: '[action] [path] [value]',
    category: 'tools',
    argOptions: ['show', 'get', 'set', 'unset'],
    tier: 'power',
  },
  {
    key: 'plugins',
    name: 'plugins',
    aliases: ['plugin'],
    description: 'List, show, enable, or disable plugins.',
    args: '[action] [path]',
    category: 'tools',
    argOptions: ['list', 'show', 'get', 'enable', 'disable'],
    tier: 'power',
  },
  {
    key: 'debug',
    name: 'debug',
    description: 'Set runtime debug overrides.',
    args: '[action] [path] [value]',
    category: 'tools',
    argOptions: ['show', 'reset', 'set', 'unset'],
    tier: 'power',
  },
  {
    key: 'usage',
    name: 'usage',
    description: 'Usage footer or cost summary.',
    args: '[mode]',
    category: 'model',
    executeLocal: true,
    argOptions: ['off', 'tokens', 'full', 'cost'],
    tier: 'standard',
  },
  {
    key: 'stop',
    name: 'stop',
    description: 'Stop the current run.',
    category: 'session',
    executeLocal: true,
    tier: 'essential',
  },
  {
    key: 'restart',
    name: 'restart',
    description: 'Restart OpenClaw.',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'activation',
    name: 'activation',
    description: 'Set group activation mode.',
    args: '[mode]',
    category: 'tools',
    argOptions: ['mention', 'always'],
    tier: 'power',
  },
  {
    key: 'send',
    name: 'send',
    description: 'Set send policy.',
    args: '[mode]',
    category: 'tools',
    argOptions: ['on', 'off', 'inherit'],
    tier: 'power',
  },
  {
    key: 'reset',
    name: 'reset',
    description: 'Reset the current session.',
    category: 'session',
    executeLocal: true,
    tier: 'essential',
  },
  {
    key: 'new',
    name: 'new',
    description: 'Start a new session.',
    category: 'session',
    executeLocal: true,
    tier: 'essential',
  },
  {
    key: 'name',
    name: 'name',
    description: 'Name or rename the current session.',
    args: '[title]',
    category: 'session',
    tier: 'standard',
  },
  {
    key: 'compact',
    name: 'compact',
    description: 'Compact the session context.',
    args: '[instructions]',
    category: 'session',
    executeLocal: true,
    tier: 'essential',
  },
  {
    key: 'think',
    name: 'think',
    aliases: ['thinking', 't'],
    description: 'Set thinking level.',
    args: '[level]',
    category: 'model',
    executeLocal: true,
    argOptions: ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'],
    tier: 'essential',
  },
  {
    key: 'verbose',
    name: 'verbose',
    aliases: ['v'],
    description: 'Toggle verbose mode.',
    args: '[mode]',
    category: 'model',
    executeLocal: true,
    argOptions: ['on', 'off', 'full'],
    tier: 'standard',
  },
  {
    key: 'trace',
    name: 'trace',
    description: 'Toggle plugin trace lines.',
    args: '[mode]',
    category: 'model',
    argOptions: ['on', 'off', 'raw'],
    tier: 'power',
  },
  {
    key: 'fast',
    name: 'fast',
    description: 'Toggle fast mode.',
    args: '[mode]',
    category: 'model',
    executeLocal: true,
    argOptions: ['status', 'on', 'off', 'default'],
    tier: 'standard',
  },
  {
    key: 'reasoning',
    name: 'reasoning',
    aliases: ['reason'],
    description: 'Toggle reasoning visibility.',
    args: '[mode]',
    category: 'model',
    argOptions: ['on', 'off', 'stream'],
    tier: 'standard',
  },
  {
    key: 'elevated',
    name: 'elevated',
    aliases: ['elev'],
    description: 'Toggle elevated mode.',
    args: '[mode]',
    category: 'model',
    argOptions: ['on', 'off', 'ask', 'full'],
    tier: 'power',
  },
  {
    key: 'exec',
    name: 'exec',
    description: 'Set exec defaults for this session.',
    args: '[host] [security] [ask] [node]',
    category: 'model',
    argOptions: ['sandbox', 'gateway', 'node'],
    tier: 'power',
  },
  {
    key: 'model',
    name: 'model',
    description: 'Show or set the model.',
    args: '[model]',
    category: 'model',
    executeLocal: true,
    tier: 'essential',
  },
  {
    key: 'models',
    name: 'models',
    description: 'List model providers/models.',
    category: 'model',
    tier: 'standard',
  },
  {
    key: 'queue',
    name: 'queue',
    description: 'Adjust queue settings.',
    args: '[mode] [debounce] [cap] [drop]',
    category: 'model',
    argOptions: ['steer', 'followup', 'collect', 'interrupt'],
    tier: 'power',
  },
  {
    key: 'bash',
    name: 'bash',
    description: 'Run host shell commands (host-only).',
    args: '[command]',
    category: 'tools',
    tier: 'power',
  },
  {
    key: 'clear',
    name: 'clear',
    description: 'Clear chat history',
    category: 'session',
    executeLocal: true,
    tier: 'standard',
  },
  {
    key: 'redirect',
    name: 'redirect',
    description: 'Abort and restart with a new message',
    args: '<message>',
    category: 'agents',
    executeLocal: true,
    tier: 'power',
  },
];

function normalizeLowercaseStringOrEmpty(value: string): string {
  return value.trim().toLowerCase();
}

export function getSlashCommandCompletions(
  filter: string,
  options?: { showAll?: boolean; commands?: SlashCommandDef[] },
): SlashCommandDef[] {
  const lower = normalizeLowercaseStringOrEmpty(filter);
  const showAll = options?.showAll ?? false;
  const sourceCommands = options?.commands ?? SLASH_COMMANDS;
  let commands = lower
    ? sourceCommands.filter(
        cmd =>
          cmd.name.startsWith(lower) ||
          cmd.aliases?.some(alias => normalizeLowercaseStringOrEmpty(alias).startsWith(lower)) ||
          normalizeLowercaseStringOrEmpty(cmd.description).includes(lower),
      )
    : sourceCommands;

  if (!lower && !showAll) {
    commands = commands.filter(cmd => (cmd.tier ?? 'standard') !== 'power');
  }

  return [...commands].sort((a, b) => {
    const aTier = TIER_ORDER[a.tier ?? 'standard'] ?? 1;
    const bTier = TIER_ORDER[b.tier ?? 'standard'] ?? 1;
    if (aTier !== bTier) return aTier - bTier;

    const ai = CATEGORY_ORDER.indexOf(a.category ?? 'session');
    const bi = CATEGORY_ORDER.indexOf(b.category ?? 'session');
    if (ai !== bi) return ai - bi;

    if (lower) {
      const aExact = a.name.startsWith(lower) ? 0 : 1;
      const bExact = b.name.startsWith(lower) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
    }

    return 0;
  });
}

export function getHiddenCommandCount(commands: SlashCommandDef[] = SLASH_COMMANDS): number {
  return commands.filter(cmd => (cmd.tier ?? 'standard') === 'power').length;
}

export function getSlashCommandByName(
  name: string,
  commands: SlashCommandDef[] = SLASH_COMMANDS,
): SlashCommandDef | undefined {
  const normalizedName = normalizeLowercaseStringOrEmpty(name);
  return commands.find(
    cmd =>
      cmd.name === normalizedName ||
      cmd.aliases?.some(alias => normalizeLowercaseStringOrEmpty(alias) === normalizedName),
  );
}
