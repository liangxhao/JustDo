import crypto from 'crypto';
import path from 'path';

export const MULTICA_BRIDGE_PROTOCOL_VERSION = 1;
export const MULTICA_BRIDGE_METADATA_FILE = 'bridge.json';
export const MULTICA_DEV_BRIDGE_SWITCH = '--justdo-multica-bridge';

export interface MulticaBridgeMetadata {
  version: number;
  endpoint: string;
  token: string;
  pid: number;
}

export interface MulticaBridgeRequest {
  type: 'request';
  version: number;
  requestId: string;
  token: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export type MulticaBridgeResponse =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'error'; message: string };

const hasLineBreak = (value: string): boolean => /[\r\n]/.test(value);

export function parseMulticaBridgeArgv(
  processArgv: readonly string[],
  isPackaged: boolean,
): string[] | null {
  const devSwitchIndex = processArgv.indexOf(MULTICA_DEV_BRIDGE_SWITCH);
  const argv =
    devSwitchIndex >= 0
      ? processArgv.slice(devSwitchIndex + 1)
      : isPackaged
        ? processArgv.slice(1)
        : [];
  if (argv.length === 0) return null;

  if (argv.length === 1 && argv[0] === '--version') return argv;
  if (argv.some(hasLineBreak)) {
    // Multica sends the complete task prompt as a single, legitimately multiline
    // --message value. Keep every command/control argument single-line while
    // preserving the task body byte-for-byte.
    const messageIndex = argv[0] === 'agent' ? argv.indexOf('--message') : -1;
    const onlyMessageContainsLineBreak = argv.every(
      (value, index) => !hasLineBreak(value) || index === messageIndex + 1,
    );
    if (messageIndex < 0 || messageIndex === argv.length - 1 || !onlyMessageContainsLineBreak) {
      return null;
    }
  }

  if (argv[0] === 'config' && argv[1] === 'file' && argv.length === 2) return argv;
  if (argv[0] === 'config' && argv[1] === 'get' && argv.length >= 3 && argv.includes('--json')) {
    return argv;
  }
  if (argv[0] === 'agents' && argv[1] === 'list' && argv.includes('--json')) return argv;
  if (
    argv[0] === 'agent' &&
    argv.includes('--local') &&
    argv.includes('--json') &&
    argv.includes('--message') &&
    (argv.includes('--session-id') || argv.includes('--session-key'))
  ) {
    return argv;
  }
  return null;
}

export function sanitizeMulticaBridgeEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    'OPENCLAW_CONFIG_PATH',
    'OPENCLAW_INCLUDE_ROOTS',
    'LITELLM_API_KEY',
  ] as const) {
    const value = env[name]?.trim();
    if (value && !hasLineBreak(value)) result[name] = value;
  }
  return result;
}

export function getMulticaBridgeEndpoint(userDataPath: string): string {
  const suffix = crypto
    .createHash('sha256')
    .update(path.resolve(userDataPath))
    .digest('hex')
    .slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\justdo-multica-${suffix}`
    : path.join(userDataPath, 'multica', 'bridge.sock');
}

export function encodeBridgeMessage(message: MulticaBridgeRequest | MulticaBridgeResponse): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeBridgeLines(buffer: string): { messages: unknown[]; remainder: string } {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    messages.push(JSON.parse(line));
  }
  return { messages, remainder };
}
