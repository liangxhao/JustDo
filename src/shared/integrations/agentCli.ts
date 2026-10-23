import type { NormalizedAgentEvent } from '../openclaw/agentEvent';

export const AGENT_CLI_BRIDGE_SWITCH = '--external-agent-bridge';
export const AGENT_CLI_PROFILE_SWITCH = '--external-agent-profile';
export const AGENT_CLI_BRIDGE_DIRECTORY = 'external-agent';
export const AGENT_CLI_BRIDGE_METADATA_FILE = 'bridge.json';

/** Public console command; use the same name in launchers, packaging and help. */
export function getAgentCliCommandName(productName: string): string {
  return `${productName.toLowerCase()}-cli`;
}

export const AgentCliCommandKind = {
  Help: 'help',
  Version: 'version',
  Status: 'status',
  Models: 'models',
  Exec: 'exec',
  Acp: 'acp',
  AppServer: 'app-server',
  CodexModels: 'codex-models',
} as const;

export const AgentCliOutputFormat = {
  Text: 'text',
  Json: 'json',
  StreamJson: 'stream-json',
} as const;

export type AgentCliOutputFormatValue =
  (typeof AgentCliOutputFormat)[keyof typeof AgentCliOutputFormat];

export type AgentCliCommand =
  | { kind: 'help' | 'version' | 'acp' | 'app-server' | 'codex-models' }
  | { kind: 'status' | 'models'; format: 'text' | 'json' }
  | {
      kind: 'exec';
      format: AgentCliOutputFormatValue;
      prompt: string;
      cwd?: string;
      sessionId?: string;
      modelRef?: string;
    };

export const AgentCliExitCode = {
  Success: 0,
  InvalidArguments: 64,
  HostUnavailable: 69,
  BridgeError: 70,
  Cancelled: 130,
} as const;

export const AgentCliErrorCode = {
  HostUnavailable: 'HOST_UNAVAILABLE',
  InvalidArguments: 'INVALID_ARGUMENTS',
  BridgeError: 'BRIDGE_ERROR',
  ExecutionUnknown: 'EXECUTION_UNKNOWN',
} as const;

export interface AgentCliErrorFrame {
  type: 'error';
  sessionId?: string;
  runId?: string;
  error: {
    code: (typeof AgentCliErrorCode)[keyof typeof AgentCliErrorCode];
    message: string;
  };
}

export interface AgentCliResultFrame {
  type: 'result';
  sessionId: string;
  runId: string;
  status: 'completed' | 'cancelled';
  text: string;
}

export interface AgentCliEventFrame {
  type: 'event';
  sessionId: string;
  runId: string;
  event: NormalizedAgentEvent;
}

export function agentCliInvalidArgumentsMessage(language: 'en' | 'zh' = 'en'): string {
  return language === 'zh'
    ? '不支持此命令，请使用 --help 查看命令行帮助。'
    : 'Unsupported command. Use --help for the agent CLI commands.';
}

const hasValue = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');

/** Syntax only. Main resolves cwd against the launch directory and checks native ownership. */
export function parseAgentCliArguments(argv: readonly string[]): AgentCliCommand | null {
  if (argv.some(argument => typeof argument !== 'string' || argument.includes('\0'))) return null;
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) {
    return { kind: AgentCliCommandKind.Help };
  }
  if (argv.length === 1 && ['--version', '-V'].includes(argv[0])) {
    return { kind: AgentCliCommandKind.Version };
  }
  if (argv.length === 1 && argv[0] === 'acp') return { kind: AgentCliCommandKind.Acp };
  if (
    argv.length === 3 &&
    argv[0] === 'app-server' &&
    argv[1] === '--listen' &&
    argv[2] === 'stdio://'
  )
    return { kind: AgentCliCommandKind.AppServer };
  if (
    argv[0] === 'debug' &&
    argv[1] === 'models' &&
    (argv.length === 2 || (argv.length === 3 && argv[2] === '--bundled'))
  )
    return { kind: AgentCliCommandKind.CodexModels };
  const catalog = argv[0] === 'models' && argv[1] === 'list';
  if (argv[0] === 'status' || catalog) {
    const options = argv.slice(catalog ? 2 : 1);
    if (options.length > 1 || (options.length === 1 && options[0] !== '--json')) return null;
    return {
      kind: catalog ? AgentCliCommandKind.Models : AgentCliCommandKind.Status,
      format: options.length ? AgentCliOutputFormat.Json : AgentCliOutputFormat.Text,
    };
  }
  if (argv[0] !== 'exec') return null;

  const values = new Map<string, string>();
  let format: AgentCliOutputFormatValue = AgentCliOutputFormat.Text;
  let prompt: string | undefined;
  let hasFormat = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      if (prompt !== undefined || index !== argv.length - 2 || !hasValue(argv[index + 1]))
        return null;
      prompt = argv[index + 1];
      break;
    }
    if (argument === '--json' || argument === '--stream-json') {
      if (hasFormat) return null;
      hasFormat = true;
      format = argument === '--json' ? AgentCliOutputFormat.Json : AgentCliOutputFormat.StreamJson;
      continue;
    }
    if (['--cwd', '--session', '--model', '--prompt'].includes(argument)) {
      const value = argv[index + 1];
      if (values.has(argument) || !hasValue(value)) return null;
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (argument.startsWith('-') || prompt !== undefined || !hasValue(argument)) return null;
    prompt = argument;
  }
  if (values.has('--prompt')) {
    if (prompt !== undefined) return null;
    prompt = values.get('--prompt');
  }
  if (!hasValue(prompt)) return null;
  return {
    kind: AgentCliCommandKind.Exec,
    format,
    prompt,
    ...(values.has('--cwd') ? { cwd: values.get('--cwd') } : {}),
    ...(values.has('--session') ? { sessionId: values.get('--session') } : {}),
    ...(values.has('--model') ? { modelRef: values.get('--model') } : {}),
  };
}

