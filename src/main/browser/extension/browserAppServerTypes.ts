import type { BrowserExtensionMessageDisplay } from '../../../shared/browser/browserExtensionDisplay';
import type { BrowserExtensionStreamEvent } from '../../../shared/browser/browserExtensionStream';
import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import type { PermissionMode } from '../../../shared/security/approvals';
import { AppServerMethod } from '../../appServer/appServerProtocol';

export const BROWSER_EXTENSION_ID = 'jboajogplelmaahjbomgflnfngpolgcb';
export const BROWSER_EXTENSION_NATIVE_HOST = 'com.justdo.browserextension';
export const BROWSER_EXTENSION_PAIR_METHOD = AppServerMethod.BrowserPair;

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
  error?: { message: string };
}

export interface BrowserExtensionChatApi {
  subscribeThreadEvents: (
    sessionId: string,
    listener: (event: BrowserExtensionStreamEvent) => void,
  ) => Promise<() => void>;
  listSessions: () => Promise<BrowserExtensionThread[]> | BrowserExtensionThread[];
  getMessages: (
    sessionId: string,
    options?: { forceFullSnapshot?: boolean },
  ) => Promise<BrowserExtensionMessage[]>;
  readManagedImage?: (sessionId: string, source: string) => Promise<string>;
  startThread: (title?: string) => Promise<BrowserExtensionThread>;
  getComposerOptions: (sessionId?: string) => Promise<BrowserExtensionComposerOptions>;
  sendMessage: (request: BrowserExtensionChatRequest) => Promise<BrowserExtensionTurnResult>;
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
