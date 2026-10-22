import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { isAcpSessionKey, isSubagentSessionKey } from 'openclaw/plugin-sdk/routing';

const managed = (key?: string) => Boolean(key && /^agent:[^:]+:justdo:[^:]+$/.test(key));

/** Prevent stale managed peer sends even after the optional extension is unloaded. */
export function registerManagedPeerSendGuard(api: OpenClawPluginApi): void {
  // An old transcript can still contain peer keys. Do not let a broad native
  // session-visibility setting bypass the user's disabled extension choice.
  api.on('before_tool_call', (event, ctx) => {
    if (event.toolName !== 'sessions_send' || !managed(ctx.sessionKey)) return;
    if (
      typeof event.params?.sessionKey === 'string' &&
      (isSubagentSessionKey(event.params.sessionKey) || isAcpSessionKey(event.params.sessionKey))
    )
      return;
    const plugins = api.runtime.config.current().plugins;
    if (
      plugins?.enabled === false ||
      plugins?.entries?.['agent-team']?.enabled !== true ||
      plugins?.deny?.includes('agent-team') ||
      (plugins?.allow?.length && !plugins.allow.includes('agent-team'))
    ) {
      return {
        block: true,
        blockReason:
          'Agent Team is disabled. For a SubAgent, use its exact sessionKey; do not send peer tasks.',
      };
    }
  });
}
