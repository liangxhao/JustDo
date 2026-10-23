import crypto from 'crypto';
import os from 'os';
import path from 'path';

import {
  AGENT_CLI_BRIDGE_SWITCH,
  AGENT_CLI_PROFILE_SWITCH,
  parseAgentCliArguments,
} from '../../../../shared/integrations/agentCli';

export const AGENT_BRIDGE_PROTOCOL_VERSION = 4;
export const AGENT_BRIDGE_METADATA_FILE = 'bridge.json';
export const AGENT_BRIDGE_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const AGENT_BRIDGE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const AGENT_BRIDGE_MAX_CONNECTIONS = 32;

export interface AgentBridgeMetadata {
  version: number;
  endpoint: string;
  token: string;
  pid: number;
}

export interface AgentBridgeRequest {
  type: 'request';
  version: number;
  requestId: string;
  token: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export type AgentBridgeResponse =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

/** Only this optional Codex discovery hint crosses the process boundary. */
export function selectAgentBridgeEnvironment(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> {
  const home = env.CODEX_HOME;
  return argv[0] === 'app-server' &&
    typeof home === 'string' &&
    home.length > 0 &&
    home.length <= 32768 &&
    !home.includes('\0')
    ? { CODEX_HOME: home }
    : {};
}

export function validateAgentBridgeCommandArgv(argv: readonly string[]): string[] | null {
  return parseAgentCliArguments(argv) ? [...argv] : null;
}

export function parseAgentBridgeArgv(processArgv: readonly string[]): string[] | null {
  const markerIndex = processArgv.indexOf(AGENT_CLI_BRIDGE_SWITCH);
  // Recognize the entry before validating commands so the local client can
  // return the requested text/JSON error format for malformed arguments.
  return markerIndex < 0 ? null : processArgv.slice(markerIndex + 1);
}

/** Launcher-only profile selection. Task arguments and ordinary app startup cannot set it. */
export function resolveAgentBridgeProfile(processArgv: readonly string[]): string | undefined {
  const bridgeIndex = processArgv.indexOf(AGENT_CLI_BRIDGE_SWITCH);
  if (bridgeIndex < 0) return undefined;
  const bootstrapArgv = processArgv.slice(0, bridgeIndex);
  const profileIndex = bootstrapArgv.indexOf(AGENT_CLI_PROFILE_SWITCH);
  if (profileIndex < 0) return undefined;
  const profile = bootstrapArgv[profileIndex + 1];
  if (
    bootstrapArgv.lastIndexOf(AGENT_CLI_PROFILE_SWITCH) !== profileIndex ||
    typeof profile !== 'string' ||
    profile.trim().length === 0 ||
    profile.includes('\0') ||
    !path.isAbsolute(profile)
  ) {
    throw new Error('Invalid agent bridge profile directory.');
  }
  return path.resolve(profile);
}

export function getAgentBridgeEndpoint(userDataPath: string): string {
  const suffix = crypto
    .createHash('sha256')
    .update(path.resolve(userDataPath))
    .digest('hex')
    .slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\external-agent-${suffix}`
    : path.join(os.tmpdir(), `external-agent-${suffix}`, 'bridge.sock');
}

export function encodeAgentBridgeMessage(
  message:
    AgentBridgeRequest | AgentBridgeResponse | { type: 'stdin'; data: string } | { type: 'eof' },
): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeAgentBridgeLines(buffer: string): {
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
