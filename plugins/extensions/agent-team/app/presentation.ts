import type { AppHistoryPresentation } from '@app-plugin/sdk/history-presentation';

import { TEAM_DISCUSSION_CHANNEL } from '../contracts/teamDiscussion';
import { stripAgentTeamInstruction } from '../prompt/agentTeamPrompt';
import { isTeamDiscussionReplyMirror } from './history/messagePresentation';
import { agentTeamTranslations } from './history/translations';

/** Static installed-artifact display rules; no business host or native authority is captured. */
export const presentation: AppHistoryPresentation = {
  text: stripAgentTeamInstruction,
  replyMirror: isTeamDiscussionReplyMirror,
  nativeInput: message => {
    if (!message || typeof message !== 'object') return;
    const value = message as {
      role?: string;
      provenance?: { kind?: string; sourceChannel?: string; sourceTool?: string };
      __openclaw?: { transport?: { channel?: string } };
    };
    return value.role === 'user' &&
      (value.__openclaw?.transport?.channel === TEAM_DISCUSSION_CHANNEL ||
        (value.provenance?.kind === 'inter_session' &&
          value.provenance.sourceChannel === TEAM_DISCUSSION_CHANNEL &&
          value.provenance.sourceTool === 'team_discussion'))
      ? { senderLabelKey: 'teamDiscussionDispatcher', senderId: 'team-discussion:dispatcher' }
      : undefined;
  },
  translations: agentTeamTranslations,
};
