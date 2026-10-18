import type { McpAppDiscovery, McpAppLaunchInput } from '@shared/plugins/mcpApps';

export interface McpAppFileRequest {
  filePath: string;
  isCurrent: () => boolean;
}
export type OpenMcpAppFile = (request: McpAppFileRequest) => Promise<boolean>;

/** Ambiguous handlers need an explicit choice; never pick one by plugin name. */
export function findFileApp(
  catalog: McpAppDiscovery | undefined,
  filePath: string,
): McpAppLaunchInput | undefined {
  const matches =
    catalog?.servers.flatMap(server =>
      server.entrypoints
        .filter(
          entry =>
            entry.entrypoint.type === 'file' &&
            entry.entrypoint.extensions.some(extension =>
              filePath.toLowerCase().endsWith(extension.toLowerCase()),
            ),
        )
        .map(entry => ({
          serverName: server.serverName,
          toolName: entry.toolName,
          entrypointType: 'file' as const,
          filePath,
        })),
    ) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}
