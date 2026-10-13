export * from '../../../../openclaw-extensions/agent-team/contracts/agentTeamSettings';

/** Product preferences and bounded resource metadata; never execution permissions. */
export const AgentTeamSettingsIpc = {
  Read: 'agentTeamSettings:read',
  Save: 'agentTeamSettings:save',
  ReadTeam: 'agentTeamSettings:readTeam',
  SaveTeam: 'agentTeamSettings:saveTeam',
} as const;
