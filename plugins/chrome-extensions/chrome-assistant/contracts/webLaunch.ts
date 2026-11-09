/** Pure wire contracts shared by the desktop host and the independent extension. */
export const WebLaunchMethod = {
  SitesRead: 'chrome/webLaunch/sites/read',
  SitesWrite: 'chrome/webLaunch/sites/write',
  Prepare: 'chrome/webLaunch/prepare',
  Revise: 'chrome/webLaunch/revise',
  Submit: 'chrome/webLaunch/submit',
  Read: 'chrome/webLaunch/read',
  Cancel: 'chrome/webLaunch/cancel',
  Stop: 'chrome/webLaunch/stop',
  Abandon: 'chrome/webLaunch/abandon',
  Observations: 'chrome/webLaunch/observations',
  RevokeDocument: 'chrome/webLaunch/revokeDocument',
} as const;

export type WebLaunchMethod = (typeof WebLaunchMethod)[keyof typeof WebLaunchMethod];
export function isWebLaunchMethod(value: string): value is WebLaunchMethod {
  return (Object.values(WebLaunchMethod) as string[]).includes(value);
}
export type WebLaunchMode = 'draft' | 'send';
export type WebLaunchResultMode = 'none' | 'final';
export type WebLaunchPermissionMode = 'ask' | 'auto' | 'full';

export const WebLaunchErrorCode = {
  InvalidRequest: 'INVALID_REQUEST', InvalidSource: 'INVALID_SOURCE', InvalidOrigin: 'INVALID_ORIGIN',
  RequestTooLarge: 'REQUEST_TOO_LARGE', ContextTooLarge: 'CONTEXT_TOO_LARGE', UnsupportedInput: 'UNSUPPORTED_INPUT',
  RequestConflict: 'REQUEST_CONFLICT', SiteNotAllowed: 'SITE_NOT_ALLOWED', PolicyConflict: 'POLICY_CONFLICT',
  Expired: 'EXPIRED', ComposerBusy: 'COMPOSER_BUSY', CapacityExceeded: 'CAPACITY_EXCEEDED',
  ConfirmationRequired: 'CONFIRMATION_REQUIRED', ResultConsentRequired: 'RESULT_CONSENT_REQUIRED',
  ComposeChanged: 'COMPOSE_CHANGED', TooLate: 'TOO_LATE', UnknownExecution: 'UNKNOWN_EXECUTION',
  ExecutionFailed: 'EXECUTION_FAILED', ExecutionInterrupted: 'EXECUTION_INTERRUPTED',
  StorageUnavailable: 'STORAGE_UNAVAILABLE', AppNotRunning: 'APP_NOT_RUNNING', NativeUnavailable: 'NATIVE_UNAVAILABLE',
  ResultUnavailable: 'RESULT_UNAVAILABLE', UnsupportedResultMode: 'UNSUPPORTED_RESULT_MODE', InternalError: 'INTERNAL_ERROR',
} as const;
export type WebLaunchErrorCode = (typeof WebLaunchErrorCode)[keyof typeof WebLaunchErrorCode];

export interface WebLaunchInput {
  prompt: string;
  context?: { text: string };
  mode: WebLaunchMode;
  result: WebLaunchResultMode;
}

export interface WebLaunchActualInput {
  prompt: string;
  context?: { text: string };
  modelRef?: string;
  permissionMode?: WebLaunchPermissionMode;
}

export interface WebLaunchSource {
  chromeInstanceId: string;
  windowInstanceId: string;
  windowId: number;
  tabId: number;
  frameId: 0;
  documentId: string;
  channelGeneration: number;
  origin: string;
  url?: string;
  title?: string;
}

export interface WebLaunchSitePolicy {
  origin: string;
  enabled: boolean;
  allowSend: boolean;
  allowResult: boolean;
  revision: number;
}

export interface WebLaunchSites {
  revision: number;
  sites: WebLaunchSitePolicy[];
}

