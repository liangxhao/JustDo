import type { McpAppDiscovery, McpAppLaunchInput } from '@shared/plugins/mcpApps';

export interface McpAppFileRequest {
  filePath: string;
  isCurrent: () => boolean;
}
export type OpenMcpAppFile = (request: McpAppFileRequest) => Promise<boolean>;

/** Opening and file icons must resolve the same unambiguous handler. */
function findFileAppHandler(catalog: McpAppDiscovery | undefined, filePath: string) {
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
        .map(entry => ({ server, entry })),
    ) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Ambiguous handlers need an explicit choice; never pick one by plugin name. */
export function findFileApp(
  catalog: McpAppDiscovery | undefined,
  filePath: string,
): McpAppLaunchInput | undefined {
  const match = findFileAppHandler(catalog, filePath);
  return match
    ? {
        serverName: match.server.serverName,
        toolName: match.entry.toolName,
        entrypointType: 'file',
        filePath,
      }
    : undefined;
}

export function findFileAppIcons(catalog: McpAppDiscovery | undefined, fileName: string) {
  const match = findFileAppHandler(catalog, fileName);
  return match?.entry.icons ?? match?.server.icons;
}
