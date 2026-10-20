export interface AgentTeamEntry {
  cwd?: string;
  draft?: string;
  sourceSessionId?: string;
  roomId?: string;
  /** Local draft locator only; never a native send identity or authorization. */
  draftId?: string;
}
export const OPEN_AGENT_TEAM = 'app:open-agent-team';
export const openAgentTeam = (detail: AgentTeamEntry = {}) =>
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_TEAM, { detail }));
