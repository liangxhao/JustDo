import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { registerManagedPeerSendGuard } from './collaboration/managed-peer-send-guard';
import { registerDiscussionOfflineControl } from './discussion/discussion-offline-control';
import { registerDiscussionHolding } from './discussion/discussion-holding';
import { registerAgentTeamLaunchGuard } from './launch/agent-team-launch-guard';

/** Retain custody, receipt reconciliation and safe retirement after Agent Team is disabled. */
export function registerAgentTeamRuntimeServices(api: OpenClawPluginApi): void {
  registerAgentTeamLaunchGuard(api);
  registerDiscussionHolding(api);
  registerManagedPeerSendGuard(api);
  registerDiscussionOfflineControl(api);
}
