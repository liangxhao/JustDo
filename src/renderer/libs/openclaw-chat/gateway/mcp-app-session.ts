import {
  MCP_APP_FILE_OPEN_METHOD_PREFIX,
  MCP_APP_FILE_RESOURCE_METHOD_PREFIX,
  type McpAppDescriptor,
  type McpAppDiscovery,
  type McpAppLaunchInput,
  McpAppMethod,
  type McpAppModelContext,
  type McpAppViewPayload,
} from '@shared/plugins/mcpApps';

import {
  DRAWIO_RESOURCE,
  DRAWIO_RESTORE_METHOD,
  DRAWIO_SERVER,
  DRAWIO_TOOL,
} from '../../../../../openclaw-extensions/drawio/contracts';
import {
  MCP_APP_HISTORY_TOOL_METHOD,
  MCP_APP_HISTORY_VIEW_METHOD,
} from '../../../../../openclaw-extensions/runtime-services/contracts/mcp-apps';
import type { GatewayClient, GatewayEventFrame } from './client';

export interface McpAppSessionBinding {
  client: GatewayClient;
  generation: number;
  sessionKey: string;
  sessionId: string | null;
  agentId?: string;
  isCurrent: () => boolean;
}

type Method = (typeof McpAppMethod)[keyof typeof McpAppMethod];
const methods = new Set<string>(Object.values(McpAppMethod));
const scopedFields = ['sessionKey', 'sessionId', 'agentId', 'viewId', 'requesterId', 'requestId'];

/** The chat connection owns this adapter. Features never receive its credentials. */
export class McpAppSession {
  private epoch = 0;
  private readonly views = new Set<McpAppSessionView>();
  private readonly presentations = new Map<string, McpAppSessionView>();
  private readonly contexts = new Map<
    string,
    {
      viewId: string;
      title: string;
      updateId: string;
      binding: McpAppSessionBinding;
      epoch: number;
      owner?: McpAppSessionView;
    }
  >();
  private readonly listeners = new Set<() => void>();
  private observedBinding?: McpAppSessionBinding;
  private bindingRevision = 0;
  constructor(private readonly getBinding: () => McpAppSessionBinding | undefined) {}

  get discoveryRevision(): number {
    return this.bindingRevision;
  }

  get ready(): boolean {
    const binding = this.getBinding();
    return Boolean(binding?.isCurrent() && binding.client.generation === binding.generation);
  }

  /** Notify capability discovery when authenticated history finishes binding. */
  refreshBinding(): void {
    const next = this.getBinding();
    const previous = this.observedBinding;
    if (
      previous?.client === next?.client &&
      previous?.generation === next?.generation &&
      previous?.sessionKey === next?.sessionKey &&
      previous?.sessionId === next?.sessionId
    )
      return;
    this.observedBinding = next;
    this.bindingRevision++;
    for (const listener of this.listeners) listener();
  }

