import type { ChannelPlugin } from 'openclaw/plugin-sdk/core';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { TEAM_DISCUSSION_CHANNEL } from '../contracts/teamDiscussion';

type Delivery = (
  to: string,
  payload: ReplyPayload,
) => Promise<{ channel: typeof TEAM_DISCUSSION_CHANNEL; messageId: string }>;
// Channel-only and full registrations may be loaded as separate module graphs.
// Only the active Gateway service binds this process-local transport endpoint.
const key = Symbol.for('agent-team.discussion-transport.v1');
const globals = globalThis as typeof globalThis & { [key]?: { deliver?: Delivery } };
const transport = (globals[key] ??= {});
export function bindDiscussionTransport(deliver: Delivery): () => void {
  transport.deliver = deliver;
  return () => {
    if (transport.deliver === deliver) delete transport.deliver;
  };
}
const send = (to: string, payload: ReplyPayload) => {
  if (!transport.deliver) throw new Error('teamDiscussionDisabled');
  return transport.deliver(to, payload);
};
export const discussionChannel: ChannelPlugin = {
  id: TEAM_DISCUSSION_CHANNEL,
  meta: {
    id: TEAM_DISCUSSION_CHANNEL,
    label: 'Agent Team',
    selectionLabel: 'Agent Team',
    docsPath: '/plugins/agent-team',
    blurb: 'Local group discussions',
  },
  capabilities: { chatTypes: ['group'], media: true },
  config: {
    listAccountIds: () => ['default'],
    resolveAccount: () => ({ accountId: 'default', enabled: true }),
  },
  messaging: {
    normalizeTarget: target => target.replace(/^(?:agent-team:)?(?:group:)?/, ''),
    targetResolver: {
      looksLikeId: input => /^(?:agent-team:)?(?:group:)?[a-zA-Z0-9_-]{1,128}$/.test(input),
      hint: '<room id>',
    },
  },
  outbound: {
    deliveryMode: 'direct',
    sendText: context => send(context.to, { text: context.text }),
    sendMedia: context => send(context.to, { text: context.text, mediaUrl: context.mediaUrl }),
  },
};
