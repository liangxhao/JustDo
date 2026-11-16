import { isNativeDashboardSessionKey } from '../../../shared/cowork/subagentDetails';
import type { PermissionMode } from '../../../shared/security/approvals';

export { isNativeDashboardSessionKey };

/** OpenClaw creates visible spawns as dashboard sessions with trusted spawn provenance. */
export function isVisibleNativeChildSession(
  entry: Record<string, unknown>,
  agentId: string,
): boolean {
  return (
    isNativeDashboardSessionKey(entry.key, agentId) &&
    entry.incognito !== true &&
    entry.createdVia === 'spawn' &&
    typeof entry.spawnDepth === 'number' &&
    Number.isSafeInteger(entry.spawnDepth) &&
    entry.spawnDepth > 0 &&
    typeof entry.parentSessionKey === 'string' &&
    !!entry.parentSessionKey.trim() &&
    !(typeof entry.execNode === 'string' && entry.execNode.trim()) &&
    !(typeof entry.repositoryWorkspaceId === 'string' && entry.repositoryWorkspaceId.trim())
  );
}

export function readNativeSessionWorkspace(entry: Record<string, unknown>): unknown {
  return entry.sessionRoot ?? entry.spawnedCwd ?? entry.spawnedWorkspaceDir;
}

export function readNativeSessionPermissionMode(permissionMode: unknown): PermissionMode | undefined {
  switch (permissionMode) {
    case undefined:
    case 'guarded':
      return 'ask';
    case 'workspace':
      return 'auto';
    case 'full':
      return 'full';
    default:
      return undefined;
  }
}
