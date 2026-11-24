/** Host-side integration of a trusted bundled MCP App. The sandbox has no access to this API. */
export interface McpAppAdapterSource {
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  originSessionKey: string;
}

export interface McpAppAdapterPayload {
  html: string;
  sandboxUrl: string;
  sandboxPort: number;
  sandboxOrigin?: string;
  csp?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  messageSupported?: boolean;
  updateModelContextSupported?: boolean;
  richModelContextSupported?: boolean;
  fileResourcesSupported?: boolean;
  openFilesSupported?: boolean;
}

export interface McpAppAdapterReceipt {
  contentId: string;
  title: string;
  originViewId: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  operationId: string;
  toolCallId: string;
  runId: string;
}

export interface McpAppPreparedCanvas {
  token: string;
  viewId: string;
  priority: number;
}

export type McpAppAdapterRequest = <T = unknown>(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<T>;

export interface McpAppAdapterBridge {
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<{ isError?: boolean; structuredContent?: unknown }>;
}

export interface McpAppAdapter {
  readonly namespace: string;
  readonly serverName: string;
  readonly uiResourceUri: string;
  readonly entryTools: readonly string[];
  readonly referenceTool: string;
  /** Declared methods for the adapter's bound view, never from sandbox input. */
  readonly viewMethods: readonly string[];
  readonly restoreMethod: string;
  readonly sendMethod: string;
  readonly sendNotIssuedCode: string;
  sendParams(
    send: Readonly<Record<string, unknown>>,
    canvases: ReadonlyArray<Omit<McpAppPreparedCanvas, 'priority'> & { selected: boolean }>,
  ): Record<string, unknown>;
  readonly ownsReadOnlyNotice?: boolean;
  /** A reviewed global entry whose explicit fresh launch only opens a blank editor. */
  readonly blankLaunch?: Readonly<{ pluginId: string; toolName: string }>;
  content(toolResult: unknown): { id: string; title?: string } | undefined;
  readReference(result: unknown, toolCallId: string): McpAppAdapterReceipt | undefined;
  restoreReferenceParams(contentId: string, operationId: string): Record<string, unknown>;
  prepareView<T extends McpAppAdapterPayload>(input: {
    source: Readonly<McpAppAdapterSource>;
    payload: T;
    request: McpAppAdapterRequest;
    releaseOnClose(method: string, params: Record<string, unknown>): void;
  }): Promise<T>;
  connect(input: {
    source: Readonly<McpAppAdapterSource>;
    contentId: string;
    bridge: McpAppAdapterBridge;
    viewId: () => string;
    current: () => boolean;
    canPrepare: () => boolean;
    priority: () => number;
    request: McpAppAdapterRequest;
    retainedRequest: McpAppAdapterRequest;
    release(method: string, params: Record<string, unknown>): Promise<unknown>;
    subscribe(listener: (event: { event: string }) => void): () => void;
    onSuspend(listener: () => void): () => void;
    registerPreparation(
      prepare: (signal: AbortSignal) => Promise<McpAppPreparedCanvas>,
    ): () => void;
  }): () => void;
}
