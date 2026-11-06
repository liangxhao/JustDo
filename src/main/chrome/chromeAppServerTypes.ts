import type { QuestionResult } from '../../../plugins/extensions/ask-user-question/contracts/result';
import type { ChromeExtensionMessageDisplay } from '../../shared/chrome/chromeExtensionDisplay';
import type { ChromeExtensionStreamEvent } from '../../shared/chrome/chromeExtensionStream';
import type { CoworkAttachmentPayload } from '../../shared/cowork/attachments';
import type { PermissionMode } from '../../shared/security/approvals';
import type { AppServerConnectionContext } from '../appServer/appServerProtocol';
import type { AppServerModel, AppServerThreadHistory } from '../appServer/appServerTypes';
import type { CoworkStartOptions } from '../engine/types';
import type { ExternalApprovalSessionScope } from '../openclaw/permissions/externalApprovalSessionScope';
import { ChromeAppServerMethod } from './chromeAppServerProtocol';

export const CHROME_EXTENSION_ID = 'jboajogplelmaahjbomgflnfngpolgcb';
export const CHROME_EXTENSION_NATIVE_HOST = 'app.chrome_extension';
export const CHROME_EXTENSION_PAIR_METHOD = ChromeAppServerMethod.ChromePair;

export interface ChromeExtensionPageContext {
  title?: string;
  url?: string;
  selectedText?: string;
  pageText?: string;
}

export interface ChromeExtensionChatRequest {
  clientTurnId?: string;
  attachments?: CoworkAttachmentPayload[];
  message: string;
  modelRef?: string;
  permissionMode?: PermissionMode;
  sessionId?: string;
  pageContext?: ChromeExtensionPageContext;
}

/** Application-owned callbacks; never constructed from wire request properties. */
export interface ChromeExtensionTrustedSendHooks {
  assertCurrent: () => void;
  untrustedContext?: string;
  finalSyncAdmission?: CoworkStartOptions['finalSyncAdmission'];
  onNativeAccepted?: CoworkStartOptions['onNativeAccepted'];
  onNativeSendAbandoned?: () => Promise<void>;
  /** Main-only presenter belonging to this sending peer, never browser input. */
  approvals?: { context: AppServerConnectionContext; signal: AbortSignal; scope?: ExternalApprovalSessionScope };
}

export interface ChromeExtensionThread {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  modelRef?: string;
  permissionMode: PermissionMode;
}

export interface ChromeExtensionMessage {
  questionResult?: QuestionResult;
  pendingInput?: { id: string; state: string; runId?: string; incomplete?: boolean };
  rawMessage?: Record<string, unknown>;
  display?: ChromeExtensionMessageDisplay;
  role: string;
  text: string;
  thinking?: string;
  modelName?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  isError?: boolean;
}

export interface ChromeExtensionTurnResult {
  sessionId: string;
  runId: string;
  nativeRunId?: string;
}

export interface ChromeExtensionTurnState {
  id: string;
  nativeRunId?: string;
  status: 'inProgress' | 'unknown' | 'completed' | 'failed' | 'interrupted';
  executionSettled: boolean;
  startedAt?: number;
  completedAt?: number;
  error?: { message: string };
}

/** Exact logical execution attribution is supplied by Main, never by browser input. */
export type ChromeExtensionAppServerStreamEvent = ChromeExtensionStreamEvent & {
  turnId?: string;
  startedAt?: number;
};

export interface ChromeExtensionChatApi {
  readonly supportsClientApprovals?: true;
  subscribeThreadEvents: (
    sessionId: string,
    listener: (event: ChromeExtensionAppServerStreamEvent) => void,
  ) => Promise<() => void>;
  listSessions: () => Promise<ChromeExtensionThread[]> | ChromeExtensionThread[];
  getThread?: (sessionId: string) => ChromeExtensionThread;
  setThreadName?: (sessionId: string, name: string) => ChromeExtensionThread;
  getHistory?: (sessionId: string) => Promise<AppServerThreadHistory>;
  getModels?: () => Promise<AppServerModel[]>;
  getMessages: (
    sessionId: string,
    options?: { forceFullSnapshot?: boolean },
  ) => Promise<ChromeExtensionMessage[]>;
  readManagedImage?: (sessionId: string, source: string) => Promise<string>;
  startThread: (title?: string, options?: { cwd?: string; model?: string }) => Promise<ChromeExtensionThread>;
  getComposerOptions: (sessionId?: string) => Promise<ChromeExtensionComposerOptions>;
  sendMessage: (request: ChromeExtensionChatRequest, trusted?: ChromeExtensionTrustedSendHooks) => Promise<ChromeExtensionTurnResult>;
  getThreadRuntimeStatus: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<{ known: boolean; running: boolean }>;
  consumeTurnError: (sessionId: string, runId: string) => string | undefined;
  getTurnState: (sessionId: string, turnId?: string) => Promise<ChromeExtensionTurnState | null>;
  interruptThread: (sessionId: string, turnId: string) => Promise<void>;
}

export interface ChromeExtensionComposerOptions {
  modelRef?: string;
  models: Array<{ id: string; name: string }>;
  permissionMode: PermissionMode;
}

export interface ChromeExtensionAppServerCapability {
  localAppServerUrl: string;
}
