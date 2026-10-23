import { randomUUID } from 'node:crypto';

import {
  EXTERNAL_MCP_CLOSE_METHOD,
  EXTERNAL_MCP_OPEN_METHOD,
  type ExternalMcpCloseResult,
  type ExternalMcpOpenResult,
  type ExternalMcpServer,
} from '../../../../plugins/extensions/runtime-services/contracts/external-mcp';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import type { ExternalPermissionPresenter } from '../../openclaw/permissions/externalApprovalRouting';
import type { AcpSessionResources } from './acpSession';
import type { ExternalAgentNativeBinding, ExternalAgentThread } from './externalAgentTypes';
import { ExternalAgentOutcomeUnknownError } from './externalAgentTypes';

interface Lease {
  id: string;
  binding: ExternalAgentNativeBinding;
  opening: Promise<unknown>;
  closing?: Promise<void>;
}

interface ApprovalOwner {
  release: () => void;
  controller: AbortController;
}

/** Product-owned leases; native Runtime Services owns MCP processes and tools. */
export class ExternalAgentResources implements AcpSessionResources {
  private readonly leases = new Map<string, Lease>();
  private readonly owners = new Map<string, ApprovalOwner>();
  private readonly closed = new Set<string>();

  constructor(private readonly getRuntime: () => OpenClawRuntimeAdapter | null) {}

  async prepare(
    thread: ExternalAgentThread,
    servers: ExternalMcpServer[],
    binding: ExternalAgentNativeBinding,
    present: ExternalPermissionPresenter,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (this.closed.has(thread.id)) throw new Error('The external session is closed.');
    const runtime = this.getRuntime();
    if (!runtime || runtime.getGatewayClient() !== binding.client)
      throw new Error('The native connection changed.');
    let lease = this.leases.get(thread.id);
    if (
      lease &&
      (lease.binding.sessionId !== binding.sessionId ||
        lease.binding.lifecycleRevision !== binding.lifecycleRevision ||
        lease.binding.client !== binding.client)
    ) {
      await this.releaseLease(thread.id, lease);
      lease = undefined;
    }
    if (servers.length && !lease) {
      const id = randomUUID();
      lease = {
        id,
        binding,
        opening: binding.client
          .request<ExternalMcpOpenResult>(EXTERNAL_MCP_OPEN_METHOD, {
            leaseId: id,
            sessionKey: binding.sessionKey,
            sessionId: binding.sessionId,
            cwd: thread.cwd,
            servers,
          })
          .then(result => {
            if (
              result.ok !== true ||
              result.leaseId !== id ||
              result.serverCount !== servers.length ||
              !Number.isSafeInteger(result.toolCount) ||
              result.toolCount < 0
            ) {
              throw new Error('The session MCP preparation receipt is invalid.');
            }
            return result;
          }),
      };
      this.leases.set(thread.id, lease);
    }
    if (lease) {
      try {
        await lease.opening;
      } catch (error) {
        try {
          await this.releaseLease(thread.id, lease);
        } catch {
          throw new ExternalAgentOutcomeUnknownError('Session MCP cleanup could not be confirmed.');
        }
        throw error;
      }
    }
    if (this.closed.has(thread.id) || runtime.getGatewayClient() !== binding.client) {
      if (lease) await this.releaseLease(thread.id, lease);
      throw new Error('The external session closed during preparation.');
    }
    const controller = new AbortController();
    const authority = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const owner = {
      controller,
      release: runtime.claimExternalApprovalOwner(binding, present, authority),
    };
    this.owners.set(thread.id, owner);
    return () => {
      if (this.owners.get(thread.id) !== owner) return;
      this.owners.delete(thread.id);
      controller.abort();
      owner.release();
    };
  }

  async close(sessionId: string): Promise<void> {
    this.closed.add(sessionId);
    // Retire presentation immediately, but keep routing later approvals to deny
    // until exact native settlement invokes the prepared turn's cleanup.
    this.owners.get(sessionId)?.controller.abort();
    const lease = this.leases.get(sessionId);
    if (lease) await this.releaseLease(sessionId, lease);
  }

  private async releaseLease(sessionId: string, lease: Lease): Promise<void> {
    lease.closing ??= (async () => {
      await lease.opening.catch(() => {});
      const result = await lease.binding.client.request<ExternalMcpCloseResult>(
        EXTERNAL_MCP_CLOSE_METHOD,
        {
          leaseId: lease.id,
          sessionKey: lease.binding.sessionKey,
          sessionId: lease.binding.sessionId,
        },
      );
      if (result.ok !== true) throw new Error('Session MCP cleanup is unconfirmed.');
      if (this.leases.get(sessionId) === lease) this.leases.delete(sessionId);
    })();
    await lease.closing;
  }
}
