import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { WebContents } from 'electron';

import { MAIN_USER_AGENT_ID } from '../../../shared/agents/agents';
import { mcpAppRecord, type McpAppWorkspaceBinding } from '../../../shared/plugins/mcpApps';
import {
  resolvePermissionMode,
  toOpenClawSessionPermissionMode,
} from '../../../shared/security/approvals';
import type { CoworkStore } from '../../data/coworkStore';

interface Dependencies {
  getStore: () => CoworkStore;
  request: <T>(method: string, params: unknown) => Promise<T>;
}
interface WorkspaceEntry {
  signature: string;
  released: boolean;
  task: Promise<{ binding: McpAppWorkspaceBinding; lifecycleRevision: string }>;
}

/** Owned native preview sessions, without creating a product conversation. */
export class WorkspaceAppSessions {
  private readonly owners = new Map<WebContents, Map<string, WorkspaceEntry>>();
  private readonly watchedOwners = new WeakSet<WebContents>();

  constructor(private readonly deps: Dependencies) {}

  private async create(scope: ReturnType<WorkspaceAppSessions['scope']>) {
    const sessionKey = `agent:${scope.agentId}:workspace-preview:${randomUUID()}`;
    const result = await this.deps.request<{
      key: string;
      sessionId: string;
      entry: Record<string, unknown>;
      runStarted: boolean;
    }>('sessions.create', {
      key: sessionKey,
      agentId: scope.agentId,
      cwd: scope.cwd,
      permissionMode: scope.permissionMode,
    });
    if (
      result.key !== sessionKey ||
      typeof result.sessionId !== 'string' ||
      !result.sessionId ||
      result.entry?.sessionId !== result.sessionId ||
      typeof result.entry.lifecycleRevision !== 'string' ||
      result.runStarted !== false
    )
      throw new Error('Invalid native App workspace');
    return {
      binding: { sessionKey, gatewaySessionId: result.sessionId, agentId: scope.agentId },
      lifecycleRevision: result.entry.lifecycleRevision,
    };
  }

  private scope(raw: unknown) {
    const input = mcpAppRecord(raw);
    if (
      typeof input?.requestId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId) ||
      typeof input.agentId !== 'string' ||
      !/^[a-z0-9_-]{1,64}$/i.test(input.agentId) ||
      typeof input.cwd !== 'string' ||
      input.cwd.length > 4096 ||
      !path.isAbsolute(input.cwd)
    )
      throw new Error('Invalid App workspace');
    const store = this.deps.getStore();
    const config = store.getConfig();
    const agent = store.getAgent(input.agentId);
    if (
      !agent?.enabled ||
      agent.deletedAt ||
      !config.workingDirectory.trim() ||
      !path.isAbsolute(config.workingDirectory) ||
      (input.agentId !== MAIN_USER_AGENT_ID && config.allowMainAgentSwitch !== true) ||
      path.resolve(input.cwd) !== path.resolve(config.workingDirectory)
    )
      throw new Error('App workspace is no longer current');
    const cwd = path.resolve(config.workingDirectory);
    const permissionMode = toOpenClawSessionPermissionMode(
      resolvePermissionMode(config.permissionMode),
    );
    return {
      requestId: input.requestId,
      agentId: input.agentId,
      cwd,
      permissionMode,
      signature: JSON.stringify([input.agentId, cwd, permissionMode]),
    };
  }

  async prepare(owner: WebContents, raw: unknown): Promise<McpAppWorkspaceBinding> {
    const scope = this.scope(raw);
    if (owner.isDestroyed()) throw new Error('App workspace is closed');
    let entries = this.owners.get(owner);
    if (!entries) {
      entries = new Map();
      this.owners.set(owner, entries);
    }
    if (!this.watchedOwners.has(owner)) {
      this.watchedOwners.add(owner);
      owner.once('destroyed', () => {
        for (const id of this.owners.get(owner)?.keys() ?? [])
          void this.release(owner, id).catch((): undefined => undefined);
      });
    }
    let entry = entries.get(scope.requestId);
    const existing = Boolean(entry);
    if (entry && (entry.released || entry.signature !== scope.signature))
      throw new Error('App workspace changed');
    if (!entry) {
      if (entries.size >= 8) throw new Error('Too many App workspaces');
      const next: WorkspaceEntry = {
        signature: scope.signature,
        released: false,
        task: this.create(scope),
      };
      entries.set(scope.requestId, next);
      entry = next;
    }
    const { binding } = await entry.task;
    if (entry.released || owner.isDestroyed() || this.scope(raw).signature !== entry.signature)
      throw new Error('App workspace changed during preparation');
    const { session } = await this.deps.request<{ session?: Record<string, unknown> }>(
      'sessions.describe',
      { key: binding.sessionKey, agentId: binding.agentId },
    );
    // Only explicit preparation may replace a removed owned context. Existing
    // native identities must still match; live view lifecycle checks stay native.
    if (!session && existing && !entry.released && !owner.isDestroyed()) {
      entries.delete(scope.requestId);
      return this.prepare(owner, raw);
    }
    if (
      entry.released ||
      owner.isDestroyed() ||
      this.scope(raw).signature !== entry.signature ||
      session?.sessionId !== binding.gatewaySessionId ||
      session.sessionRoot !== scope.cwd ||
      session.permissionMode !== scope.permissionMode
    )
      throw new Error('Native App workspace changed');
    return binding;
  }

  async release(owner: WebContents, requestId: unknown): Promise<null> {
    if (typeof requestId !== 'string') throw new Error('Invalid App workspace');
    const entries = this.owners.get(owner);
    const entry = entries?.get(requestId);
    if (!entry) return null;
    entry.released = true;
    try {
      const { binding, lifecycleRevision } = await entry.task;
      await this.deps.request('sessions.delete', {
        key: binding.sessionKey,
        agentId: binding.agentId,
        expectedSessionId: binding.gatewaySessionId,
        expectedLifecycleRevision: lifecycleRevision,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      });
    } finally {
      entries?.delete(requestId);
      if (!entries?.size) this.owners.delete(owner);
    }
    return null;
  }
}
