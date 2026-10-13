import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { registerAgentTeamLaunchGuard } from '../../../openclaw-extensions/runtime-services/agent-team/launch/agent-team-launch-guard';
import { registerDiscussionOfflineControl } from '../../../openclaw-extensions/runtime-services/agent-team/discussion/discussion-offline-control';
import { registerManagedPeerSendGuard } from '../../../openclaw-extensions/runtime-services/agent-team/collaboration/managed-peer-send-guard';
export default {
  id: 'runtime-services',
  name: 'Independent runtime services fixture',
  register(api: OpenClawPluginApi) {
    registerDiscussionOfflineControl(api);
    registerManagedPeerSendGuard(api);
    registerAgentTeamLaunchGuard(api);
  },
};
