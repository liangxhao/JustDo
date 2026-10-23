export const EXTERNAL_MCP_OPEN_METHOD = 'runtimeServices.externalMcp.open';
export const EXTERNAL_MCP_CLOSE_METHOD = 'runtimeServices.externalMcp.close';
export const EXTERNAL_MCP_TOOL_NAME = 'external_mcp';

/** These hosts can retire attached stdio process trees through the public runtime SDK. */
export function isExternalMcpPlatformSupported(platform: string): boolean {
  return platform === 'win32' || platform === 'linux';
}

export interface ExternalMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** Ephemeral, connection-owned configuration; never project this into native config. */
export interface ExternalMcpOpenRequest {
  leaseId: string;
  sessionKey: string;
  sessionId: string;
  cwd: string;
  servers: ExternalMcpServer[];
}

export interface ExternalMcpCloseRequest {
  leaseId: string;
  sessionKey: string;
  sessionId: string;
}

export interface ExternalMcpOpenResult {
  ok: true;
  leaseId: string;
  serverCount: number;
  toolCount: number;
}

export interface ExternalMcpCloseResult {
  ok: true;
}
