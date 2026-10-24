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
import type { GatewayResponseContext } from '../../engine/gateway/types';
import type { GatewayRequestOptions } from '../../engine/types';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';

interface Dependencies {
  getStore: () => CoworkStore;
  request: <T>(method: string, params: unknown, options?: GatewayRequestOptions) => Promise<T>;
  captureResponseContext: () => Promise<GatewayResponseContext | null>;
}
interface WorkspaceEntry {
  signature: string;
  released: boolean;
  productSessionId: string;
  sessionKey: string;
  createIssued: boolean;
  creationSettled: boolean;
  responseContext: GatewayResponseContext | null;
  task: Promise<{
    binding: McpAppWorkspaceBinding;
    lifecycleRevision: string;
    productSessionId: string;
  }>;
  releaseTask?: Promise<null>;
  replacementTask?: Promise<McpAppWorkspaceBinding>;
  replacementEntry?: WorkspaceEntry;
}

/** Owned native preview sessions, without creating a product conversation. */
export class WorkspaceAppSessions {
  private readonly owners = new Map<WebContents, Map<string, WorkspaceEntry>>();
  private readonly watchedOwners = new WeakSet<WebContents>();

  constructor(private readonly deps: Dependencies) {}

  private async create(
    scope: ReturnType<WorkspaceAppSessions['scope']>,
    entry: WorkspaceEntry,
    assertCurrent: () => void,
  ) {
    const { productSessionId, sessionKey } = entry;
    assertCurrent();
    // The native observation waits for background agent admission. Only a
    // refusal here proves that this owner has not dispatched any creation.
    const preflight = await this.deps.request<{ session: unknown }>(
      'sessions.describe', { key: sessionKey, agentId: scope.agentId }, { assertBeforeSend: assertCurrent },
    );
    assertCurrent();
    if (preflight?.session !== null) throw new Error('Reserved native App workspace already exists or is unavailable');
    entry.createIssued = true;
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
    }, { assertBeforeSend: assertCurrent });
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
      productSessionId,
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
    // Concurrent joiners of the same creation are not a later explicit re-read.
    const existing = entry?.creationSettled === true;
    if (entry && (entry.released || entry.signature !== scope.signature))
      throw new Error('App workspace changed');
    if (!entry) {
      if (entries.size >= 8) throw new Error('Too many App workspaces');
      const productSessionId = randomUUID();
      const assertOwnerCurrent = () => {
        if (
          this.owners.get(owner) !== entries || entries.get(scope.requestId) !== next ||
          next.released || owner.isDestroyed() || this.scope(raw).signature !== scope.signature
        ) throw new Error('App workspace changed during preparation');
      };
      const assertCurrent = () => {
        assertOwnerCurrent();
        if (!next.responseContext?.isCurrent()) throw new Error('App workspace changed during preparation');
      };
      const next: WorkspaceEntry = {
        signature: scope.signature,
        released: false,
        productSessionId,
        sessionKey: buildManagedSessionKey(productSessionId, scope.agentId),
        createIssued: false,
        creationSettled: false,
        responseContext: null,
        task: Promise.resolve().then(async () => {
          assertOwnerCurrent();
          next.responseContext = await this.deps.captureResponseContext();
          assertCurrent();
          return this.create(scope, next, assertCurrent);
        }).then(result => {
          next.creationSettled = true;
          return result;
        }).catch(error => {
          let current = false;
          try { assertCurrent(); current = true; } catch { /* Retain revoked or uncertain ownership. */ }
          if (current && !next.createIssued && this.isInspectionPending(error, scope.agentId, next.responseContext)) {
            // No automatic retry: a later explicit preparation may reserve a new
            // owner only after this read-only, correlated rejection was observed.
            if (this.owners.get(owner) === entries && entries.get(scope.requestId) === next) {
              entries.delete(scope.requestId);
              if (!entries.size) this.owners.delete(owner);
            }
          }
          throw error;
        }),
      };
      entries.set(scope.requestId, next);
      entry = next;
    }
    const { binding } = await entry.task;
    const responseContext = existing ? await this.deps.captureResponseContext() : entry.responseContext;
    const assertReadCurrent = () => {
      if (this.owners.get(owner) !== entries || entries.get(scope.requestId) !== entry ||
        entry.released || owner.isDestroyed() || this.scope(raw).signature !== entry.signature ||
        !responseContext?.isCurrent())
        throw new Error('App workspace changed during preparation');
    };
    assertReadCurrent();
    const { session } = await this.deps.request<{ session?: Record<string, unknown> }>(
      'sessions.describe',
      { key: binding.sessionKey, agentId: binding.agentId },
      { assertBeforeSend: assertReadCurrent },
    );
    // Only explicit preparation may replace a removed owned context. Existing
    // native identities must still match; live view lifecycle checks stay native.
    if (!session && existing && !entry.released && !owner.isDestroyed() &&
      this.scope(raw).signature === entry.signature && responseContext?.isCurrent()) {
      // Concurrent absent reads may join the replacement owned by this entry;
      // they cannot remove or recreate the successor that is already preparing.
      if (!entry.replacementTask) {
        assertReadCurrent();
        entries.delete(scope.requestId);
        entry.replacementTask = this.prepare(owner, raw);
        entry.replacementEntry = entries.get(scope.requestId);
      }
      const successor = entry.replacementEntry;
      const task = entry.replacementTask;
      const assertSuccessorCurrent = () => {
        if (!successor || this.owners.get(owner) !== entries || entries.get(scope.requestId) !== successor ||
          successor.released || owner.isDestroyed() || this.scope(raw).signature !== successor.signature ||
          !responseContext.isCurrent()) throw new Error('App workspace changed during replacement');
      };
      try {
        assertSuccessorCurrent();
        const replacement = await task;
        assertSuccessorCurrent();
        return replacement;
      } catch (error) {
        void task.catch((): undefined => undefined);
        throw error;
      }
    }
    assertReadCurrent();
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

  private isInspectionPending(error: unknown, agentId: string, context: GatewayResponseContext | null): boolean {
    try {
      if (!context?.isResponseError(error)) return false;
      const failure = mcpAppRecord(error);
      const details = mcpAppRecord(failure?.details);
      return failure?.code === 'UNAVAILABLE' && failure.gatewayCode === 'UNAVAILABLE' &&
        failure.retryable === true && details?.code === 'agent-database-inspection-pending' &&
        details.agentId === agentId;
    } catch { return false; }
  }

  async release(owner: WebContents, requestId: unknown): Promise<null> {
    if (typeof requestId !== 'string') throw new Error('Invalid App workspace');
    const entries = this.owners.get(owner);
    const entry = entries?.get(requestId);
    if (!entry) return null;
    if (entry.releaseTask) return entry.releaseTask;
    entry.released = true;
    entry.releaseTask = (async (): Promise<null> => {
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
        if (entries?.get(requestId) === entry) entries.delete(requestId);
        if (!entries?.size && this.owners.get(owner) === entries) this.owners.delete(owner);
      }
      return null;
    })();
    return entry.releaseTask;
  }

  /** First-send adoption preserves the native runtime, views and their pending context. */
  async adopt<T>(
    owner: WebContents,
    raw: unknown,
    create: (productSessionId: string, binding: McpAppWorkspaceBinding) => T,
    isCurrent: () => boolean,
  ): Promise<{ value: T; binding: McpAppWorkspaceBinding }> {
    const scope = this.scope(raw);
    const entries = this.owners.get(owner);
    const entry = entries?.get(scope.requestId);
    if (!entry || entry.released || entry.signature !== scope.signature)
      throw new Error('App workspace is no longer available');
    const { binding, productSessionId } = await entry.task;
    const { session } = await this.deps.request<{ session?: Record<string, unknown> }>(
      'sessions.describe',
      { key: binding.sessionKey, agentId: binding.agentId },
    );
    if (
      entry.released ||
      owner.isDestroyed() ||
      !isCurrent() ||
      entries?.get(scope.requestId) !== entry ||
      this.scope(raw).signature !== scope.signature ||
      session?.sessionId !== binding.gatewaySessionId ||
      session.sessionRoot !== scope.cwd ||
      session.permissionMode !== scope.permissionMode
    )
      throw new Error('Native App workspace changed before first send');
    // No await between product creation and retiring preview ownership. A window
    // cleanup must never delete the newly adopted conversation.
    const value = create(productSessionId, binding);
    entry.released = true;
    entries.delete(scope.requestId);
    if (!entries.size) this.owners.delete(owner);
    return { value, binding };
  }
}
