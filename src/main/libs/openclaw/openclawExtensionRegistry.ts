import { OpenClawExtensionId } from '../../../shared/openclawExtensions';
import type { McpBridgeConfig } from './openclawConfigSync';

export type OpenClawExtensionContext = {
  mcpBridge: McpBridgeConfig | null;
};

export type OpenClawExtensionDescriptor = {
  id: string;
  buildEntry: (context: OpenClawExtensionContext) => Record<string, unknown>;
  buildToolContracts?: (context: OpenClawExtensionContext) => string[];
};

const SECRET_PLACEHOLDER = '${JUSTDO_MCP_BRIDGE_SECRET}';

export const bundledOpenClawExtensions: readonly OpenClawExtensionDescriptor[] = [
  {
    id: OpenClawExtensionId.MCP_BRIDGE,
    buildEntry: ({ mcpBridge }) => ({
      enabled: true,
      ...(mcpBridge?.tools.length
        ? {
            config: {
              callbackUrl: mcpBridge.callbackUrl,
              secret: SECRET_PLACEHOLDER,
              tools: mcpBridge.tools,
            },
          }
        : {}),
    }),
    buildToolContracts: ({ mcpBridge }) =>
      mcpBridge ? buildMcpBridgeToolContractNames(mcpBridge.tools) : [],
  },
  {
    id: OpenClawExtensionId.ASK_USER_QUESTION,
    buildEntry: ({ mcpBridge }) => ({
      enabled: true,
      ...(mcpBridge
        ? {
            config: {
              callbackUrl: mcpBridge.askUserCallbackUrl,
              secret: SECRET_PLACEHOLDER,
            },
          }
        : {}),
    }),
  },
] as const;

const sanitizeToolSegment = (value: string): string => {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'tool';
};

const buildMcpBridgeToolContractNames = (
  tools: McpBridgeConfig['tools'],
): string[] => {
  const usedNames = new Set<string>();
  return tools.map(tool => {
    const base = `mcp_${sanitizeToolSegment(tool.server)}_${sanitizeToolSegment(tool.name)}`;
    let next = base;
    let index = 2;
    while (usedNames.has(next)) {
      next = `${base}_${index}`;
      index += 1;
    }
    usedNames.add(next);
    return next;
  });
};

export const buildBundledExtensionEntries = (
  context: OpenClawExtensionContext,
  isAvailable: (id: string) => boolean,
): Record<string, Record<string, unknown>> => {
  return Object.fromEntries(
    bundledOpenClawExtensions
      .filter(extension => isAvailable(extension.id))
      .map(extension => [extension.id, extension.buildEntry(context)]),
  );
};

export const buildBundledExtensionToolContracts = (
  context: OpenClawExtensionContext,
  isAvailable: (id: string) => boolean,
): Array<{ id: string; tools: string[] }> => {
  return bundledOpenClawExtensions
    .filter(extension => isAvailable(extension.id) && extension.buildToolContracts)
    .map(extension => ({
      id: extension.id,
      tools: extension.buildToolContracts?.(context) ?? [],
    }));
};
