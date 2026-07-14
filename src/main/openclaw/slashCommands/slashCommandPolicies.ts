import { SlashCommandBlacklist } from '../../../shared/slashCommands';
import type { SlashCommandPolicy } from './slashCommandService';

export const justDoSlashCommandPolicy: SlashCommandPolicy = {
  include: command => !SlashCommandBlacklist.has(command.name),
};
