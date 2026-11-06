import type Database from 'better-sqlite3';

import type {
  WebLaunchExecutionStatus,
  WebLaunchMode,
  WebLaunchOutputStatus,
  WebLaunchRequestStatus,
  WebLaunchResultMode,
  WebLaunchSitePolicy,
  WebLaunchSource,
} from '../../../../plugins/browser-extensions/browser-assistant/contracts/webLaunch';
import type { CoworkNativeSendBinding } from '../../engine/types';
import { failWebLaunch } from './browserWebLaunchValidation';

export interface WebLaunchNativeBinding extends CoworkNativeSendBinding {
  nativeRunId: string;
  clientTurnId: string;
}
export interface WebLaunchDocumentLease {
  id: string;
  sourceKey: string;
  source: WebLaunchSource;
  highWater: number;
  active: boolean;
  expiresAt: number;
}
export interface WebLaunchStoredReceipt {
  launchId: string;
  requestId: string;
  receiptRevision: number;
  leaseId: string;
  source: WebLaunchSource;
  sourceKey: string;
  windowKey: string;
  clickSequence: number;
  bindingRevision: number;
  payloadDigest: string;
  actualDigest: string;
  mode: WebLaunchMode;
  result: WebLaunchResultMode;
  composeRevision: number;
  threadId: string;
  createdAt: number;
  deadlineAt: number;
  confirmationStarted: boolean;
  grantRevision: number;
  requestStatus: WebLaunchRequestStatus;
  executionStatus: WebLaunchExecutionStatus;
  executionSettled: boolean;
  outputStatus: WebLaunchOutputStatus;
  shareResult: boolean;
  shareRevoked: boolean;
  deliveryRevoked: boolean;
  autoAllowed: boolean;
  requiresUnknownConfirmation: boolean;
  confirmedNewTask?: boolean;
  observed: boolean;
  processEpoch?: string;
  clientTurnId?: string;
  dispatchAttempted?: boolean;
  notSent?: boolean;
  nativeBinding?: WebLaunchNativeBinding;
  terminal?: { status: 'completed' | 'failed' | 'interrupted'; endedAt: number; agentSeq: number };
  resultRef?: { messageId: string; digest: string };
  errorCode?: string;
}
export interface BrowserWebLaunchState {
  version: 1;
  policyRevision: number;
  sites: WebLaunchSitePolicy[];
  leases: Record<string, WebLaunchDocumentLease>;
  receipts: Record<string, WebLaunchStoredReceipt>;
  watermarks: Record<string, number>;
  unknownOrigins: string[];
  abandonedUnknownOrigins: string[];
}
export const BROWSER_WEB_LAUNCH_STATE_KEY = 'browser.web-launch.v1';

const freshState = (): BrowserWebLaunchState => ({
  version: 1, policyRevision: 0, sites: [], leases: {}, receipts: {}, watermarks: {}, unknownOrigins: [], abandonedUnknownOrigins: [],
});

/** One connection/transaction owns product rows and the metadata-only receipt. */
export class BrowserWebLaunchStore {
  constructor(private readonly database: () => Database.Database, private readonly now: () => number) {}

  read(): BrowserWebLaunchState {
    try {
      const row = this.database().prepare('SELECT value FROM kv WHERE key = ?')
        .get(BROWSER_WEB_LAUNCH_STATE_KEY) as { value: string } | undefined;
      if (!row) return freshState();
      const state = JSON.parse(row.value) as BrowserWebLaunchState;
      if (state.version !== 1 || !Number.isSafeInteger(state.policyRevision) || !Array.isArray(state.sites)
        || !state.leases || !state.receipts || !state.watermarks || !Array.isArray(state.unknownOrigins) || !Array.isArray(state.abandonedUnknownOrigins)) return failWebLaunch('STORAGE_UNAVAILABLE');
      return state;
    } catch { return failWebLaunch('STORAGE_UNAVAILABLE'); }
  }

  mutate<T>(operation: (state: BrowserWebLaunchState) => T): T {
    const db = this.database();
    // The callback must be entirely synchronous. No notifications are emitted
    // until this method has committed, including when product creation rolls back.
    return db.transaction(() => {
      const state = this.read();
      const result = operation(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) return failWebLaunch('CAPACITY_EXCEEDED');
      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(BROWSER_WEB_LAUNCH_STATE_KEY, serialized, this.now());
      return result;
    })();
  }
}
