/** Pure wire contracts. View identities are references, never tool grants. */
export const McpAppMethod = {
  View: 'mcp.app.view',
  Discover: 'mcp.app.discover',
  Launch: 'mcp.app.launch',
  Settings: 'mcp.app.settings',
  Mention: 'mcp.app.mention',
  Onboard: 'mcp.app.onboard',
  CallTool: 'mcp.app.callTool',
  ListTools: 'mcp.app.listTools',
  ListResources: 'mcp.app.listResources',
  ListResourceTemplates: 'mcp.app.listResourceTemplates',
  ReadResource: 'mcp.app.readResource',
  WriteResource: 'mcp.app.writeResource',
  SubscribeResource: 'mcp.app.subscribeResource',
  UnsubscribeResource: 'mcp.app.unsubscribeResource',
  OpenFile: 'mcp.app.openFile',
  UpdateModelContext: 'mcp.app.updateModelContext',
  ModelContext: 'mcp.app.modelContext',
  RemoveModelContext: 'mcp.app.removeModelContext',
  FormResource: 'mcp.app.formResource',
} as const;

export const McpAppEvent = {
  HostContextChanged: 'mcp.app.hostContextChanged',
  ResourceUpdated: 'mcp.app.resourceUpdated',
  ContextRequest: 'mcp-app-context-request',
  OpenWorkspace: 'mcp-app-open-workspace',
  Draft: 'mcp-app-draft',
  DisplayMode: 'mcp-app-display-mode',
} as const;

export const McpAppIpc = {
  CreateSession: 'mcp-apps:session:create',
  Prepare: 'mcp-apps:session:prepare',
  PrepareWorkspace: 'mcp-apps:workspace:prepare',
  ReleaseWorkspace: 'mcp-apps:workspace:release',
  Questions: 'mcp-apps:questions:list',
  ResolveQuestion: 'mcp-apps:questions:resolve',
  PreviewQuestion: 'mcp-apps:questions:preview',
  UploadQuestion: 'mcp-apps:questions:upload',
  QuestionsChanged: 'mcp-apps:questions:changed',
  DownloadFile: 'mcp-apps:file:download',
} as const;

export interface NativeAppQuestion {
  id: string;
  sessionKey?: string;
  agentId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  questions: Array<{
    questionId: string;
    header: string;
    question: string;
    options: Array<{
      label: string;
      value?: string;
      description?: string;
      thumbnail?: string;
      resourceUri?: string;
      preview?: Record<string, unknown>;
    }>;
    presentation?: 'form';
    resource?: {
      viewId?: string;
      selection: 'explicit' | 'implicit';
      userOptions?: { kind: 'file' | 'directory'; accept?: string[] };
    };
    multiSelect?: boolean;
    answerFormat?: 'lines';
    allowEmpty?: boolean;
    defaultAnswers?: string[];
    isOther?: boolean;
    isSecret?: boolean;
    secretStore?: {
      name: string;
      kind: 'secret' | 'env';
      allowedHosts?: string[];
      reason?: string;
    };
    url?: string;
  }>;
}

export type McpAppIpcResult<T> = { success: true; value: T } | { success: false; error: string };
export interface McpAppWorkspaceScope {
  requestId: string;
  agentId: string;
  cwd: string;
}
export interface McpAppWorkspaceBinding {
  sessionKey: string;
  gatewaySessionId: string;
  agentId: string;
}
export interface McpAppHostApi {
  downloadFile: (
    input: import('./mcpAppDownload').McpAppDownloadInput,
  ) => Promise<McpAppIpcResult<{ canceled: boolean }>>;
  createSession: (input: {
    requestId: string;
    agentId: string;
    cwd: string;
    title: string;
  }) => Promise<McpAppIpcResult<{ sessionId: string }>>;
  prepare: (
    sessionId: string,
  ) => Promise<McpAppIpcResult<{ sessionKey: string; gatewaySessionId: string }>>;
  prepareWorkspace: (
    input: McpAppWorkspaceScope,
  ) => Promise<McpAppIpcResult<McpAppWorkspaceBinding>>;
  releaseWorkspace: (requestId: string) => Promise<McpAppIpcResult<null>>;
  questions: (sessionId: string) => Promise<McpAppIpcResult<NativeAppQuestion[]>>;
  resolveQuestion: (input: {
    sessionId: string;
    id: string;
    answers?: Record<string, string[]>;
    cancel?: true;
  }) => Promise<McpAppIpcResult<unknown>>;
  previewQuestion: (input: {
    sessionId: string;
    id: string;
    questionId: string;
    optionIndex: number;
  }) => Promise<McpAppIpcResult<unknown>>;
  uploadQuestion: (input: {
    sessionId: string;
    id: string;
    questionId: string;
  }) => Promise<McpAppIpcResult<unknown>>;
  onQuestionsChanged: (listener: () => void) => () => void;
}

