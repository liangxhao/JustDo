import { createHash } from 'node:crypto';

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

import type {
  ExternalMcpCloseRequest,
  ExternalMcpOpenRequest,
  ExternalMcpOpenResult,
} from '../contracts/external-mcp';
import type { ExternalMcpCatalogTool, ExternalMcpConnection } from './transport';
import {
  canonicalDirectory,
  MAX_ARGUMENT_BYTES,
  MAX_CATALOG_BYTES,
  MAX_RESULT_BYTES,
  MAX_TOOLS,
  parseCloseRequest,
  parseOpenRequest,
  record,
  type RecordValue,
  stableJson,
  STARTUP_TIMEOUT_MS,
} from './validation';

export type NativeEntry = RecordValue & { sessionId?: string };
export interface ToolContext {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  abortSignal?: AbortSignal;
  assertInvocationCurrent?: () => void;
}
interface CatalogTool extends ExternalMcpCatalogTool {
  server: string;
  validate: (value: unknown) => { valid: boolean };
}
interface Lease {
  request: ExternalMcpOpenRequest;
  fingerprint: string;
  nativeFingerprint: string;
  abort: AbortController;
  state: 'opening' | 'ready' | 'revoked';
  connections: Map<string, ExternalMcpConnection>;
  catalog: CatalogTool[];
  approvals: Map<
    string,
    {
      runId: string;
      inputHash: string;
      expiresAt: number;
      approved: boolean;
      isCurrent: () => boolean;
    }
  >;
  preparation: Promise<ExternalMcpOpenResult>;
  assertOwner: () => void;
  ownerSignal?: AbortSignal;
  removeOwnerListener?: () => void;
  ownerCheck?: ReturnType<typeof setInterval>;
}
interface Dependencies {
  getEntry: (sessionKey: string) => NativeEntry | undefined;
  connect: (
    server: ExternalMcpOpenRequest['servers'][number],
    cwd: string,
    signal: AbortSignal,
  ) => Promise<ExternalMcpConnection>;
}

const hash = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');
const identityMatches = (request: ExternalMcpCloseRequest, other: ExternalMcpCloseRequest) =>
  request.leaseId === other.leaseId &&
  request.sessionKey === other.sessionKey &&
  request.sessionId === other.sessionId;

/** Configuration, process handles, and one-use grants only. No messages or tool-result cache. */
export class ExternalMcpRegistry {
  private readonly leases = new Map<string, Lease>();
  private readonly sessions = new Map<string, string>();

  constructor(private readonly deps: Dependencies) {}

  private nativeFingerprint(request: ExternalMcpOpenRequest): string {
    const entry = this.deps.getEntry(request.sessionKey);
    if (
      !entry ||
      entry.sessionId !== request.sessionId ||
      !['guarded', 'workspace', 'full'].includes(String(entry.permissionMode)) ||
      typeof entry.sessionRoot !== 'string' ||
      canonicalDirectory(entry.sessionRoot) !== request.cwd
    )
      throw new Error('External MCP session authority is unavailable.');
    return hash({
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision ?? null,
      sessionRoot: entry.sessionRoot,
      permissionMode: entry.permissionMode,
      sandboxMode: entry.sandboxMode ?? null,
      toolOverrides: entry.toolOverrides ?? null,
      execNode: entry.execNode ?? null,
      repositoryWorkspaceId: entry.repositoryWorkspaceId ?? null,
    });
  }

  private assertCurrent(lease: Lease): void {
    try {
      lease.assertOwner();
      if (
        lease.state === 'revoked' ||
        lease.abort.signal.aborted ||
        lease.ownerSignal?.aborted ||
        this.leases.get(lease.request.leaseId) !== lease ||
        this.nativeFingerprint(lease.request) !== lease.nativeFingerprint
      )
        throw new Error('External MCP session changed.');
    } catch {
      this.revoke(lease);
      // Revocation immediately closes admission, then drains the owned processes.
      // Do not require an RPC on the disconnected connection to perform cleanup.
      void this.close(lease.request).catch(() => {});
      throw new Error('External MCP session changed.');
    }
  }