  invalidate(): void {
    this.epoch++;
    this.bindingRevision++;
    for (const view of [...this.views]) {
      void view.close().catch(() => undefined);
    }
    this.views.clear();
    for (const context of [...this.contexts.values()]) {
      void this.clearContext(context.viewId, context.binding, context.epoch, context.owner).catch(
        () => undefined,
      );
    }
    this.presentations.clear();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getContexts(): Array<{ viewId: string; title: string; updateId: string }> {
    return [...this.contexts.values()]
      .filter(item => item.binding.isCurrent())
      .map(({ viewId, title, updateId }) => ({ viewId, title, updateId }));
  }

  reportContext(viewId: string, title: string, state: McpAppModelContext | null): void {
    if (state) {
      const binding = this.capture();
      if (typeof state.updateId !== 'string') return;
      this.contexts.set(viewId, {
        viewId,
        title,
        updateId: state.updateId,
        binding,
        epoch: this.epoch,
        owner: this.presentations.get(viewId),
      });
    } else this.contexts.delete(viewId);
    for (const listener of this.listeners) listener();
  }

  async removeContext(viewId: string, updateId: string): Promise<void> {
    await (this.presentations.get(viewId) ?? this.bind(viewId)).request(
      McpAppMethod.RemoveModelContext,
      { updateId },
    );
    if (this.contexts.get(viewId)?.updateId === updateId) this.reportContext(viewId, '', null);
  }

  private async clearContext(
    viewId: string,
    binding: McpAppSessionBinding,
    epoch: number,
    owner?: McpAppSessionView,
  ): Promise<void> {
    const context = this.contexts.get(viewId);
    if (
      !context ||
      context.epoch !== epoch ||
      context.owner !== owner ||
      context.binding.client !== binding.client ||
      context.binding.generation !== binding.generation ||
      context.binding.sessionKey !== binding.sessionKey ||
      context.binding.sessionId !== binding.sessionId
    )
      return;
    this.contexts.delete(viewId);
    for (const listener of this.listeners) listener();
    // Cleanup is limited to the known update on its original socket. It must
    // never clear a newer selection or replay through a replacement generation.
    if (binding.client.generation !== binding.generation) return;
    await binding.client.request(
      McpAppMethod.RemoveModelContext,
      {
        sessionKey: binding.sessionKey,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
        viewId: owner?.nativeViewId ?? viewId,
        updateId: context.updateId,
      },
      { timeoutMs: 10_000 },
    );
  }

  private capture(): McpAppSessionBinding {
    const binding = this.getBinding();
    if (!binding?.isCurrent() || binding.client.generation !== binding.generation) {
      throw new Error('MCP App session is unavailable');
    }
    const epoch = this.epoch;
    return { ...binding, isCurrent: () => this.epoch === epoch && binding.isCurrent() };
  }

  bind(viewId?: string): McpAppSessionView {
    const binding = this.capture();
    const epoch = this.epoch;
    return new McpAppSessionView(
      binding,
      viewId,
      view => this.views.add(view),
      view => {
        this.views.delete(view);
        if (viewId && this.presentations.get(viewId) === view) this.presentations.delete(viewId);
      },
      view => (viewId ? this.clearContext(viewId, binding, epoch, view) : Promise.resolve()),
      view => {
        if (!viewId) return;
        this.presentations.set(viewId, view);
        const context = this.contexts.get(viewId);
        if (
          context?.epoch === epoch &&
          context.binding.client === binding.client &&
          context.binding.generation === binding.generation &&
          context.binding.sessionKey === binding.sessionKey &&
          context.binding.sessionId === binding.sessionId
        )
          this.contexts.set(viewId, { ...context, owner: view });
      },
    );
  }

  async discover(signal?: AbortSignal): Promise<McpAppDiscovery> {
    return this.bind().request(McpAppMethod.Discover, {}, signal);
  }

  launch(input: McpAppLaunchInput, signal?: AbortSignal): Promise<unknown> {
    return this.bind().launch(input, signal);
  }
}

export class McpAppSessionView {
  private readonly operations = new Set<AbortController>();
  private disposed = false;
  private loaded = false;
  private closing?: Promise<void>;
  private restoredViewId?: string;
  private historicalSourceViewId?: string;
  private fileServer?: string;
  private fileUri?: string;
  private fileWritable = false;

  fileResource(action: 'read' | 'write', input: Record<string, unknown>, signal?: AbortSignal) {
    if (
      !this.fileServer ||
      input.uri !== this.fileUri ||
      !this.loaded ||
      (action === 'write' && !this.fileWritable)
    )
      throw new Error('App file resource is unavailable');
    return this.dispatch(
      `${MCP_APP_FILE_RESOURCE_METHOD_PREFIX}${this.fileServer}`,
      { ...input, action },
      signal,
      true,
    );
  }

  get canReadHistoricalTool(): boolean {
    return Boolean(this.historicalSourceViewId && this.isCurrent());
  }

  /** Read an authenticated original result; never invoke a live business tool. */
  async readHistoricalTool(
    toolName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.canReadHistoricalTool || signal?.aborted)
      throw new Error('Historical App binding expired');
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    this.operations.add(abort);
    try {
      const result = await this.binding.client.request(
        MCP_APP_HISTORY_TOOL_METHOD,
        {
          sessionKey: this.binding.sessionKey,
          sessionId: this.binding.sessionId,
          agentId: this.binding.agentId,
          viewId: this.historicalSourceViewId,
          toolName,
          arguments: args,
        },
        { signal: combined, timeoutMs: 30_000 },
      );
      if (!this.isCurrent() || combined.aborted)
        throw new Error('Historical App result superseded');
      return result;
    } finally {
      this.operations.delete(abort);
    }
  }

