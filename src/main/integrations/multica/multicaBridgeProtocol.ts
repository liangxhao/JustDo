import crypto from 'crypto';
import os from 'os';
import path from 'path';

export const MULTICA_BRIDGE_PROTOCOL_VERSION = 4;
export const MULTICA_BRIDGE_METADATA_FILE = 'bridge.json';
export const MULTICA_DEV_BRIDGE_SWITCH = '--justdo-multica-bridge';
export const MULTICA_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MULTICA_BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const MULTICA_BRIDGE_MAX_CONNECTIONS = 32;

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
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

const hasLineBreak = (value: string): boolean => /[\r\n]/.test(value);

const BLOCKED_BRIDGE_ENV_NAMES = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_HOME',
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_GATEWAY_PASSWORD',
  'OPENCLAW_GATEWAY_PORT',
]);

const isAllowedBridgeEnvName = (name: string): boolean => {
  const upper = name.toUpperCase();
  return (
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) &&
    !upper.startsWith('JUSTDO_') &&
    !upper.startsWith('ELECTRON_') &&
    !upper.startsWith('OPENCLAW_BUNDLED_') &&
    !BLOCKED_BRIDGE_ENV_NAMES.has(upper)
  );
};

export function sanitizeMulticaBridgeEnvironment(
  env: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      isAllowedBridgeEnvName(name) &&
      typeof value === 'string' &&
      value.length > 0 &&
      !value.includes('\0')
    ) {
      result[name] = value;
    }
  }
  return result;
}

export function validateMulticaCommandArgv(argv: readonly string[]): string[] | null {
  if (argv.some(hasLineBreak)) return null;
  if (argv.length === 1 && argv[0] === '--version') return [...argv];
  if (
    argv[0] === 'debug' &&
    argv[1] === 'models' &&
    (argv.length === 2 || (argv.length === 3 && argv[2] === '--bundled'))
  )
    return [...argv];
  if (
    argv.length === 3 &&
    argv[0] === 'app-server' &&
    argv[1] === '--listen' &&
    argv[2] === 'stdio://'
  )
    return [...argv];
  return null;
}

export function parseMulticaBridgeArgv(processArgv: readonly string[]): string[] | null {
  const markerIndex = processArgv.indexOf(MULTICA_DEV_BRIDGE_SWITCH);
  const argv = markerIndex >= 0 ? processArgv.slice(markerIndex + 1) : [];
  if (argv.length === 0) return null;
  return validateMulticaCommandArgv(argv);
}

export function getMulticaBridgeEndpoint(userDataPath: string): string {
  const suffix = crypto
    .createHash('sha256')
    .update(path.resolve(userDataPath))
    .digest('hex')
    .slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\justdo-multica-${suffix}`
    : path.join(os.tmpdir(), `justdo-multica-${suffix}`, 'bridge.sock');
}

export function encodeMulticaBridgeMessage(
  message:
    | MulticaBridgeRequest
    | MulticaBridgeResponse
    | { type: 'stdin'; data: string }
    | { type: 'eof' },
): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMulticaBridgeLines(buffer: string): {
  messages: unknown[];
  remainder: string;
} {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  return {
    messages: lines.filter(Boolean).map(line => JSON.parse(line)),
    remainder,
  };
}
