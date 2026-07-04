import { ipcMain } from 'electron';

import {
  type ListSlashCommandsOptions,
  type ListSlashCommandsResult,
  SlashCommandIpc,
} from '../../shared/slashCommands';
import {
  SlashCommandService,
  type SlashCommandServiceOptions,
} from '../libs/slashCommands/slashCommandService';

export const registerSlashCommandHandlers = (options: SlashCommandServiceOptions): void => {
  const service = new SlashCommandService(options);

  ipcMain.handle(
    SlashCommandIpc.List,
    async (
      _event,
      listOptions?: ListSlashCommandsOptions,
    ): Promise<ListSlashCommandsResult> => {
      try {
        return { success: true, commands: await service.list(listOptions) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list slash commands';
        console.error('[SlashCommands] Failed to list slash commands:', message);
        return {
          success: false,
          error: message,
          gatewayOffline: message.includes('not connected'),
        };
      }
    },
  );
};
