import type { CoworkSubagentDetailTask } from '@shared/cowork/subagentDetails';

type LoadSubtasks = (sessionId: string, forceRefresh: boolean) => Promise<{
  success: boolean;
  subagents?: CoworkSubagentDetailTask[];
}>;

/** Use the same native task records as the list; a session key alone only loads usage. */
export async function loadSpawnedSubtask(
  loadSubtasks: LoadSubtasks,
  parentSessionId: string,
  childSessionKey: string,
): Promise<CoworkSubagentDetailTask | null> {
  const result = await loadSubtasks(parentSessionId, true);
  if (!result.success) return null;
  return result.subagents?.find(task => task.sessionKey === childSessionKey) ?? null;
}
