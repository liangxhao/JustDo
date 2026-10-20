import { beforeEach } from 'vitest';
import { registerMessagePresentation } from '../../src/renderer/features/plugins/app/messagePresentation';
import { isTeamDiscussionReplyMirror } from '../../plugins/extensions/agent-team/app/browser/messagePresentation';
import { stripAgentTeamInstruction } from '../../plugins/extensions/agent-team/prompt/agentTeamPrompt';
import { stripSwarmWorkflowInstruction } from '../../plugins/extensions/swarm-workflow/prompt/request';
import { agentTeamTranslations } from '../../plugins/extensions/agent-team/app/browser/translations';
import { swarmWorkflowTranslations } from '../../plugins/extensions/swarm-workflow/browser/translations';
// These fixtures explicitly mount optional display contributions for old native history tests.
beforeEach(async context => {
  const file = context.task.file.filepath.replace(/\\/g, '/');
  const eligible =
    /\/src\/renderer\/libs\/openclaw-chat\/(?:pipeline\/(?:build-chat-items|message-normalizer)|components\/(?:justdo-chat\.peer-avatar|timeline\/process-history)|model\/input\/agent-team-prompt)/.test(
      file,
    );
  if (!eligible && !file.endsWith('/pipeline/swarm-workflow-display.test.ts')) return;
  const { i18nService } = await import('../../src/renderer/services/i18n');
  if (!eligible) {
    context.onTestFinished(
      registerMessagePresentation('workflow-history-fixture', {
        text: stripSwarmWorkflowInstruction,
      }),
    );
    if (typeof i18nService.registerPluginTranslations === 'function')
      context.onTestFinished(
        i18nService.registerPluginTranslations(
          'workflow-history-fixture',
          swarmWorkflowTranslations,
        ),
      );
    return;
  }
  context.onTestFinished(
    registerMessagePresentation('team-history-fixture', {
      text: stripAgentTeamInstruction,
      replyMirror: isTeamDiscussionReplyMirror,
      nativeInput: value => {
        const message = value as {
          role?: string;
          provenance?: { kind?: string; sourceChannel?: string; sourceTool?: string };
          __openclaw?: { transport?: { channel?: string } };
        } | null;
        return message?.role === 'user' &&
          (message.__openclaw?.transport?.channel === 'justdo-team' ||
            (message.provenance?.kind === 'inter_session' &&
              message.provenance.sourceChannel === 'justdo-team' &&
              message.provenance.sourceTool === 'team_discussion'))
          ? {
              senderLabel: i18nService.t('teamDiscussionDispatcher'),
              senderId: 'team-discussion:dispatcher',
            }
          : undefined;
      },
    }),
  );
  if (typeof i18nService.registerPluginTranslations === 'function')
    context.onTestFinished(
      i18nService.registerPluginTranslations('team-history-fixture', agentTeamTranslations),
    );
});
