import type { ExternalMcpServer } from '../../../../plugins/extensions/runtime-services/contracts/external-mcp';
import type { ExternalPermissionPresenter } from '../../openclaw/permissions/externalApprovalRouting';
import type { ExternalApprovalSessionScope } from '../../openclaw/permissions/externalApprovalSessionScope';
import type { ExternalAgentRunHooks, ExternalAgentThread } from './externalAgentTypes';

/** Per-connection media, MCP and approval resources shared by inbound protocols. */
export interface ExternalClientResources {
  prepare(
    thread: ExternalAgentThread,
    servers: ExternalMcpServer[],
    binding: Parameters<NonNullable<ExternalAgentRunHooks['onPrepared']>>[0],
    present: ExternalPermissionPresenter,
    signal?: AbortSignal,
    approvalScope?: ExternalApprovalSessionScope,
  ): Promise<() => void | Promise<void>>;
  close(sessionId: string): Promise<void>;
}
