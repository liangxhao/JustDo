export const DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS = 60;

export const MCP_REQUEST_TIMEOUT_LIMITS = {
  min: 1,
  max: 24 * 60 * 60,
} as const;

export const isValidMcpRequestTimeoutSeconds = (value: unknown): value is number =>
  Number.isInteger(value) &&
  Number(value) >= MCP_REQUEST_TIMEOUT_LIMITS.min &&
  Number(value) <= MCP_REQUEST_TIMEOUT_LIMITS.max;

export type ExtensionProvidedMcpServer = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  providerDescription: string;
  enabled: boolean;
  supported: boolean;
};