  async open(
    value: unknown,
    signal?: AbortSignal,
    assertOwner = () => {},
    ownerSignal?: AbortSignal,
  ): Promise<ExternalMcpOpenResult> {
    const request = parseOpenRequest(value);
    assertOwner();
    if (signal?.aborted) throw new Error('External MCP preparation was cancelled.');
    const fingerprint = hash(request);
    const existing = this.leases.get(request.leaseId);
    if (existing) {
      if (!identityMatches(existing.request, request) || existing.fingerprint !== fingerprint)
        throw new Error('External MCP lease has conflicting ownership.');
      this.assertCurrent(existing);
      return existing.preparation;
    }
    if (this.sessions.has(request.sessionKey))
      throw new Error('External MCP session already has a lease.');
    const nativeFingerprint = this.nativeFingerprint(request);
    const lease: Lease = {
      request,
      fingerprint,
      nativeFingerprint,
      abort: new AbortController(),
      state: 'opening',
      connections: new Map(),
      catalog: [],
      approvals: new Map(),
      preparation: undefined as unknown as Promise<ExternalMcpOpenResult>,
      assertOwner,
      ownerSignal,
    };
    this.leases.set(request.leaseId, lease);
    this.sessions.set(request.sessionKey, request.leaseId);
    const startupSignal = AbortSignal.any([
      lease.abort.signal,
      AbortSignal.timeout(STARTUP_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    lease.preparation = (async () => {
      try {
        for (const server of request.servers) {
          assertOwner();
          this.assertCurrent(lease);
          if (startupSignal.aborted) throw new Error('External MCP preparation was cancelled.');
          const connection = await this.deps.connect(server, request.cwd, startupSignal);
          lease.connections.set(server.name, connection);
          for (const tool of connection.tools) {
            if (lease.catalog.length >= MAX_TOOLS)
              throw new Error('External MCP catalog has too many tools.');
            lease.catalog.push({
              ...tool,
              server: server.name,
              // Independent tool schemas may reuse $id. Keep their registries
              // separate so one server's schema cannot validate another's input.
              validate: new AjvJsonSchemaValidator().getValidator(tool.inputSchema as never),
            });
          }
          if (Buffer.byteLength(JSON.stringify(this.catalog(lease))) > MAX_CATALOG_BYTES)
            throw new Error('External MCP catalog is too large.');
        }
        assertOwner();
        this.assertCurrent(lease);
        if (startupSignal.aborted) throw new Error('External MCP preparation was cancelled.');
        lease.state = 'ready';
        const disconnected = () => {
          void this.close(request).catch(() => {});
        };
        ownerSignal?.addEventListener('abort', disconnected, { once: true });
        lease.removeOwnerListener = () => ownerSignal?.removeEventListener('abort', disconnected);
        // Access can be revoked without closing the socket. Poll only these
        // bounded authority/identity facts; never renew a lease or read history.
        lease.ownerCheck = setInterval(() => {
          try {
            this.assertCurrent(lease);
          } catch {
            /* Admission is already revoked. */
          }
        }, 1000);
        lease.ownerCheck.unref?.();
        this.assertCurrent(lease);
        return {
          ok: true,
          leaseId: request.leaseId,
          serverCount: request.servers.length,
          toolCount: lease.catalog.length,
        } as const;
      } catch {
        this.revoke(lease);
        await this.dispose(lease);
        throw new Error('External MCP servers could not be prepared.');
      }
    })();
    return lease.preparation;
  }

  private catalog(lease: Lease) {
    return lease.catalog.map(({ server, name, description, inputSchema }) => ({
      server,
      name,
      ...(description ? { description } : {}),
      inputSchema,
    }));
  }

  private forContext(context: ToolContext): Lease {
    const id = context.sessionKey && this.sessions.get(context.sessionKey);
    const lease = id ? this.leases.get(id) : undefined;
    if (
      !lease ||
      lease.state !== 'ready' ||
      lease.request.sessionId !== context.sessionId ||
      context.abortSignal?.aborted
    )
      throw new Error('External MCP tools are unavailable for this session.');
    context.assertInvocationCurrent?.();
    this.assertCurrent(lease);
    return lease;
  }

  hasTools(context: ToolContext): boolean {
    try {
      return this.forContext(context).catalog.length > 0;
    } catch {
      return false;
    }
  }

  parameters(context: ToolContext): RecordValue {
    const lease = this.forContext(context);
    // Original schemas stay at their own roots in the catalog, preserving local
    // JSON references. Calls validate against those exact schemas before dispatch.
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'call'] },
        server: { type: 'string', enum: [...lease.connections.keys()] },
        tool: { type: 'string', enum: [...new Set(lease.catalog.map(tool => tool.name))] },
        arguments: { type: 'object', additionalProperties: true },
      },
      required: ['action'],
      additionalProperties: false,
    };
  }

  private call(lease: Lease, value: unknown) {
    if (
      !record(value) ||
      value.action !== 'call' ||
      typeof value.server !== 'string' ||
      typeof value.tool !== 'string' ||
      !record(value.arguments) ||
      Object.keys(value).some(key => !['action', 'server', 'tool', 'arguments'].includes(key)) ||
      Buffer.byteLength(stableJson(value)) > MAX_ARGUMENT_BYTES
    )
      throw new Error('Invalid external MCP call.');
    const tool = lease.catalog.find(
      tool => tool.server === value.server && tool.name === value.tool,
    );
    if (!tool || !tool.validate(value.arguments).valid)
      throw new Error('External MCP arguments do not match the selected tool.');
    return {
      server: value.server,
      tool: value.tool,
      args: value.arguments,
      inputHash: hash(value),
    };
  }

  approval(context: ToolContext, value: unknown) {
    const lease = this.forContext(context);
    if (record(value) && value.action === 'list') return;
    const call = this.call(lease, value);
    const id = context.toolCallId;
    if (!id || !context.runId) throw new Error('Missing native external MCP call identity.');
    // Untrusted server annotations never grant read-only or auto-approval status.
    for (const [key, entry] of lease.approvals)
      if (entry.expiresAt <= Date.now() || !entry.isCurrent()) lease.approvals.delete(key);
    if (lease.approvals.size >= 64 && !lease.approvals.has(id))
      throw new Error('Too many pending external MCP approvals.');
    // Object identity is the generation token. Reusing a tool-call ID for a
    // new native policy evaluation retires both the old grant and its callback.
    const admission = {
      runId: context.runId,
      inputHash: call.inputHash,
      expiresAt: Date.now() + 120_000,
      approved: false,
      isCurrent: () => context.abortSignal?.aborted !== true,
    };
    lease.approvals.set(id, admission);
    let resolved = false;
    return {
      title: 'Allow external MCP tool?',
      description: `Run ${call.server}/${call.tool} from the connected external client.`,
      severity: 'warning' as const,
      allowedDecisions: ['allow-once', 'deny'] as Array<'allow-once' | 'deny'>,
      timeoutMs: 120_000,
      onResolution: (decision: string) => {
        if (resolved) return;
        resolved = true;
        if (decision !== 'allow-once' || context.abortSignal?.aborted) return;
        try {
          this.assertCurrent(lease);
          if (lease.approvals.get(id) !== admission || admission.expiresAt <= Date.now()) return;
          admission.approved = true;
          admission.expiresAt = Date.now() + 30_000;
        } catch {
          /* A late approval cannot resurrect a revoked lease. */
        }
      },
    };
  }

  async execute(context: ToolContext, toolCallId: string, value: unknown, signal?: AbortSignal) {
    const lease = this.forContext(context);
    if (record(value) && value.action === 'list') {
      if (Object.keys(value).length !== 1) throw new Error('Invalid external MCP catalog request.');
      const catalog = this.catalog(lease);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ tools: catalog }) }],
        details: { tools: catalog },
      };
    }
    const call = this.call(lease, value);
    const grant = lease.approvals.get(toolCallId);
    lease.approvals.delete(toolCallId);
    if (
      !grant?.approved ||
      grant.expiresAt <= Date.now() ||
      !grant.isCurrent() ||
      grant.inputHash !== call.inputHash ||
      (context.runId && context.runId !== grant.runId)
    )
      throw new Error('External MCP call requires a current one-use approval.');
    const callSignal = AbortSignal.any([lease.abort.signal, ...(signal ? [signal] : [])]);
    if (callSignal.aborted) throw new Error('External MCP call was cancelled.');
    context.assertInvocationCurrent?.();
    this.assertCurrent(lease);
    const result = await lease.connections
      .get(call.server)!
      .invoke(call.tool, call.args, callSignal);
    context.assertInvocationCurrent?.();
    this.assertCurrent(lease);
    // Preserve the original MCP result in details, including structured content,
    // resource links, and errors. Non-text blocks also remain visible as JSON.
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES)
      throw new Error('External MCP result is too large.');
    const content =
      Array.isArray(result.content) &&
      result.content.every(
        item => record(item) && item.type === 'text' && typeof item.text === 'string',
      )
        ? result.content
        : [{ type: 'text', text: JSON.stringify(result) }];
    return { content, details: result, isError: result.isError === true };
  }

  async close(value: unknown): Promise<void> {
    const request = parseCloseRequest(value);
    const lease = this.leases.get(request.leaseId);
    if (!lease) return;
    if (!identityMatches(lease.request, request))
      throw new Error('External MCP lease has conflicting ownership.');
    this.revoke(lease);
    await lease.preparation.catch(() => {});
    await this.dispose(lease);
  }

  async closeSession(sessionKey?: string): Promise<void> {
    const leases = [...this.leases.values()].filter(
      lease => !sessionKey || lease.request.sessionKey === sessionKey,
    );
    const results = await Promise.allSettled(leases.map(lease => this.close(lease.request)));
    if (results.some(result => result.status === 'rejected'))
      throw new Error('External MCP process cleanup could not be confirmed.');
  }

  private async dispose(lease: Lease): Promise<void> {
    const results = await Promise.allSettled(
      [...lease.connections].map(async ([name, connection]) => {
        await connection.close();
        lease.connections.delete(name);
      }),
    );
    if (results.some(result => result.status === 'rejected'))
      throw new Error('External MCP process cleanup could not be confirmed.');
    if (this.leases.get(lease.request.leaseId) === lease) {
      this.leases.delete(lease.request.leaseId);
      if (this.sessions.get(lease.request.sessionKey) === lease.request.leaseId)
        this.sessions.delete(lease.request.sessionKey);
    }
  }

  private revoke(lease: Lease): void {
    lease.state = 'revoked';
    lease.approvals.clear();
    lease.abort.abort();
    if (lease.ownerCheck) clearInterval(lease.ownerCheck);
    lease.ownerCheck = undefined;
    lease.removeOwnerListener?.();
    lease.removeOwnerListener = undefined;
  }
}