  get nativeViewId(): string | undefined {
    return this.restoredViewId ?? this.viewId;
  }

  constructor(
    private readonly binding: McpAppSessionBinding,
    readonly viewId?: string,
    private readonly retain: (view: McpAppSessionView) => void = () => undefined,
    private readonly forget: (view: McpAppSessionView) => void = () => undefined,
    private readonly clearContext: (view: McpAppSessionView) => Promise<void> = () =>
      Promise.resolve(),
    private readonly present: (view: McpAppSessionView) => void = () => undefined,
  ) {}

  get gatewayUrl(): string {
    return this.binding.client.gatewayUrl;
  }
  get sessionKey(): string {
    return this.binding.sessionKey;
  }

  isCurrent(): boolean {
    return (
      !this.disposed &&
      this.binding.isCurrent() &&
      this.binding.client.generation === this.binding.generation
    );
  }

  async request<T = unknown>(
    method: Method,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (!methods.has(method)) throw new Error('Invalid MCP App method');
    return this.dispatch(method, input, signal);
  }

  async launch(input: McpAppLaunchInput, signal?: AbortSignal): Promise<unknown> {
    if (input.entrypointType === 'file' && /^[a-z0-9_-]{1,128}$/i.test(input.serverName)) {
      if (!this.binding.sessionId) throw new Error('MCP App session identity is required');
      const method = `${MCP_APP_FILE_OPEN_METHOD_PREFIX}${input.serverName}`;
      try {
        return await this.dispatch(method, { ...input }, signal, true);
      } catch (error) {
        // Only the native router's exact non-admission permits a fallback. Unknown
        // completion, denied access and transport failures must never replay work.
        if (
          !this.isCurrent() ||
          signal?.aborted ||
          (error as { gatewayCode?: string }).gatewayCode !== 'INVALID_REQUEST' ||
          !(error instanceof Error) ||
          error.message !== `unknown method: ${method}`
        )
          throw error;
      }
    }
    return this.request(McpAppMethod.Launch, { ...input }, signal);
  }

  private async dispatch<T = unknown>(
    method: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    includeIncarnation = false,
  ): Promise<T> {
    if (!this.isCurrent()) throw new Error('MCP App binding expired');
    const params = { ...input };
    for (const field of scopedFields) delete params[field];
    const scope = {
      sessionKey: this.binding.sessionKey,
      ...(includeIncarnation ? { sessionId: this.binding.sessionId } : {}),
      ...(this.binding.agentId ? { agentId: this.binding.agentId } : {}),
      ...(this.nativeViewId ? { viewId: this.nativeViewId } : {}),
    };
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.retain(this);
    this.operations.add(controller);
    try {
      const result = await this.binding.client.request<T>(
        method,
        { ...params, ...scope },
        {
          signal: combined,
          timeoutMs: method === McpAppMethod.View ? 10_000 : null,
        },
      );
      if (!this.isCurrent() || combined.aborted) throw new Error('MCP App response superseded');
      return result;
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      this.operations.delete(controller);
      if (!this.loaded && this.operations.size === 0) this.forget(this);
    }
  }

