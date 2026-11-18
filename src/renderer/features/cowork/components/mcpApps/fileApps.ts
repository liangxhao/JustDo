import type { McpAppDiscovery, McpAppLaunchInput } from '@shared/plugins/mcpApps';

import {
  decodeMcpAppLaunch,
  readNativeMcpAppIdentity,
} from '@/libs/openclaw-chat/pipeline/native-mcp-app';

export interface McpAppFileRequest {
  filePath: string;
  handlerId?: string;
  focusExisting?: (handlerId: string) => boolean;
  isCurrent: () => boolean;
}
export type OpenMcpAppFile = (request: McpAppFileRequest) => Promise<boolean>;

export function findFileApps(catalog: McpAppDiscovery | undefined, filePath: string) {
  const path = filePath.toLowerCase();
  return (
    catalog?.servers.flatMap(server =>
      server.entrypoints
        .filter(
          entry =>
            entry.entrypoint.type === 'file' &&
            entry.entrypoint.extensions.some(extension => path.endsWith(extension.toLowerCase())),
        )
        .map(entry => ({
          id: JSON.stringify([server.serverName, entry.toolName, entry.resourceUri]),
          label: server.label || server.serverName,
          title: entry.title,
          resourceUri: entry.resourceUri,
          icons: entry.icons ?? server.icons,
          input: {
            serverName: server.serverName,
            toolName: entry.toolName,
            entrypointType: 'file',
            filePath,
          } satisfies McpAppLaunchInput,
        })),
    ) ?? []
  );
}

/** Without an explicit choice, only a unique handler can replace ordinary preview. */
export function findFileApp(
  catalog: McpAppDiscovery | undefined,
  filePath: string,
  handlerId?: string,
) {
  const matches = findFileApps(catalog, filePath);
  if (handlerId !== undefined) return matches.find(match => match.id === handlerId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function findFileAppIcons(catalog: McpAppDiscovery | undefined, fileName: string) {
  return findFileApp(catalog, fileName)?.icons;
}

export function decodeFileAppLaunch(
  response: unknown,
  handler: { input: { serverName: string }; resourceUri: string },
  sessionKey: string,
) {
  const preview = decodeMcpAppLaunch(response);
  const identity = readNativeMcpAppIdentity(preview);
  return identity?.serverName === handler.input.serverName &&
    identity.uiResourceUri === handler.resourceUri &&
    identity.originSessionKey === sessionKey
    ? preview
    : undefined;
}
