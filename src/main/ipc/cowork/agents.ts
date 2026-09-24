import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';

import {
  AgentFiles,
  type AgentFileSnapshot,
  AgentIpc,
  type AgentResult,
  parseAgentProfile,
} from '../../../shared/agents/agents';
import type { CoworkStore } from '../../data/coworkStore';
import { listPersistedGatewaySessions } from '../../engine/openclaw/subagentGateway';

interface AgentHandlerDependencies {
  getStore: () => CoworkStore;
  syncConfig: () => Promise<{ success: boolean; error?: string }>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
}

export const registerAgentHandlers = ({
  getStore,
  syncConfig,
  requestGateway,
}: AgentHandlerDependencies): void => {
  // Serialize profile and file writes so application editors cannot overwrite each other.
  let writes: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = writes.then(operation, operation);
    writes = next.catch((): void => undefined);
    return next;
  };
  const result = async <T>(operation: () => Promise<T>): Promise<AgentResult<T>> => {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'agentSaveFailed' };
    }
  };
  const requireAgent = (id: unknown) => {
    if (typeof id !== 'string') throw new Error('agentUnavailable');
    const agent = getStore().getAgent(id);
    if (!agent || agent.deletedAt) throw new Error('agentUnavailable');
    return agent;
  };
  const requireIdle = async () => {
    // Config synchronization can restart the Gateway. Refuse changes while native runs are active.
    const sessions = await listPersistedGatewaySessions({ request: requestGateway });
    if (
      sessions.some(
        session =>
          session.hasActiveRun === true ||
          session.hasActiveSubagentRun === true ||
          (Array.isArray(session.activeRunIds) && session.activeRunIds.length > 0),
      )
    ) {
      throw new Error('agentBusy');
    }
  };
  const readFile = async (agentId: string, name: unknown): Promise<AgentFileSnapshot> => {
    requireAgent(agentId);
    if (!AgentFiles.includes(name as (typeof AgentFiles)[number]))
      throw new Error('agentInvalidFile');
    const response = await requestGateway<{
      workspace: string;
      file: { content?: string; missing?: boolean };
    }>('agents.files.get', { agentId, name });
    if (!response.file || typeof response.workspace !== 'string')
      throw new Error('agentRuntimeUnknown');
    return {
      content: response.file.content ?? '',
      missing: response.file.missing === true,
      workspace: response.workspace,
    };
  };

  ipcMain.handle(AgentIpc.List, async () => ({
    success: true,
    agents: getStore().listAgents(),
  }));
  ipcMain.handle(AgentIpc.Delete, (_event, id: unknown) =>
    serialize(() =>
      result(async () => {
        if (typeof id !== 'string') throw new Error('agentUnavailable');
        const agent = getStore().getAgent(id);
        if (!agent) throw new Error('agentUnavailable');
        if (id === 'main' || agent.isDefault) throw new Error('agentMainRequired');
        if (agent.deletedAt) return;
        await requireIdle();
        // Native agents.delete purges session indexes even with deleteFiles:false.
        // Retain native ownership for history; all product admissions require enabled.
        getStore().deleteAgent(id);
      }),
    ),
  );
  ipcMain.handle(AgentIpc.Save, (_event, raw: unknown) =>
    serialize(() =>
      result(async () => {
        const input = parseAgentProfile(raw);
        const store = getStore();
        const previous = input.id ? requireAgent(input.id) : null;
        const previousDefault = store.listAgents().find(agent => agent.isDefault);
        if (previous?.id === 'main' && !input.enabled) throw new Error('agentMainRequired');
        if (previous?.isDefault && (!input.isDefault || !input.enabled))
          throw new Error('agentDefaultRequired');
        await requireIdle();
        const id = input.id ?? 'agent-' + randomUUID();
        const saved = store.saveAgentProfile({ ...input, id });
        try {
          const applied = await syncConfig();
          if (!applied.success) throw new Error(applied.error || 'agentSaveFailed');
          // Verify that the roster has reached the running Gateway before reporting success.
          await readFile(id, 'AGENTS.md');
          return saved;
        } catch (error) {
          if (previous) store.saveAgentProfile(previous);
          else store.removeUnstartedAgent(id);
          if (previousDefault) store.saveAgentProfile(previousDefault);
          const rollback = await syncConfig();
          if (!rollback.success) throw new Error('agentRollbackFailed');
          throw error;
        }
      }),
    ),
  );
  ipcMain.handle(AgentIpc.ReadFile, (_event, input: { agentId: string; name: string }) =>
    result(() => readFile(input?.agentId, input?.name)),
  );
  ipcMain.handle(
    AgentIpc.WriteFile,
    (
      _event,
      input: { agentId: string; name: string; content: string; expected: AgentFileSnapshot },
    ) =>
      serialize(() =>
        result(async () => {
          if (
            !input ||
            typeof input.content !== 'string' ||
            input.content.length > 100_000 ||
            !input.expected ||
            typeof input.expected.content !== 'string'
          )
            throw new Error('agentInvalidFile');
          await requireIdle();
          const current = await readFile(input.agentId, input.name);
          if (
            current.content !== input.expected.content ||
            current.missing !== input.expected.missing ||
            current.workspace !== input.expected.workspace
          )
            throw new Error('agentFileConflict');
          await requestGateway('agents.files.set', {
            agentId: input.agentId,
            name: input.name,
            content: input.content,
          });
          return readFile(input.agentId, input.name);
        }),
      ),
  );
};