  async view(
    signal?: AbortSignal,
    descriptor?: McpAppDescriptor | null,
  ): Promise<McpAppViewPayload> {
    if (!this.viewId) return Promise.reject(new Error('MCP App view identity is required'));
    let result: McpAppViewPayload;
    try {
      result = await this.request<McpAppViewPayload>(McpAppMethod.View, {}, signal);
    } catch (error) {
      if (
        (error as { details?: { code?: string } }).details?.code !== 'MCP_APP_VIEW_EXPIRED' ||
        !this.isCurrent() ||
        signal?.aborted ||
        !this.binding.sessionId ||
        !descriptor ||
        descriptor.viewId !== this.viewId ||
        descriptor.originSessionKey !== this.binding.sessionKey
      )
        throw error;
      // Recovery reads native evidence and mints a fresh native view. It never
      // retries the business tool or accepts Renderer-supplied diagram data.
      const recovery = new AbortController();
      const combined = signal ? AbortSignal.any([signal, recovery.signal]) : recovery.signal;
      this.retain(this);
      this.operations.add(recovery);
      try {
        const restored = await this.binding.client.request<{
          viewId: string;
          payload: McpAppViewPayload;
        }>(
          descriptor.serverName === DRAWIO_SERVER &&
            descriptor.toolName === DRAWIO_TOOL &&
            descriptor.uiResourceUri === DRAWIO_RESOURCE
            ? DRAWIO_RESTORE_METHOD
            : MCP_APP_HISTORY_VIEW_METHOD,
          {
            sessionKey: this.binding.sessionKey,
            sessionId: this.binding.sessionId,
            agentId: this.binding.agentId,
            viewId: this.viewId,
          },
          { signal: combined, timeoutMs: 30_000 },
        );
        if (
          !this.isCurrent() ||
          combined.aborted ||
          !/^mcp-app-[A-Za-z0-9-]{1,100}$/.test(restored.viewId)
        )
          throw new Error('MCP App recovery superseded');
        this.restoredViewId = restored.viewId;
        if (!(
          descriptor.serverName === DRAWIO_SERVER &&
          descriptor.toolName === DRAWIO_TOOL &&
          descriptor.uiResourceUri === DRAWIO_RESOURCE
        ))
          this.historicalSourceViewId = this.viewId;
        result = restored.payload;
      } finally {
        this.operations.delete(recovery);
        if (!this.loaded && this.operations.size === 0) this.forget(this);
      }
    }
    if (!this.isCurrent() || signal?.aborted) throw new Error('MCP App response superseded');
    this.loaded = true;
    this.retain(this);
    this.present(this);
    if (this.historicalSourceViewId)
      return {
        ...result,
        messageSupported: false,
        updateModelContextSupported: false,
        fileResourcesSupported: false,
        openFilesSupported: false,
      };
    const link = (result.hostContext?.['openai/deepLink'] as { url?: string } | undefined)?.url;
    if (
      result.messageSupported === true &&
      descriptor?.viewId === this.viewId &&
      descriptor?.originSessionKey === this.binding.sessionKey &&
      /^[a-z0-9_-]{1,128}$/i.test(descriptor.serverName) &&
      /^\/workspace-file\/[a-f0-9]{64}$/.test(link ?? '')
    ) {
      const method = `${MCP_APP_FILE_RESOURCE_METHOD_PREFIX}${descriptor.serverName}`;
      try {
        const file = await this.dispatch<{ uri: string; name: string; writable: boolean }>(
          method,
          { action: 'describe' },
          signal,
          true,
        );
        if (
          file.uri !== `app-file://${link!.slice('/workspace-file/'.length)}` ||
          typeof file.name !== 'string' ||
          !file.name ||
          file.name.length > 255
        )
          throw new Error('Invalid App file resource');
        this.fileServer = descriptor.serverName;
        this.fileUri = file.uri;
        this.fileWritable = file.writable === true;
        result = { ...result, workspaceFile: file };
      } catch (error) {
        if (
          (error as { gatewayCode?: string }).gatewayCode !== 'INVALID_REQUEST' ||
          !(error instanceof Error) ||
          error.message !== `unknown method: ${method}`
        )
          throw error;
      }
    }
    return result;
  }

  subscribe(listener: (event: GatewayEventFrame) => void): () => void {
    return this.binding.client.subscribeEvents(event => {
      if (!this.isCurrent()) return;
      const payload = event.payload as { viewId?: unknown } | undefined;
      if (payload?.viewId === this.nativeViewId) listener(event);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    for (const operation of this.operations) operation.abort();
    this.forget(this);
    // Native WS has no per-request cancellation or view release. Aborting only
    // ends local waits; already dispatched operations may still complete.
    this.closing = this.clearContext(this);
    return this.closing;
  }

  /** Rebinding/transport loss drops local authority without replaying work. */
  detach(): void {
    for (const operation of this.operations) operation.abort();
    this.disposed = true;
    this.forget(this);
  }
}
