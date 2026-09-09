import { resolveSlashCommandBehavior, SlashCommandExecution } from '@shared/slashCommands';

import { i18nService } from '@/services/i18n';

export const rejectBlockedSlashCommand = (value: string): boolean => {
  const slashCommand = resolveSlashCommandBehavior(value);
  if (slashCommand?.execution !== SlashCommandExecution.Blocked) return false;

  window.dispatchEvent(
    new CustomEvent('app:showToast', {
      detail: {
        title: i18nService.t('coworkBlockedSlashCommandTitle'),
        message: i18nService
          .t('coworkBlockedSlashCommandMessage')
          .replace('{command}', slashCommand.name),
        tone: 'warning',
        duration: 5000,
      },
    }),
  );
  return true;
};
