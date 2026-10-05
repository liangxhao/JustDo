import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentIpc } from '../../../shared/agents/agents';
import type { CoworkStore } from '../../data/coworkStore';
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (key: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(key, handler),
  },
}));
import { registerAgentHandlers } from './agents';
const profile = {
  id: 'reviewer',
  name: 'Reviewer',
  description: '',
  model: '',
  icon: '',
  enabled: true,
  isDefault: false,
};
function setup() {
  const store = {
    listAgents: vi.fn(() => [profile]),
    getAgent: vi.fn(() => profile),
    saveAgentProfile: vi.fn(input => input),
    removeUnstartedAgent: vi.fn(),
    deleteAgent: vi.fn(),
  };
  const syncConfig = vi.fn().mockResolvedValue({ success: true });
  const requestGateway = vi
    .fn()
    .mockImplementation(async (method: string) =>
      method === 'sessions.list'
        ? { sessions: [], hasMore: false }
        : { workspace: '/roles/reviewer', file: { content: 'review only', missing: false } },
    );
  registerAgentHandlers({
    getStore: () => store as unknown as CoworkStore,
    syncConfig,
    requestGateway,
  });
  const call = (key: string, value: unknown) => handlers.get(key)!({}, value);
  return { store, syncConfig, requestGateway, call };
}
beforeEach(() => handlers.clear());
describe('agent profile and file IPC', () => {
  it('deletes availability without calling destructive native agent deletion', async () => {
    const h = setup();
    expect(await h.call(AgentIpc.Delete, 'reviewer')).toEqual({ success: true, value: undefined });
    expect(h.store.deleteAgent).toHaveBeenCalledWith('reviewer');
    expect(h.store.saveAgentProfile).toHaveBeenCalledWith({ ...profile, enabled: false });
    expect(h.syncConfig).toHaveBeenCalledOnce();
    expect(h.syncConfig.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.deleteAgent.mock.invocationCallOrder[0],
    );
    expect(h.requestGateway.mock.calls.every(([method]) => method === 'sessions.list')).toBe(true);
  });
  it('keeps a deletion reversible until the admission roster update succeeds', async () => {
    const h = setup();
    h.syncConfig.mockResolvedValueOnce({ success: false, error: 'failed' });
    expect(await h.call(AgentIpc.Delete, 'reviewer')).toEqual({ success: false, error: 'failed' });
    expect(h.store.deleteAgent).not.toHaveBeenCalled();
    expect(h.store.saveAgentProfile).toHaveBeenLastCalledWith(profile);
    expect(h.syncConfig).toHaveBeenCalledTimes(2);
  });
  it('rejects deleting main and deleting while native tasks are running', async () => {
    const h = setup();
    expect(await h.call(AgentIpc.Delete, 'main')).toEqual({
      success: false,
      error: 'agentMainRequired',
    });
    h.requestGateway.mockResolvedValueOnce({
      sessions: [{ key: 'agent:reviewer:justdo:test', activeRunIds: ['run'] }],
      hasMore: false,
    });
    expect(await h.call(AgentIpc.Delete, 'reviewer')).toEqual({
      success: false,
      error: 'agentBusy',
    });
    expect(h.store.deleteAgent).not.toHaveBeenCalled();
  });
  it('does not allow a deleted assistant to be re-enabled or edited', async () => {
    const h = setup();
    h.store.getAgent.mockReturnValue({ ...profile, deletedAt: 123 } as typeof profile);
    expect(await h.call(AgentIpc.Save, profile)).toEqual({
      success: false,
      error: 'agentUnavailable',
    });
    expect(await h.call(AgentIpc.ReadFile, { agentId: 'reviewer', name: 'AGENTS.md' })).toEqual({
      success: false,
      error: 'agentUnavailable',
    });
    expect(h.store.saveAgentProfile).not.toHaveBeenCalled();
  });
  it('applies through the existing config owner and verifies the native workspace', async () => {
    const h = setup();
    expect(await h.call(AgentIpc.Save, profile)).toMatchObject({ success: true });
    expect(h.syncConfig).toHaveBeenCalledOnce();
    expect(h.requestGateway).toHaveBeenCalledWith('agents.files.get', {
      agentId: 'reviewer',
      name: 'AGENTS.md',
    });
  });
  it('rejects edits when an active run appears on a later native page', async () => {
    const h = setup();
    h.requestGateway
      .mockResolvedValueOnce({
        sessions: [{ key: 'a', hasActiveRun: false }],
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        sessions: [{ key: 'b', activeRunIds: ['running'] }],
        hasMore: false,
      });
    expect(await h.call(AgentIpc.Save, profile)).toEqual({ success: false, error: 'agentBusy' });
    expect(h.store.saveAgentProfile).not.toHaveBeenCalled();
  });
  it('restores stored configuration after native apply fails', async () => {
    const h = setup();
    h.syncConfig.mockResolvedValueOnce({ success: false, error: 'failed' });
    expect(await h.call(AgentIpc.Save, { ...profile, name: 'Changed' })).toMatchObject({
      success: false,
    });
    expect(h.store.saveAgentProfile).toHaveBeenLastCalledWith(profile);
    expect(h.syncConfig).toHaveBeenCalledTimes(2);
  });
  it('does not overwrite a changed role file', async () => {
    const h = setup();
    expect(
      await h.call(AgentIpc.WriteFile, {
        agentId: 'reviewer',
        name: 'AGENTS.md',
        content: 'new',
        expected: { workspace: '/roles/reviewer', content: 'old', missing: false },
      }),
    ).toEqual({ success: false, error: 'agentFileConflict' });
    expect(h.requestGateway.mock.calls.some(([method]) => method === 'agents.files.set')).toBe(
      false,
    );
  });
  it('rejects paths outside the role file allowlist', async () => {
    const h = setup();
    expect(await h.call(AgentIpc.ReadFile, { agentId: 'reviewer', name: '../secrets' })).toEqual({
      success: false,
      error: 'agentInvalidFile',
    });
    expect(h.requestGateway).not.toHaveBeenCalled();
  });
  it.each(['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md', 'MEMORY.md'])(
    'writes only the selected native agent file %s',
    async name => {
      const h = setup();
      const expected = { workspace: '/roles/reviewer', content: 'review only', missing: false };
      expect(
        await h.call(AgentIpc.WriteFile, {
          agentId: 'reviewer',
          name,
          content: 'new',
          expected,
        }),
      ).toMatchObject({ success: true });
      expect(h.requestGateway).toHaveBeenCalledWith('agents.files.set', {
        agentId: 'reviewer',
        name,
        content: 'new',
      });
    },
  );
});
