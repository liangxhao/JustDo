export const SwarmIpc = { Snapshot: 'cowork:swarm:snapshot' } as const;

export type SwarmChildStatus = 'queued' | 'running' | 'done' | 'failed';
export interface SwarmGroup {
  groupId: string;
  createdAt: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  children: Array<{ sessionKey: string; status: SwarmChildStatus }>;
}
export interface SwarmSnapshot {
  groups: SwarmGroup[];
  otherActiveGroups: number;
}
export type SwarmSnapshotResult = { success: true; snapshot: SwarmSnapshot } | { success: false };
export interface SwarmApi {
  getSwarmSnapshot(sessionId: string): Promise<SwarmSnapshotResult>;
}
