import { ipcMain } from 'electron';

import {
  TeamDiscussionIpc,
  type TeamDiscussionResult,
} from '../../../../shared/cowork/agent-team/teamDiscussion';
import {
  TeamDiscussionCoordinator,
  type TeamDiscussionDependencies,
} from '../../../cowork/agent-team/teamDiscussionCoordinator';

export function registerTeamDiscussionHandlers(
  deps: TeamDiscussionDependencies,
): () => TeamDiscussionCoordinator {
  let coordinator: TeamDiscussionCoordinator | undefined;
  const get = () => (coordinator ??= new TeamDiscussionCoordinator(deps));
  const result = async <T>(operation: () => Promise<T> | T): Promise<TeamDiscussionResult<T>> => {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return {
        success: false,
        error: /^teamDiscussion[A-Za-z]+$/.test(message) ? message : 'teamDiscussionUnavailable',
      };
    }
  };
  ipcMain.handle(TeamDiscussionIpc.CreateTask, (_event, value: unknown) =>
    result(() => get().createTask(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.Participation, (_event, value: unknown) =>
    result(() => get().setParticipation(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.List, () => result(() => get().metadata.list()));
  ipcMain.handle(TeamDiscussionIpc.Create, (_event, value: unknown) =>
    result(() => get().create(value)),
  );
  ipcMain.handle(
    TeamDiscussionIpc.Read,
    (_event, id: unknown, beforeDiscussionId: unknown, exactDiscussionIds: unknown) =>
      result(() => get().read(id, beforeDiscussionId, exactDiscussionIds)),
  );
  ipcMain.handle(TeamDiscussionIpc.Send, (_event, value: unknown) =>
    result(() => get().send(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.Enqueue, (_event, value: unknown) =>
    result(() => get().enqueue(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.CancelPending, (_event, value: unknown) =>
    result(() => get().cancelPending(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.Stop, (_event, id: unknown) => result(() => get().stop(id)));
  ipcMain.handle(TeamDiscussionIpc.Delete, (_event, id: unknown) => result(() => get().delete(id)));
  return get;
}
