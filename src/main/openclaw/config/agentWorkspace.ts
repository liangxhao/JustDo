import path from 'path';

import { normalizeOpenClawAgentId } from '../../../shared/agents/agentId';

// Match native workspace/cwd separation: role homes never depend on the selected project.
export function resolveManagedAgentWorkspaceRoot(stateDir: string): string {
  return path.join(stateDir, 'agent-workspaces');
}

export function resolveManagedAgentWorkspace(stateDir: string, agentId: string): string {
  return path.join(resolveManagedAgentWorkspaceRoot(stateDir), normalizeOpenClawAgentId(agentId));
}
