import type { SessionRunTiming } from '../../shared/cowork/sessionRun';
import type { PermissionMode } from '../../shared/security/approvals';

/** Common wire inputs. Each authenticated binding supplies its own source and permissions. */
export interface AppServerThreadSelection {
  id: string;
  cwd: string;
  agentId?: string;
  modelRef?: string;
}

export interface AppServerThreadMetadata extends AppServerThreadSelection {
  name: string;
  createdAt: number;
  updatedAt: number;
  permissionMode: PermissionMode;
  status: string;
  source?: string;
}

export interface AppServerModel {
  id: string;
  name: string;
  isDefault: boolean;
  inputModalities?: readonly ('text' | 'image')[];
}

/** Main-only physical identity. Never returned as public thread metadata. */
export interface AppServerHistoryIdentity {
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string;
}

export interface AppServerHistorySnapshot {
  messages: unknown[];
}

/** One verified native snapshot and independently persisted execution receipts. */
export interface AppServerThreadHistory extends AppServerHistorySnapshot {
  threadId: string;
  runs: SessionRunTiming[];
  latestExternalRunId?: string;
  unknownRunId?: string;
  /** Timing rows whose outcome has no independently verified native settlement proof. */
  unknownRunIds?: string[];
  identityRevision?: string;
}
