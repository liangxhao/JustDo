import type { AgentTeamLaunchCoordinator } from '../../cowork/agent-team/agentTeamLaunchCoordinator';

/** Close local admission now; remote guard cleanup cannot delay a native Stop. */
export function cancelAgentTeamLaunchWithoutWaiting(
  getLaunch: (() => AgentTeamLaunchCoordinator) | undefined,
  sessionId: string,
  clientTurnId?: string,
): void {
  try {
    void getLaunch?.()
      .cancel(sessionId, clientTurnId)
      .catch((): void => undefined);
  } catch {
    // Guard failures cannot prevent stopping the source execution.
  }
}
