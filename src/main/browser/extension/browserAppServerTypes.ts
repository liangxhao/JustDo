import type { QuestionResult } from '../../../../plugins/extensions/ask-user-question/contracts/result';
import type { BrowserExtensionMessageDisplay } from '../../../shared/browser/browserExtensionDisplay';
import type { BrowserExtensionStreamEvent } from '../../../shared/browser/browserExtensionStream';
import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import type { PermissionMode } from '../../../shared/security/approvals';
import type { AppServerConnectionContext } from '../../appServer/appServerProtocol';
import type { AppServerModel, AppServerThreadHistory } from '../../appServer/appServerTypes';
import type { CoworkStartOptions } from '../../engine/types';
import type { ExternalApprovalSessionScope } from '../../openclaw/permissions/externalApprovalSessionScope';
import { BrowserAppServerMethod } from './browserAppServerProtocol';

export const BROWSER_EXTENSION_ID = 'jboajogplelmaahjbomgflnfngpolgcb';
export const BROWSER_EXTENSION_NATIVE_HOST = 'com.justdo.browserextension';
export const BROWSER_EXTENSION_PAIR_METHOD = BrowserAppServerMethod.BrowserPair;

export interface BrowserExtensionPageContext {
  title?: string;
  url?: string;
  selectedText?: string;
  pageText?: string;
}

export interface BrowserExtensionChatRequest {
  clientTurnId?: string;
  attachments?: CoworkAttachmentPayload[];
  message: string;
  modelRef?: string;
  permissionMode?: PermissionMode;
  sessionId?: string;
  pageContext?: BrowserExtensionPageContext;
}

/** Application-owned callbacks; never constructed from wire request properties. */
export interface BrowserExtensionTrustedSendHooks {
  assertCurrent: () => void;
  untrustedContext?: string;
  finalSyncAdmission?: CoworkStartOptions['finalSyncAdmission'];
  onNativeAccepted?: CoworkStartOptions['onNativeAccepted'];
  onNativeSendAbandoned?: () => Promise<void>;
  /** Main-only presenter belonging to this sending peer, never browser input. */
  approvals?: { context: AppServerConnectionContext; signal: AbortSignal; scope?: ExternalApprovalSessionScope };
}

export interface BrowserExtensionThread {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  modelRef?: string;
  permissionMode: PermissionMode;
}

export interface BrowserExtensionMessage {
  questionResult?: QuestionResult;
  pendingInput?: { id: string; state: string; runId?: string; incomplete?: boolean };
  rawMessage?: Record<string, unknown>;
  display?: BrowserExtensionMessageDisplay;
  role: string;
  text: string;
  thinking?: string;
  modelName?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  isError?: boolean;
}

export interface BrowserExtensionTurnResult {
  sessionId: string;
  runId: string;
  nativeRunId?: string;
}

export interface BrowserExtensionTurnState {
  id: string;
  nativeRunId?: string;
  status: 'inProgress' | 'unknown' | 'completed' | 'failed' | 'interrupted';
  executionSettled: boolean;
  startedAt?: number;
  completedAt?: number;
  error?: { message: string };
}

/** Exact logical execution attribution is supplied by Main, never by browser input. */
export type BrowserExtensionAppServerStreamEvent = BrowserExtensionStreamEvent & {
  turnId?: string;
  startedAt?: number;
};

export interface BrowserExtensionChatApi {
  readonly supportsClientApprovals?: true;
  subscribeThreadEvents: (
    sessionId: string,
    listener: (event: BrowserExtensionAppServerStreamEvent) => void,
  ) => Promise<() => void>;
  listSessions: () => Promise<BrowserExtensionThread[]> | BrowserExtensionThread[];
  getThread?: (sessionId: string) => BrowserExtensionThread;
  setThreadName?: (sessionId: string, name: string) => BrowserExtensionThread;
  getHistory?: (sessionId: string) => Promise<AppServerThreadHistory>;
  getModels?: () => Promise<AppServerModel[]>;
  getMessages: (
    sessionId: string,
    options?: { forceFullSnapshot?: boolean },
  ) => Promise<BrowserExtensionMessage[]>;
  readManagedImage?: (sessionId: string, source: string) => Promise<string>;
  startThread: (title?: string, options?: { cwd?: string; model?: string }) => Promise<BrowserExtensionThread>;
  getComposerOptions: (sessionId?: string) => Promise<BrowserExtensionComposerOptions>;
  sendMessage: (request: BrowserExtensionChatRequest, trusted?: BrowserExtensionTrustedSendHooks) => Promise<BrowserExtensionTurnResult>;
  getThreadRuntimeStatus: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<{ known: boolean; running: boolean }>;
  consumeTurnError: (sessionId: string, runId: string) => string | undefined;
  getTurnState: (sessionId: string, turnId?: string) => Promise<BrowserExtensionTurnState | null>;
  interruptThread: (sessionId: string, turnId: string) => Promise<void>;
}

export interface BrowserExtensionComposerOptions {
  modelRef?: string;
  models: Array<{ id: string; name: string }>;
  permissionMode: PermissionMode;
}

export interface BrowserExtensionAppServerCapability {
  localAppServerUrl: string;
}