/** Also usable when syntax is invalid; option values and literal prompts are not flags. */
export function usesAgentCliMachineOutput(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--') return false;
    if (['--cwd', '--session', '--model', '--prompt'].includes(argv[index])) {
      index += 1;
      continue;
    }
    if (argv[index] === '--json' || argv[index] === '--stream-json') return true;
  }
  return false;
}

const HELP_TEXT = {
  en: {
    title: 'agent CLI',
    usage: 'Usage',
    command: '<command>',
    help: 'Show this help without starting the application.',
    version: 'Show the installed application version.',
    status: 'Read desktop service and runtime status.',
    models: 'List configured, available chat models.',
    exec: 'Run a prompt using the desktop background service.',
    acp: 'Serve Agent Client Protocol over stdin/stdout.',
    options: 'Exec options',
    cwd: 'Working directory; defaults to the launch directory.',
    session: 'Continue an existing CLI conversation.',
    model: 'Use an available provider-qualified model ID.',
    prompt: 'Prompt text; alternatively supply one positional argument.',
    json: 'Return one JSON result, or stream JSON event lines.',
    running: 'Keep the desktop application running, including in its tray.',
    appServer: 'Serve the supported Codex app-server subset over stdin/stdout.',
    codexModels: 'List configured models in Codex discovery format.',
  },
  zh: {
    title: '智能体命令行',
    usage: '用法',
    command: '<命令>',
    help: '显示帮助，无需启动桌面应用。',
    version: '显示已安装的应用版本。',
    status: '读取桌面后台服务和运行时状态。',
    models: '列出已配置且可用的聊天模型。',
    exec: '通过桌面后台服务执行提示词。',
    acp: '通过标准输入/输出提供 Agent Client Protocol。',
    options: 'exec 选项',
    cwd: '工作目录，默认使用命令启动目录。',
    session: '继续已有的 CLI 对话。',
    model: '选择可用的供应商限定模型 ID。',
    prompt: '提示词，也可使用一个位置参数。',
    json: '返回一个 JSON 结果，或逐行输出 JSON 事件。',
    running: '请保持桌面应用运行，也可最小化到托盘。',
    appServer: '通过标准输入/输出提供已实现的 Codex app-server 协议子集。',
    codexModels: '按 Codex 模型发现格式列出已配置的模型。',
  },
} as const;

export function formatAgentCliHelp(productName: string, language: 'en' | 'zh' = 'en'): string {
  const text = HELP_TEXT[language];
  return [
    `${productName} ${text.title}`,
    `${text.usage}: ${getAgentCliCommandName(productName)} ${text.command}`,
    '',
    `  --help, -h                 ${text.help}`,
    `  --version, -V              ${text.version}`,
    `  status [--json]            ${text.status}`,
    `  models list [--json]       ${text.models}`,
    `  exec [options] <prompt>    ${text.exec}`,
    `  acp                       ${text.acp}`,
    `  app-server --listen stdio://  ${text.appServer}`,
    `  debug models [--bundled]   ${text.codexModels}`,
    '',
    `${text.options}:`,
    `  --cwd <directory>          ${text.cwd}`,
    `  --session <id>             ${text.session}`,
    `  --model <id>               ${text.model}`,
    `  --prompt <text>            ${text.prompt}`,
    `  --json | --stream-json     ${text.json}`,
    '',
    text.running,
    '',
  ].join('\n');
}
