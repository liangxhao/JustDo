import { ipcMain } from 'electron';

import type { AgentResult } from '../../../../shared/agents/agents';
import {
  CollaborationGateway,
  CollaborationIpc,
} from '../../../../shared/cowork/agent-team/collaboration';
import {
  CollaborationCoordinator,
  type CollaborationDependencies,
} from '../../../cowork/agent-team/collaborationCoordinator';
import { CollaborationStore } from '../../../data/agent-team/collaborationStore';
import type { GatewayEventFrame } from '../../../engine/gateway/types';

export function registerCollaborationHandlers(
  deps: CollaborationDependencies,
): (() => void) & { coordinator: () => CollaborationCoordinator } {
  let service: CollaborationCoordinator | undefined;
  const get = () => (service ??= new CollaborationCoordinator(deps));
  const result = async <T>(operation: () => Promise<T> | T): Promise<AgentResult<T>> => {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'collaborationInvalidMessage',
      };
    }
  };
  ipcMain.handle(CollaborationIpc.List, () =>
    result(() => new CollaborationStore(deps.getDatabase()).listRoomEntries()),
  );
  ipcMain.handle(CollaborationIpc.Read, (_event, sessionId: unknown) =>
    result(() => {
      if (typeof sessionId !== 'string') throw new Error('collaborationInvalidMembers');
      return get().read(sessionId);
    }),
  );
  ipcMain.handle(CollaborationIpc.PrepareContinuation, (_event, value: unknown) =>
    result(() => get().prepareContinuation(value)),
  );
  ipcMain.handle(
    CollaborationIpc.ReadMessages,
    (_event, input: { sessionId?: unknown; deliveryIds?: unknown }) =>
      result(() => {
        if (!input || typeof input.sessionId !== 'string' || !Array.isArray(input.deliveryIds))
          throw new Error('collaborationInvalidMessage');
        return get().readMessages(input.sessionId, input.deliveryIds);
      }),
  );
  let creating: Promise<unknown> = Promise.resolve();
  ipcMain.handle(
    CollaborationIpc.Create,
    (_event, input: { sessionId: string; agentIds: string[] }) => {
      const next = creating.then(() =>
        result(() => {
          if (!input || typeof input.sessionId !== 'string')
            throw new Error('collaborationInvalidMembers');
          return get().create(input.sessionId, input.agentIds);
        }),
      );
      creating = next;
      return next;
    },
  );
  ipcMain.handle(CollaborationIpc.Stop, (_event, sessionId: unknown) =>
    result(async () => {
      if (typeof sessionId !== 'string') throw new Error('collaborationInvalidMembers');
      await get().stop(sessionId);
    }),
  );
  ipcMain.handle(CollaborationIpc.StopMember, (_event, value: unknown) =>
    result(() => get().stopMember(value)),
  );
  return Object.assign(
    () => {
      const coordinator = get();
      deps.getRuntime()?.on('gatewayEvent', (event: GatewayEventFrame) => {
        if (event.event === 'agent') coordinator.observeExecution(event.payload);
        if (event.event === CollaborationGateway.Requested)
          void coordinator.handle(event.payload).catch((): void => undefined);
      });
      deps.getRouter().on('sessionStopped', (sessionId: string) => {
        void coordinator.stop(sessionId).catch((): void => undefined);
      });
    },
    { coordinator: get },
  );
}
