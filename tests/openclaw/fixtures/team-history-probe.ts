import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { registerAgentTeamLaunchGuard } from '../../../openclaw-extensions/runtime-services/agent-team/agent-team-launch-guard';
import { registerDiscussionHistory } from '../../../openclaw-extensions/runtime-services/agent-team/discussion-history';
export default {
  id: 'runtime-services',
  name: 'Independent history fixture',
  register(api: OpenClawPluginApi) {
    registerDiscussionHistory(api);
    registerAgentTeamLaunchGuard(api);
  },
};
