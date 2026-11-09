import type { McpTransportType } from '@shared/plugins/mcp';

export type {
  ExtensionProvidedMcpServer,
  McpServerConfig,
  McpServerFormData,
  McpTransportType,
} from '@shared/plugins/mcp';

// Built-in MCP registry entry (pure frontend definition)
export interface McpRegistryEntry {
  id: string; // unique identifier, e.g. 'filesystem'
  name: string; // display name
  transportType: McpTransportType;
  command: string; // default command, e.g. 'npx'
  defaultArgs: string[]; // default arguments
  requiredEnvKeys?: string[]; // env vars the user must fill
  optionalEnvKeys?: string[]; // optional env vars
  argPlaceholders?: string[]; // placeholder hints for args (e.g. path)
}

export interface McpProbeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  [key: string]: unknown;
}

export interface McpProbeResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpProbePrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  [key: string]: unknown;
}

export interface McpProbeResult {
  available: boolean;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  capabilities?: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  tools: McpProbeTool[];
  resources: McpProbeResource[];
  prompts: McpProbePrompt[];
  latencyMs: number;
  error?: string;
}

export interface McpResourceContent {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}
