/** Product-owned app-server wire conventions, independent of its transport. */
export const AppServerMethod = {
  Initialize: 'initialize',
  Initialized: 'initialized',
  ModelList: 'model/list',
  ThreadList: 'thread/list',
  ThreadLoadedList: 'thread/loaded/list',
  ThreadRead: 'thread/read',
  ThreadTurnsList: 'thread/turns/list',
  ThreadItemsList: 'thread/items/list',
  ThreadStart: 'thread/start',
  ThreadResume: 'thread/resume',
  ThreadNameSet: 'thread/name/set',
  ThreadUnsubscribe: 'thread/unsubscribe',
  TurnStart: 'turn/start',
  TurnInterrupt: 'turn/interrupt',
} as const;

export const AppServerNotificationMethod = {
  ThreadStarted: 'thread/started',
  ThreadNameUpdated: 'thread/name/updated',
  ThreadStatusChanged: 'thread/status/changed',
  ThreadClosed: 'thread/closed',
  ServerRequestResolved: 'serverRequest/resolved',
  TurnStarted: 'turn/started',
  TurnCompleted: 'turn/completed',
  ItemStarted: 'item/started',
  ItemCompleted: 'item/completed',
  AgentMessageDelta: 'item/agentMessage/delta',
  ReasoningTextDelta: 'item/reasoning/textDelta',
} as const;
export type AppServerNotificationMethod =
  (typeof AppServerNotificationMethod)[keyof typeof AppServerNotificationMethod];

export const AppServerRequestMethod = {
  CommandExecutionApproval: 'item/commandExecution/requestApproval',
  FileChangeApproval: 'item/fileChange/requestApproval',
  ToolUserInput: 'item/tool/requestUserInput',
} as const;
export type AppServerRequestMethod =
  (typeof AppServerRequestMethod)[keyof typeof AppServerRequestMethod];

export type AppServerParams = Record<string, unknown>;
export type AppServerResult = Record<string, unknown>;
export type AppServerNotify = (
  method: string,
  params: AppServerParams,
) => void;
export type AppServerOperation = (
  params: AppServerParams,
) => AppServerResult | Promise<AppServerResult>;

export const AppServerErrorStyle = {
  Standard: 'standard',
  Console: 'console',
  Codex: 'codex',
} as const;

export const AppServerErrorCode = {
  Parse: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  NotInitialized: -32002,
  Internal: -32603,
  Console: -32000,
} as const;

/** Explicit public failures; the binding owns sanitizing its domain's data. */
export class AppServerRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: AppServerParams) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

/** These operations receive no RPC ID and cannot encode response envelopes. */
export interface AppServerBinding {
  initialization: {
    result: AppServerResult;
    requireInitializedNotification: boolean;
    executeNotifications: boolean;
    errorStyle: (typeof AppServerErrorStyle)[keyof typeof AppServerErrorStyle];
  };
  threads: {
    start: AppServerOperation;
    resume?: AppServerOperation;
    list?: AppServerOperation;
    loadedList?: AppServerOperation;
    read?: AppServerOperation;
    turnsList?: AppServerOperation;
    itemsList?: AppServerOperation;
    setName?: AppServerOperation;
    unsubscribe?: AppServerOperation;
  };
  turns: { start: AppServerOperation; interrupt: AppServerOperation };
  models?: { list: AppServerOperation };
  /** Exact server-owned routes; extensions require request IDs and cannot replace core methods. */
  extensions?: Readonly<Record<string, AppServerOperation>>;
  onDisconnect: (reason?: Error) => void | Promise<void>;
}

export interface AppServerConnectionContext {
  notify: AppServerNotify;
  isClosed: () => boolean;
  /** Retire protocol admission synchronously after detached output failures. */
  fail?: (reason: Error) => void;
  request?: (
    method: AppServerRequestMethod,
    params: AppServerParams,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<unknown>;
  isExperimentalApiEnabled?: () => boolean;
}

export const isAppServerRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
