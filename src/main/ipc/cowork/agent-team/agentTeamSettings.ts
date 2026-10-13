import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';

import {
  type AgentTeamKind,
  AgentTeamSettingsIpc,
  settingsRecord,
} from '../../../../shared/cowork/agent-team/agentTeamSettings';
import { AgentTeamSettingsService } from '../../../data/agent-team/agentTeamSettingsService';

export function registerAgentTeamSettingsHandlers(getDatabase: () => Database.Database): void {
  const invoke = async (operation: (service: AgentTeamSettingsService) => unknown) => {
    try {
      return { success: true, value: operation(new AgentTeamSettingsService(getDatabase())) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'agentTeamSettingsInvalid',
      };
    }
  };
  ipcMain.handle(AgentTeamSettingsIpc.Read, () => invoke(service => service.read()));
  ipcMain.handle(AgentTeamSettingsIpc.Save, (_event, value: unknown) =>
    invoke(service => {
      const input = settingsRecord(value, ['value', 'expectedRevision']);
      return service.save(input.value, input.expectedRevision);
    }),
  );
  for (const [channel, save] of [
    [AgentTeamSettingsIpc.ReadTeam, false],
    [AgentTeamSettingsIpc.SaveTeam, true],
  ] as const)
    ipcMain.handle(channel, (_event, value: unknown) =>
      invoke(service => {
        const input = settingsRecord(
          value,
          save ? ['kind', 'roomId', 'value', 'expectedRevision'] : ['kind', 'roomId'],
        );
        if (
          !['collaboration', 'discussion'].includes(String(input.kind)) ||
          typeof input.roomId !== 'string'
        )
          throw new Error('agentTeamSettingsInvalid');
        return save
          ? service.saveTeam(
              input.kind as AgentTeamKind,
              input.roomId,
              input.value,
              input.expectedRevision,
            )
          : service.readTeam(input.kind as AgentTeamKind, input.roomId);
      }),
    );
}
