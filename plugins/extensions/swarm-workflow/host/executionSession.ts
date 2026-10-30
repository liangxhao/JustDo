import type { AppExecutionSessionQuery, AppMainHost } from '@app-plugin/sdk/main';

import { FLOW_RPC } from '../contracts/flow';
import { resolveWorkflowSourceSession } from './sourceSession';

export async function resolveWorkflowExecutionSession(
  host: AppMainHost,
  query: AppExecutionSessionQuery,
) {
  if (!query.runId) return null;
  const runtime = host.getRuntime();
  const responseContext = runtime?.captureGatewayResponseContext();
  if (!runtime || !responseContext) return null;
  const response = await host.requestConnectedGateway<{
    executionSession: null | {
      sessionKey: string;
      nativeSessionId: string;
      runId: string;
      parentKey: string;
      parentNativeSessionId: string;
      label: string;
    };
  }>(FLOW_RPC.executionSession, query);
  host.assertActive();
  const source = response.executionSession;
  if (
    !source ||
    host.getRuntime() !== runtime ||
    !responseContext.isCurrent() ||
    typeof source.parentNativeSessionId !== 'string' ||
    !source.parentNativeSessionId.trim() ||
    typeof source.label !== 'string' ||
    source.label.length > 256 ||
    source.sessionKey !== query.sessionKey ||
    source.nativeSessionId !== query.nativeSessionId ||
    source.runId !== query.runId
  )
    return null;
  const owner = resolveWorkflowSourceSession(host, runtime, source.parentKey);
  if (
    !owner ||
    !responseContext.isCurrent() ||
    (owner.historyBinding && owner.historyBinding.nativeSessionId !== source.parentNativeSessionId)
  )
    return null;
  return { ownerSessionId: owner.id, label: source.label };
}
