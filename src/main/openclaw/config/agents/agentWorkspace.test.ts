import path from 'path';
import { describe, expect, it } from 'vitest';

import { resolveManagedAgentWorkspace, resolveManagedAgentWorkspaceRoot } from './agentWorkspace';

describe('agent role workspace ownership', () => {
  it('gives main and specialists separate stable homes, including paths with spaces and Chinese', () => {
    const state = path.resolve('用户目录 with spaces');
    expect(resolveManagedAgentWorkspaceRoot(state)).toBe(path.join(state, 'agent-workspaces'));
    for (const id of ['main', 'research', 'review']) {
      expect(resolveManagedAgentWorkspace(state, id)).toBe(path.join(state, 'agent-workspaces', id));
    }
  });
  it('canonicalizes role IDs before constructing paths', () => {
    expect(resolveManagedAgentWorkspace('/state', '../REVIEW')).toBe(path.join('/state', 'agent-workspaces', 'review'));
  });
});
