import type { McpAppDiscovery, McpAppLaunchInput } from '@shared/plugins/mcpApps';

import type { ManagedMcpAppOpen, McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { McpWorkspaceSession } from '@/libs/openclaw-chat/gateway/mcp-app/mcp-workspace-session';
import {
  decodeMcpAppLaunch,
  readNativeMcpAppIdentity,
} from '@/libs/openclaw-chat/pipeline/native-mcp-app';

import { openWorkspaceApp } from './workspaceApps';

export interface McpAppFileRequest {
  filePath: string;
  managed?: ManagedMcpAppOpen;
  signal?: AbortSignal;
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

export async function openManagedFileApp(
  request: McpAppFileRequest & { managed: ManagedMcpAppOpen },
  handler: NonNullable<ReturnType<typeof findFileApp>>,
  sessionId: string,
  owner: McpAppViewContext,
  isCurrent: () => boolean,
): Promise<boolean> {
  const agentId = owner.apps.agentId;
  const current = () =>
    !request.signal?.aborted && request.isCurrent() && owner.isCurrent() && isCurrent();
  if (!agentId || !current()) return false;
  const { requestId, cwd, name, takeWorkspace } = request.managed;
  let adopted = false;
  const workspace = new McpWorkspaceSession({ requestId, cwd, agentId }, {
    isCurrent: () => adopted || current(),
    canInteract: () => adopted ? owner.canDraft() : current(),
    addDraft: owner.addDraft,
    openFile: file => owner.openFile?.(file) ?? Promise.resolve(false),
  });
  takeWorkspace();
  try {
    const context = await workspace.prepare();
    if (!current()) return false;
    const launched = await workspace.apps.launch(handler.input, request.signal);
    const preview = decodeFileAppLaunch(launched, handler, context.sessionKey);
    if (!current()) return false;
    if (!preview || !context.isCurrent()) throw new Error('Managed file viewer is unavailable');
    adopted = openWorkspaceApp({
      id: `mcp-app-file:${JSON.stringify([sessionId, request.filePath, handler.id])}`,
      sessionId,
      filePath: request.filePath,
      fileHandlerId: handler.id,
      label: name,
      preview,
      context,
      dispose: () => workspace.dispose(),
    });
    return adopted;
  } finally {
    if (!adopted) workspace.dispose();
  }
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
