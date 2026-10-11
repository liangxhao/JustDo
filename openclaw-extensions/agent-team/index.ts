import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { registerCollaborationService } from './collaboration/service';
import { discussionChannel } from './discussion/discussion-channel';
import { registerDiscussionService } from './discussion/discussion-service';

const plugin = {
  kind: 'bundled-channel-entry' as const,
  description: 'Optional task collaboration and local group discussions',
  configSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
  loadChannelPlugin: () => discussionChannel,
  id: 'agent-team',
  name: 'Agent Team',
  register(api: OpenClawPluginApi) {
    registerDiscussionService(api);
    registerCollaborationService(api);
  },
};
export default plugin;