export interface WebLaunchPrepare {
  source: WebLaunchSource;
  documentLeaseId?: string;
  requestId: string;
  bindingRevision: number;
  clickSequence: number;
  payloadDigest: string;
  input: WebLaunchInput;
  /** First-connection continuation can only create a draft requiring human consent. */
  connectionOnly?: true;
  /** Required with connectionOnly; compare the global policy revision atomically. */
  expectedPolicyRevision?: number;
}

export interface WebLaunchReference {
  source: WebLaunchSource;
  documentLeaseId: string;
  launchId: string;
}

/** Lost prepare ACKs are reconciled by reading, never by recreating the request. */
export interface WebLaunchRead {
  source: WebLaunchSource;
  documentLeaseId?: string;
  launchId?: string;
  requestId?: string;
}

export interface WebLaunchSubmit {
  launchId: string;
  composeRevision: number;
  input: WebLaunchActualInput;
  submission: 'automatic' | 'confirmed';
  shareResult: boolean;
  rememberSend?: boolean;
  rememberResult?: boolean;
  confirmNewTask?: boolean;
}

export type WebLaunchRequestStatus =
  | 'drafted' | 'awaiting-confirmation' | 'submitting' | 'submitted'
  | 'rejected' | 'cancelled' | 'expired';
export type WebLaunchExecutionStatus =
  | 'not-started' | 'running' | 'unknown' | 'completed' | 'failed' | 'interrupted';
export type WebLaunchOutputStatus =
  | 'not-requested' | 'awaiting-consent' | 'pending' | 'available'
  | 'empty' | 'unsupported' | 'unavailable' | 'withheld';

/** Only this whitelist may be projected into an untrusted webpage. */
export interface WebLaunchReceipt {
  requestId: string;
  launchId: string;
  receiptRevision: number;
  request: { status: WebLaunchRequestStatus };
  execution: { status: WebLaunchExecutionStatus; executionSettled: boolean };
  output: { status: WebLaunchOutputStatus; text?: string; format?: 'text' };
  delivery: { status: 'connected' | 'disconnected' | 'acknowledged' | 'revoked' };
  error?: { code: string; messageKey: string };
}

/** This metadata stays inside the authenticated extension/desktop boundary. */
export interface WebLaunchInternal {
  threadId: string;
  documentLeaseId: string;
  composeRevision: number;
  deadlineAt: number;
  requiresSendConfirmation: boolean;
  requiresResultConsent: boolean;
  requiresUnknownConfirmation?: boolean;
  clientTurnId?: string;
  nativeRunId?: string;
}

export interface WebLaunchResponse {
  receipt: WebLaunchReceipt;
  internal: WebLaunchInternal;
}

export interface WebLaunchEnvelope {
  /** Reopened unsubmitted input must be confirmed again by the human. */
  restored?: boolean;
  launchId: string;
  requestId: string;
  origin: string;
  threadId: string;
  mode: WebLaunchMode;
  result: WebLaunchResultMode;
  prompt: string;
  contextText?: string;
  expiresAt: number;
  automaticSendAllowed: boolean;
  shareAllowed: boolean;
  requiresUnknownConfirmation?: boolean;
  composeRevision: number;
  receipt: WebLaunchReceipt;
}

export const WebLaunchLimits = {
  promptCharacters: 16_000,
  contextCharacters: 24_000,
  requestBytes: 128 * 1024,
  resultBytes: 256 * 1024,
  activeReceipts: 100,
  automaticAdmissionMs: 120_000,
  confirmationMs: 15 * 60_000,
  bridgeMs: 5_000,
} as const;

/** Stable serialization; callers hash its UTF-8 bytes in their owning realm. */
export function canonicalWebLaunchInput(input: WebLaunchInput): string {
  return JSON.stringify({
    prompt: input.prompt,
    ...(input.context ? { context: { text: input.context.text } } : {}),
    mode: input.mode,
    result: input.result,
  });
}
