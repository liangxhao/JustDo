import { withAppNative } from '@app-plugin/sdk/native';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';

import { registerCollaborationHistory } from './collaboration/collaboration-history';
import { registerCollaborationService } from './collaboration/service';
import { discussionChannel } from './discussion/discussion-channel';
import { registerDiscussionHistory } from './discussion/discussion-history';
import { registerDiscussionService } from './discussion/discussion-service';
import { registerDiscussionHolding } from './runtime/discussion/holding';
import { registerAgentTeamLaunchGuard } from './runtime/launch/agent-team-launch-guard';
import { registerManagedPeerSendGuard } from './runtime/collaboration/managed-peer-send-guard';

const plugin = {
  kind: 'bundled-channel-entry' as const,
  description: 'Optional task collaboration and local group discussions',
  configSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
  loadChannelPlugin: () => discussionChannel,
  id: 'agent-team',
  name: 'Agent Team',
  register(api: OpenClawPluginApi) {
    registerAgentTeamLaunchGuard(api);
    registerManagedPeerSendGuard(api);
    registerDiscussionHolding(api);
    registerDiscussionService(api);
    registerCollaborationService(api);
    registerCollaborationHistory(api);
    registerDiscussionHistory(api);
  },
};
export default withAppNative(plugin, dispatchGatewayMethod);
