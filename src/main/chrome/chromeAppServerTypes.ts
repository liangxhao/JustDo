import type { QuestionResult } from '../../../plugins/extensions/ask-user-question/contracts/result';
import type { ChromeExtensionMessageDisplay } from '../../shared/chrome/chromeExtensionDisplay';
import type { ChromeExtensionStreamEvent } from '../../shared/chrome/chromeExtensionStream';
import type { CoworkAttachmentPayload } from '../../shared/cowork/attachments';
import type { AskUserRequest } from '../../shared/cowork/interactions/askUserQuestion';
import type { SetSessionWorkspaceInput, SetSessionWorkspaceResult } from '../../shared/cowork/sessionWorkspace';
import type { PermissionMode } from '../../shared/security/approvals';
import type { AppServerConnectionContext } from '../clients/appServer/protocol/appServerProtocol';
import type { AppServerModel, AppServerThreadHistory } from '../clients/appServer/protocol/appServerTypes';
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
  expectedWorkspaceRoot?: string;
  pageContext?: ChromeExtensionPageContext;
}

/** Application-owned callbacks; never constructed from wire request properties. */
export interface ChromeExtensionTrustedSendHooks {
  assertCurrent: () => void;
  /** Ordinary interactive side-panel turn, proved by its Main app-server owner. */
  automaticErrorRetry?: true;
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
  retryAttempt?: number;
  retryWaiting?: boolean;
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
  retryAttempt?: number;
};

export interface ChromeExtensionChatApi {
  listQuestions?: (sessionId: string, assertCurrent: () => void) => Promise<ChromeExtensionQuestion[]>;
  respondQuestion?: (
    sessionId: string, requestId: string, response: ChromeExtensionQuestionResponse, assertCurrent: () => void,
  ) => Promise<void>;
  subscribeQuestions?: (sessionId: string, listener: () => void) => Promise<() => void>;
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
  startThread: (title?: string, options?: {
    cwd?: string;
    model?: string;
    /** Main-only proof that cwd came from this viewer's directory selection. */
    selectedWorkspace?: { assertCurrent: () => void };
  }) => Promise<ChromeExtensionThread>;
  selectWorkspace?: (options: { defaultPath?: string; recentCwd?: string }) => Promise<string | null>;
  setThreadWorkspace?: (input: SetSessionWorkspaceInput, isCurrent: () => boolean) => Promise<SetSessionWorkspaceResult>;
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

export type ChromeExtensionQuestion = Pick<AskUserRequest,
  'requestId' | 'questions' | 'waitPolicy' | 'expiresAt' | 'createdAt'>;
export type ChromeExtensionQuestionResponse =
  | { behavior: 'submit'; answers: unknown }
  | { behavior: 'cancel' };

export interface ChromeExtensionComposerOptions {
  cwd?: string;
  recentCwds?: string[];
  modelRef?: string;
  models: Array<{ id: string; name: string }>;
  permissionMode: PermissionMode;
}

export interface ChromeExtensionAppServerCapability {
  localAppServerUrl: string;
}
