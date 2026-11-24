import type { McpAppAdapter } from '@app-plugin/sdk/mcp-app';
import type { McpAppDescriptor } from '@shared/plugins/mcpApps';

const adapters = new Set<McpAppAdapter>();

/** Only desktop build composition and explicit host test fixtures register adapters. */
export function registerMcpAppAdapter(adapter: McpAppAdapter): () => void {
  adapters.add(adapter);
  return () => {
    adapters.delete(adapter);
  };
}

export function findMcpAppViewAdapter(descriptor: Readonly<McpAppDescriptor>) {
  return [...adapters].find(
    adapter =>
      descriptor.serverName === adapter.serverName &&
      descriptor.uiResourceUri === adapter.uiResourceUri &&
      adapter.entryTools.includes(descriptor.toolName),
  );
}

export function findMcpAppReferenceAdapter(toolName: string) {
  return [...adapters].find(adapter => adapter.referenceTool === toolName);
}
