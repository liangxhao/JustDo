import { beforeEach } from 'vitest';

import { registerMessagePresentation } from '../../src/renderer/features/plugins/app/messagePresentation';

// Synthetic contributions exercise Core projections; exact transport validators
// and prompt rules are tested inside the owning optional plugin.
beforeEach(async context => {
  const file = context.task.file.filepath.replace(/\\/g, '/');
  if (!/\/src\/renderer\/libs\/openclaw-chat\/(?:pipeline\/(?:build-chat-items|message-normalizer)|components\/(?:justdo-chat\.peer-avatar|timeline\/process-history))/.test(file)) return;
  const { i18nService } = await import('../../src/renderer/services/i18n');
  context.onTestFinished(registerMessagePresentation('history-contract-fixture', {
    replyMirror: value => {
      const input = value as { message?: unknown; __fixturePublicMirror?: boolean } | null;
      return ((input?.message as typeof input) ?? input)?.__fixturePublicMirror === true;
    },
    nativeInput: value => (value as { __fixtureInput?: boolean })?.__fixtureInput
      ? { senderLabel: i18nService.t('teamDiscussionDispatcher'), senderId: 'team-discussion:dispatcher' }
      : undefined,
  }));
  context.onTestFinished(i18nService.registerPluginTranslations('history-contract-fixture', {
    en: { teamDiscussionDispatcher: 'Dispatcher' }, zh: { teamDiscussionDispatcher: '调度者' },
  }));
});
