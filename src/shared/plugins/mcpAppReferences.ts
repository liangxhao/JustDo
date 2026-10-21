/** Presentation metadata only. Neither a content ID nor a reference grants access. */
export interface McpAppContentIdentity {
  namespace: string;
  contentId: string;
  serverName: string;
  uiResourceUri: string;
  originViewId: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
}

export interface McpAppContentReference {
  content: Readonly<McpAppContentIdentity>;
  title: string;
  operationId: string;
  toolCallId: string;
  runId: string;
  status: 'updated';
}

export const MCP_APP_REFERENCE_TAB_PREFIX = 'mcp-app-reference:';

export const sameMcpAppContent = (
  a: Readonly<McpAppContentIdentity>,
  b: Readonly<McpAppContentIdentity>,
) =>
  (
    [
      'namespace',
      'contentId',
      'serverName',
      'uiResourceUri',
      'originViewId',
      'sessionKey',
      'sessionId',
      'agentId',
    ] as const
  ).every(key => a[key] === b[key]);
