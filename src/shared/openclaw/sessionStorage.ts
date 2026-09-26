export const SessionStorageIpc = {
  Status: 'cowork:session-storage:status',
  Policy: 'cowork:session-storage:policy',
  Save: 'cowork:session-storage:save',
  Run: 'cowork:session-storage:run',
} as const;

export interface SessionStoragePolicyInput {
  enabled: boolean;
  afterDays: number;
  revision: string;
}

export interface SessionStoragePolicy extends SessionStoragePolicyInput {
  applied: boolean;
}

export interface SessionStorageAgent {
  agentId: string;
  hotTranscripts: number;
  coldTranscripts: number;
  databaseBytes: number;
  walBytes: number;
  archiveBytes: number;
  embeddedArchiveBytes: number;
}

export interface SessionStorageStatus {
  agents: SessionStorageAgent[];
  maintenance: {
    running: boolean;
    lastStartedAt: number | null;
    lastCompletedAt: number | null;
    lastError: string | null;
    archivedTranscripts: number;
    externalizedTranscripts: number;
  };
}

export type SessionStorageErrorCode =
  | 'unsupported'
  | 'forbidden'
  | 'unavailable'
  | 'conflict'
  | 'invalid'
  | 'configuration'
  | 'disabled'
  | 'pending'
  | 'busy'
  | 'unknown';
export type SessionStorageResult<T> =
  { success: true; value: T } | { success: false; code: SessionStorageErrorCode };

export interface SessionStorageApi {
  getStatus: () => Promise<SessionStorageResult<SessionStorageStatus>>;
  getPolicy: () => Promise<SessionStorageResult<SessionStoragePolicy>>;
  savePolicy: (
    policy: SessionStoragePolicyInput,
  ) => Promise<SessionStorageResult<SessionStoragePolicy>>;
  run: () => Promise<SessionStorageResult<SessionStorageStatus>>;
}