/** App-owned, read-only preparation tool invoked before a user sends context. */
export const MCP_APP_PREPARE_CONTEXT_META = 'workspace/prepare-context';
export type McpAppDisplayMode = 'inline' | 'fullscreen';
export type McpAppEntrypoint =
  | { type: 'global'; quickAction?: { title: string } }
  | { type: 'thread' }
  | { type: 'file'; extensions: string[] }
  | { type: 'settings'; searchTerms?: string[] };

export interface McpAppDescriptor {
  viewId: string;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  toolCallId?: string;
  originSessionKey?: string;
  resultMetaState?: string;
}

export interface McpAppPreview {
  kind: 'mcp-app';
  viewId: string;
  title: string;
  /** Form previews use an authenticated native question view reference. */
  descriptor: McpAppDescriptor | null;
  toolCallId: string;
}

export interface McpAppIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface McpAppDiscoveredServer {
  serverName: string;
  pluginId?: string;
  label: string;
  icons?: McpAppIcon[];
  entrypoints: Array<{
    toolName: string;
    title: string;
    resourceUri: string;
    icons?: McpAppIcon[];
    entrypoint: McpAppEntrypoint;
  }>;
  settings?: { readTool: string; updateTool: string };
  mentionTool?: string;
}

export interface McpAppDiscovery {
  servers: McpAppDiscoveredServer[];
  onboarding?: Array<{ pluginId: string; title: string }>;
}

export interface McpAppResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpAppModelContext {
  updateId: string;
  [key: string]: unknown;
}

export interface McpAppViewPayload {
  html: string;
  sandboxUrl: string;
  sandboxPort: number;
  sandboxOrigin?: string;
  csp?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  hostContext?: Record<string, unknown>;
  displayMode?: McpAppDisplayMode;
  displayModes?: {
    availableDisplayModes?: McpAppDisplayMode[];
    preferredDisplayMode?: McpAppDisplayMode;
  };
  richModelContextSupported?: boolean;
  fileResourcesSupported?: boolean;
  workspaceFile?: { uri: string; name: string; writable: boolean };
  openFilesSupported?: boolean;
  messageSupported?: boolean;
  updateModelContextSupported?: boolean;
}

/** Optional plugin RPC convention for bounded workspace file snapshots. */
export const MCP_APP_FILE_OPEN_METHOD_PREFIX = 'mcp-app-files.open.';
export const MCP_APP_FILE_RESOURCE_METHOD_PREFIX = 'mcp-app-files.resource.';

export interface McpAppLaunchInput {
  serverName: string;
  toolName: string;
  entrypointType: McpAppEntrypoint['type'];
  quickAction?: boolean;
  filePath?: string;
  deepLink?: string;
}

export function mcpAppRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readMcpAppDescriptor(value: unknown): McpAppDescriptor | undefined {
  const item = mcpAppRecord(value);
  if (!item) return;
  for (const key of ['viewId', 'serverName', 'toolName', 'uiResourceUri'] as const) {
    if (typeof item[key] !== 'string' || !item[key].trim() || item[key].length > 2048) return;
  }
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(item.viewId as string)) return;
  if (!(item.uiResourceUri as string).startsWith('ui://')) return;
  if (
    ['toolCallId', 'originSessionKey', 'resultMetaState'].some(
      key => item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > 2048),
    )
  )
    return;
  return {
    viewId: item.viewId as string,
    serverName: item.serverName as string,
    toolName: item.toolName as string,
    uiResourceUri: item.uiResourceUri as string,
    ...(typeof item.toolCallId === 'string' ? { toolCallId: item.toolCallId } : {}),
    ...(typeof item.originSessionKey === 'string'
      ? { originSessionKey: item.originSessionKey }
      : {}),
    ...(typeof item.resultMetaState === 'string' ? { resultMetaState: item.resultMetaState } : {}),
  };
}
