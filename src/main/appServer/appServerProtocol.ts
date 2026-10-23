/** Product-owned app-server wire conventions, independent of its transport. */
export const AppServerMethod = {
  Initialize: 'initialize',
  Initialized: 'initialized',
  ModelList: 'model/list',
  ThreadList: 'thread/list',
  ThreadRead: 'thread/read',
  ThreadStart: 'thread/start',
  ThreadResume: 'thread/resume',
  ThreadNameSet: 'thread/name/set',
  ThreadUnsubscribe: 'thread/unsubscribe',
  ThreadImage: 'thread/image',
  ComposerOptions: 'composer/options',
  BrowserPair: 'browser/extension/pair',
  TurnStart: 'turn/start',
  TurnInterrupt: 'turn/interrupt',
} as const;

export const AppServerNotificationMethod = {
  ThreadStarted: 'thread/started',
  ThreadUpdated: 'thread/updated',
  ThreadStream: 'thread/stream',
  TurnStarted: 'turn/started',
  TurnCompleted: 'turn/completed',
  ItemStarted: 'item/started',
  ItemCompleted: 'item/completed',
  AgentMessageDelta: 'item/agentMessage/delta',
  ReasoningTextDelta: 'item/reasoning/textDelta',
} as const;
export type AppServerNotificationMethod =
  (typeof AppServerNotificationMethod)[keyof typeof AppServerNotificationMethod];

export type AppServerParams = Record<string, unknown>;
export type AppServerResult = Record<string, unknown>;
export type AppServerNotify = (
  method: AppServerNotificationMethod,
  params: AppServerParams,
) => void;
export type AppServerOperation = (
  params: AppServerParams,
) => AppServerResult | Promise<AppServerResult>;

export const AppServerErrorStyle = { Standard: 'standard', Console: 'console' } as const;

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
    read?: AppServerOperation;
    setName?: AppServerOperation;
    unsubscribe?: AppServerOperation;
  };
  turns: { start: AppServerOperation; interrupt: AppServerOperation };
  models?: { list: AppServerOperation };
  composer?: { options: AppServerOperation };
  images?: { read: AppServerOperation };
  browserPairing?: { create: AppServerOperation };
  onDisconnect: (reason?: Error) => void | Promise<void>;
}

export interface AppServerConnectionContext {
  notify: AppServerNotify;
  isClosed: () => boolean;
}

export const isAppServerRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
