import type { AppMainHost, AppNativeRuntime } from '@app-plugin/sdk/main';
import { parseCoworkSessionKey } from '@runtime-services/sdk/session-key';

import { isSwarmWorkflowParentKey } from '../contracts/workflow';

/** A parsed ID is only a lookup candidate; exact live runtime ownership admits it. */
export function resolveWorkflowSourceSession(
  host: AppMainHost,
  runtime: AppNativeRuntime,
  parentKey: unknown,
) {
  if (!isSwarmWorkflowParentKey(parentKey) || host.getRuntime() !== runtime) return null;
  const sessions = host.getSessions();
  const candidate = parseCoworkSessionKey(parentKey)?.sessionId;
  const session =
    sessions.getSessionByNativeKey(parentKey) ??
    (candidate ? sessions.getSession(candidate) : null);
  if (
    !session ||
    (session.historyBinding && session.historyBinding.sessionKey !== parentKey) ||
    !runtime.getSessionKeysForSession(session.id).includes(parentKey) ||
    host.getRuntime() !== runtime
  )
    return null;
  return session;
}
