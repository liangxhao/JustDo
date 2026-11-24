import type {
  McpAppAdapter,
  McpAppAdapterRequest,
  McpAppAdapterSource,
  McpAppPreparedCanvas,
} from '@app-plugin/sdk/mcp-app';
import type { McpAppContentReference } from '@shared/plugins/mcpAppReferences';
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
  MCP_APP_HISTORY_TOOL_METHOD,
  MCP_APP_HISTORY_VIEW_METHOD,
} from '../../../../../../plugins/extensions/runtime-services/contracts/mcp-apps';
import { findMcpAppViewAdapter } from '../../pipeline/mcp-app-adapters';
import { readAppReferenceAdapter } from '../../pipeline/native-app-reference';
import { decodeMcpAppLaunch, readNativeMcpAppIdentity } from '../../pipeline/native-mcp-app';
import type { GatewayClient, GatewayEventFrame } from '../client';

export interface McpAppSessionBinding {
  client: GatewayClient;
  generation: number;
  sessionKey: string;
  sessionId: string | null;
  agentId?: string;
  isCurrent: () => boolean;
  /** Original native owner, independent of which conversation is displayed. */
  isOwnerCurrent?: () => boolean;
}

type Method = (typeof McpAppMethod)[keyof typeof McpAppMethod];
const methods = new Set<string>(Object.values(McpAppMethod));
const scopedFields = ['sessionKey', 'sessionId', 'agentId', 'viewId', 'requesterId', 'requestId'];
const canvasSessions = new Set<McpAppSession>();
const VIEW_KEEPALIVE_INTERVAL_MS = 60_000;
const VIEW_KEEPALIVE_BACKOFF_MS = 2 * VIEW_KEEPALIVE_INTERVAL_MS;
const VIEW_KEEPALIVE_BACKOFF_AFTER_FAILURES = 3;
const SEND_PREPARATION_TIMEOUT_MS = 12_000;
type RetainCanvasRun = (runId: string) => (() => void) | void;
type ReadyCanvas = McpAppPreparedCanvas & {
  adapter: McpAppAdapter;
  isCurrent: () => boolean;
  retainRun?: RetainCanvasRun;
};
type SendTarget = Pick<
  McpAppSessionBinding,
  'client' | 'generation' | 'sessionKey' | 'sessionId' | 'agentId' | 'isCurrent'
>;
type CanvasRegistration = {
  adapter: McpAppAdapter;
  identity: Omit<SendTarget, 'isCurrent'>;
  available: () => boolean;
  prepare: (signal: AbortSignal) => Promise<McpAppPreparedCanvas>;
  retainRun?: RetainCanvasRun;
};

export const hasMcpAppCanvasPreparations = (target: SendTarget) =>
  [...canvasSessions].some(apps => apps.matchesCanvasTarget(target));

interface PreparedCanvasSend {
  method: string;
  params: Record<string, unknown>;
  onRequest?: () => void;
  onRejected?: (error: unknown) => void;
}

/** Also covers homepage Apps adopted by a chat through another authenticated socket. */
export async function prepareMcpAppChatSend(
  target: SendTarget,
  send: Record<string, unknown>,
  prepareContext?: (signal: AbortSignal) => Promise<void>,
): Promise<PreparedCanvasSend> {
  const pendingCanvases = [...canvasSessions].flatMap(apps => apps.captureCanvasPreparations(target));
  const canvases: ReadyCanvas[] = [];
  const preparation = new AbortController();
  const deadline = setTimeout(() => preparation.abort(), SEND_PREPARATION_TIMEOUT_MS);
  try {
    if (prepareContext) await prepareContext(preparation.signal);
    for (const prepare of pendingCanvases) {
      canvases.push(await prepare(preparation.signal));
    }
  } catch {
    // A failed snapshot must not block chat or silently select a different canvas.
    canvases.length = 0;
  } finally {
    clearTimeout(deadline);
  }
  if (
    !target.isCurrent() ||
    target.client.generation !== target.generation ||
    send.sessionKey !== target.sessionKey ||
    (send.sessionId ?? null) !== target.sessionId
  )
    throw new Error('Message send context changed during App preparation');
  const adapter = canvases[0]?.adapter;
  if (!adapter || canvases.some(canvas => canvas.adapter !== adapter || !canvas.isCurrent()))
    return { method: 'chat.send', params: send };
  const priority = Math.max(...canvases.map(item => item.priority));
  const releaseRuns: Array<() => void> = [];
  return {
    method: adapter.sendMethod,
    onRequest: () => {
      if (typeof send.idempotencyKey === 'string') {
        for (const canvas of canvases) {
          const release = canvas.retainRun?.(send.idempotencyKey);
          if (release) releaseRuns.push(release);
        }
      }
    },
    onRejected: error => {
      const failure = error as {
        requestSent?: unknown;
        gatewayCode?: unknown;
        message?: unknown;
        details?: { code?: unknown };
      } | undefined;
      // A generic Gateway error can follow an issued native send. Only exact
      // non-admission evidence permits releasing this run's local retention.
      if (
        failure?.requestSent === false ||
        failure?.details?.code === adapter.sendNotIssuedCode ||
        (failure?.gatewayCode === 'INVALID_REQUEST' &&
          failure.message === `unknown method: ${adapter.sendMethod}`)
      )
        releaseRuns.splice(0).forEach(release => release());
    },
    params: {
      ...adapter.sendParams(
        send,
        canvases.map(({ viewId, token, priority: value }) => ({
          viewId,
          token,
          selected: priority > 0 && value === priority,
        })),
      ),
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      agentId: target.agentId,
    },
  };
}

/** The chat connection owns this adapter. Features never receive its credentials. */
export class McpAppSession {
  private readonly canvasPreparations = new Map<string, CanvasRegistration>();
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
  private iconRevision = 0;
  private discoveredIcons?: { value: McpAppDiscovery; isCurrent: () => boolean };
  constructor(private readonly getBinding: () => McpAppSessionBinding | undefined) {}

  /** The existing discovery read supplies presentation only, never App authority. */
  get iconCatalog(): McpAppDiscovery | undefined {
    return this.discoveredIcons?.isCurrent() ? this.discoveredIcons.value : undefined;
  }

  get agentId(): string | undefined {
    return this.getBinding()?.agentId;
  }

  registerCanvasPreparation(
    adapter: McpAppAdapter,
    viewId: string,
    prepare: CanvasRegistration['prepare'],
    available: () => boolean,
    retainRun?: RetainCanvasRun,
  ) {
    const { client, generation, sessionKey, sessionId, agentId } = this.capture();
    const registration = {
      adapter,
      identity: { client, generation, sessionKey, sessionId, agentId },
      prepare,
      available,
      retainRun,
    };
    this.canvasPreparations.set(viewId, registration);
    canvasSessions.add(this);
    return () => {
      if (this.canvasPreparations.get(viewId) === registration)
        this.canvasPreparations.delete(viewId);
      if (!this.canvasPreparations.size) canvasSessions.delete(this);
    };
  }

  matchesCanvasTarget(target: SendTarget) {
    return [...this.canvasPreparations.values()].some(item => this.matchesCanvas(item, target));
  }

  private matchesCanvas(item: CanvasRegistration, target: SendTarget) {
    const binding = item.identity;
    return Boolean(
      target.isCurrent() &&
      item.available() &&
      binding.client.generation === binding.generation &&
      binding.sessionKey === target.sessionKey &&
      binding.sessionId === target.sessionId &&
      binding.agentId === target.agentId &&
      binding.client.gatewayUrl === target.client.gatewayUrl,
    );
  }

  get hasCanvasPreparations() {
    const binding = this.getBinding();
    return Boolean(binding?.isCurrent() && hasMcpAppCanvasPreparations(binding));
  }

  captureCanvasPreparations(target: SendTarget): Array<(signal: AbortSignal) => Promise<ReadyCanvas>> {
    return [...this.canvasPreparations]
      .filter(([, item]) => this.matchesCanvas(item, target))
      .map(([viewId, item]) => async signal => {
        const isCurrent = () =>
          this.canvasPreparations.get(viewId) === item && this.matchesCanvas(item, target);
        signal.throwIfAborted();
        if (!isCurrent()) throw new Error('MCP App binding changed during preparation');
        const canvas = await item.prepare(signal);
        signal.throwIfAborted();
        if (!isCurrent()) throw new Error('MCP App binding changed during preparation');
        return { ...canvas, adapter: item.adapter, isCurrent, retainRun: item.retainRun };
      });
  }

  async prepareChatSend(send: Record<string, unknown>): Promise<PreparedCanvasSend> {
    const binding = this.getBinding();
    if (!binding?.isCurrent()) return { method: 'chat.send', params: send };
    return prepareMcpAppChatSend(binding, send);
  }

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
    this.iconRevision++;
    this.discoveredIcons = undefined;
    this.bindingRevision++;
    for (const listener of this.listeners) listener();
  }

  invalidate(preservePresentations = false): void {
    this.epoch++;
    this.iconRevision++;
    this.discoveredIcons = undefined;
    this.bindingRevision++;
    for (const view of [...this.views]) {
      if (preservePresentations && view.suspend()) continue;
      void view.close().catch(() => undefined);
    }
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
    const scope = { binding, epoch: this.epoch };
    return new McpAppSessionView(
      binding,
      viewId,
      view => this.views.add(view),
      view => {
        this.views.delete(view);
        if (viewId && this.presentations.get(viewId) === view) this.presentations.delete(viewId);
      },
      view =>
        viewId ? this.clearContext(viewId, scope.binding, scope.epoch, view) : Promise.resolve(),
      view => {
        if (!viewId) return;
        this.presentations.set(viewId, view);
        const context = this.contexts.get(viewId);
        if (
          context?.epoch === scope.epoch &&
          context.binding.client === scope.binding.client &&
          context.binding.generation === scope.binding.generation &&
          context.binding.sessionKey === scope.binding.sessionKey &&
          context.binding.sessionId === scope.binding.sessionId
        )
          this.contexts.set(viewId, { ...context, owner: view });
      },
      next => {
        scope.binding = next;
        scope.epoch = this.epoch;
      },
      () => {
        for (const listener of this.listeners) listener();
      },
    );
  }

  resume(view: McpAppSessionView): boolean {
    if (!this.views.has(view) || !this.ready) return false;
    return view.resumeBinding(this.capture());
  }

  async discover(signal?: AbortSignal): Promise<McpAppDiscovery> {
    const revision = ++this.iconRevision;
    this.discoveredIcons = undefined;
    for (const listener of this.listeners) listener();
    const binding = this.bind();
    const value = await binding.request<McpAppDiscovery>(McpAppMethod.Discover, {}, signal);
    if (revision === this.iconRevision && binding.isCurrent() && !signal?.aborted) {
      this.discoveredIcons = { value, isCurrent: () => binding.isCurrent() };
      for (const listener of this.listeners) listener();
    }
    return value;
  }

  launch(input: McpAppLaunchInput, signal?: AbortSignal): Promise<unknown> {
    return this.bind().launch(input, signal);
  }
}

/** The native lease expired and an authenticated read-only recovery did not obtain a view. */
export class McpAppViewRecoveryUnavailable extends Error {}

export class McpAppSessionView {
  private readonly operations = new Set<AbortController>();
  private readonly retainedOperations = new Set<AbortController>();
  private readonly suspensionListeners = new Set<() => void>();
  private disposed = false;
  private loaded = false;
  private closing?: Promise<void>;
  private restoredViewId?: string;
  private historicalSourceViewId?: string;
  private fileServer?: string;
  private fileUri?: string;
  private fileWritable = false;
  private releaseAdapterSource?: () => Promise<unknown>;
  private attachedAdapter?: Readonly<{ adapter: McpAppAdapter; source: Readonly<McpAppAdapterSource> }>;
  preservePresentation = false;
  suspended = false;
  private revision = 0;
  private retainedRevision = 0;
  private readonly preparedRuns = new Set<string>();
  private stopPreparedRuns?: () => void;
  private keepAliveTimer?: ReturnType<typeof setTimeout>;
  private keepAliveRequest?: AbortController;
  private keepAliveFailures = 0;
  private keepAliveStopped = false;

  private canKeepAlive(): boolean {
    return Boolean(
      this.loaded &&
      !this.disposed &&
      this.nativeViewId &&
      this.binding.client.generation === this.binding.generation &&
      (this.isCurrent() || (this.preservePresentation && this.binding.isOwnerCurrent?.())),
    );
  }

  private scheduleKeepAlive(): void {
    if (
      this.keepAliveTimer !== undefined || this.keepAliveRequest ||
      this.keepAliveStopped || !this.canKeepAlive()
    ) return;
    const delay = this.keepAliveFailures >= VIEW_KEEPALIVE_BACKOFF_AFTER_FAILURES
      ? VIEW_KEEPALIVE_BACKOFF_MS
      : VIEW_KEEPALIVE_INTERVAL_MS;
    this.keepAliveTimer = setTimeout(() => {
      this.keepAliveTimer = undefined;
      void this.keepAlive();
    }, delay);
  }

  private async keepAlive(): Promise<void> {
    if (!this.canKeepAlive()) return;
    const binding = this.binding;
    const viewId = this.nativeViewId!;
    const controller = new AbortController();
    this.keepAliveRequest = controller;
    try {
      // Presence alone retains the original lease. No App tool, context update,
      // launch or HTML reload is allowed here, including while a tab is paused.
      const lease = await binding.client.request<{ viewId: string; expiresAtMs: number }>(
        McpAppMethod.View,
        {
          sessionKey: binding.sessionKey,
          sessionId: binding.sessionId,
          agentId: binding.agentId,
          viewId,
          keepAlive: true,
        },
        { signal: controller.signal, timeoutMs: 10_000 },
      );
      if (this.binding !== binding || this.nativeViewId !== viewId || controller.signal.aborted)
        return;
      // An older/unmatched runtime must not cause repeated full HTML reads.
      if (lease?.viewId === viewId && Number.isFinite(lease.expiresAtMs))
        this.keepAliveFailures = 0;
      else this.keepAliveStopped = true;
    } catch (error) {
      if (this.binding !== binding || this.nativeViewId !== viewId || controller.signal.aborted)
        return;
      const failure = error as { gatewayCode?: string; details?: { code?: string } };
      if (
        failure?.details?.code === 'MCP_APP_VIEW_EXPIRED' ||
        failure?.gatewayCode === 'FORBIDDEN' ||
        failure?.gatewayCode === 'INVALID_REQUEST'
      )
        this.keepAliveStopped = true;
      else if (this.keepAliveFailures < VIEW_KEEPALIVE_BACKOFF_AFTER_FAILURES)
        this.keepAliveFailures++;
    } finally {
      if (this.keepAliveRequest === controller) {
        this.keepAliveRequest = undefined;
        this.scheduleKeepAlive();
      }
    }
  }

  private stopKeepAlive(): void {
    clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    this.keepAliveRequest?.abort();
    this.keepAliveRequest = undefined;
  }

  get hasPendingPreparedRun(): boolean {
    return this.preparedRuns.size > 0;
  }

  /** Retention metadata only; the plugin alone authorizes the actual prepared send. */
  retainPreparedRun(runId: string): (() => void) | void {
    if (!this.isCurrent() || !runId) return;
    this.preparedRuns.add(runId);
    if (!this.stopPreparedRuns) {
      const binding = this.binding;
      this.stopPreparedRuns = binding.client.subscribeEvents(event => {
        const payload = event.payload as {
          sessionKey?: unknown;
          sessionId?: unknown;
          runId?: unknown;
          stream?: unknown;
          data?: { phase?: unknown; executionSettled?: unknown };
        } | undefined;
        if (
          !this.isRetainedEditorCurrent() ||
          event.event !== 'agent' ||
          payload?.sessionKey !== binding.sessionKey ||
          payload?.sessionId !== binding.sessionId ||
          typeof payload?.runId !== 'string' ||
          !this.preparedRuns.has(payload.runId) ||
          payload.stream !== 'lifecycle' ||
          payload.data?.executionSettled !== true ||
          (payload.data.phase !== 'end' && payload.data.phase !== 'error')
        )
          return;
        this.releasePreparedRun(payload.runId);
      });
    }
    this.changed();
    return () => this.releasePreparedRun(runId);
  }

  private releasePreparedRun(runId: string): void {
    if (!this.preparedRuns.delete(runId)) return;
    if (!this.preparedRuns.size) {
      this.stopPreparedRuns?.();
      this.stopPreparedRuns = undefined;
    }
    this.changed();
  }

  private async releaseViewSource(
    binding: McpAppSessionBinding,
    viewId: string | undefined,
    method: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (binding.client.generation !== binding.generation || !binding.sessionId) return;
    const params = { ...input };
    for (const field of scopedFields) delete params[field];
    return binding.client.request(
      method,
      {
        ...params,
        sessionKey: binding.sessionKey,
        sessionId: binding.sessionId,
        agentId: binding.agentId,
        viewId,
      },
      { timeoutMs: 5000 },
    );
  }

  get contentAdapter() {
    return this.attachedAdapter;
  }

  editorTransport(adapter: McpAppAdapter) {
    const assertMethod = (method: string) => {
      if (this.contentAdapter?.adapter !== adapter || !adapter.viewMethods.includes(method))
        throw new Error('MCP App adapter binding expired or method unavailable');
    };
    const request: McpAppAdapterRequest = async (method, input, signal) => {
      assertMethod(method);
      return this.dispatch(method, input, signal, true);
    };
    const retainedRequest: McpAppAdapterRequest = async (method, input, signal) => {
      assertMethod(method);
      return this.dispatch(method, input, signal, true, true);
    };
    const release = async (method: string, input: Record<string, unknown>) => {
      assertMethod(method);
      return this.releaseViewSource(this.binding, this.nativeViewId, method, input);
    };
    const releaseOnClose = (method: string, input: Record<string, unknown>) => {
      assertMethod(method);
      if (!this.isCurrent()) throw new Error('MCP App adapter binding expired');
      const binding = this.binding;
      const viewId = this.nativeViewId;
      let release: Promise<unknown> | undefined;
      // Close and detach share this exact cleanup receipt, including an unconfirmed result.
      this.releaseAdapterSource = () =>
        (release ??= this.releaseViewSource(binding, viewId, method, input));
    };
    return { request, retainedRequest, release, releaseOnClose };
  }

  get sessionId() {
    return this.binding.sessionId;
  }

  get agentId() {
    return this.binding.agentId;
  }

  /** Compare authority, excluding the local pause epoch. Does not authorize a call. */
  sameNativeIdentity(other: McpAppSessionView): boolean {
    const a = this.binding;
    const b = other.binding;
    return (
      a.client === b.client &&
      a.generation === b.generation &&
      a.sessionKey === b.sessionKey &&
      a.sessionId === b.sessionId &&
      a.agentId === b.agentId
    );
  }

  onSuspend(listener: () => void) {
    this.suspensionListeners.add(listener);
    return () => {
      this.suspensionListeners.delete(listener);
    };
  }

  restoreContentReference(reference: McpAppContentReference) {
    const adapter = readAppReferenceAdapter(reference);
    const { content } = reference;
    if (
      !adapter ||
      content.originViewId !== this.viewId ||
      content.sessionKey !== this.binding.sessionKey ||
      content.sessionId !== this.binding.sessionId ||
      content.agentId !== this.binding.agentId
    )
      throw new Error('App reference source changed');
    return this.dispatch(
      adapter.restoreMethod,
      adapter.restoreReferenceParams(content.contentId, reference.operationId),
      undefined,
      true,
    );
  }

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
    const binding = this.binding;
    const revision = this.revision;
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
      if (
        !this.isCurrent() ||
        this.binding !== binding ||
        this.revision !== revision ||
        combined.aborted
      )
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
    private binding: McpAppSessionBinding,
    readonly viewId?: string,
    private readonly retain: (view: McpAppSessionView) => void = () => undefined,
    private readonly forget: (view: McpAppSessionView) => void = () => undefined,
    private readonly clearContext: (view: McpAppSessionView) => Promise<void> = () =>
      Promise.resolve(),
    private readonly present: (view: McpAppSessionView) => void = () => undefined,
    private readonly rebound: (binding: McpAppSessionBinding) => void = () => undefined,
    private readonly changed: () => void = () => undefined,
  ) {}

  suspend(): boolean {
    if (this.disposed || !this.loaded || !this.preservePresentation) return false;
    this.suspended = true;
    this.revision++;
    for (const listener of this.suspensionListeners) listener();
    for (const operation of this.operations) operation.abort();
    return true;
  }

  resumeBinding(binding: McpAppSessionBinding): boolean {
    const previous = this.binding;
    if (
      this.disposed ||
      !this.suspended ||
      previous.client !== binding.client ||
      previous.generation !== binding.generation ||
      previous.sessionKey !== binding.sessionKey ||
      previous.sessionId !== binding.sessionId ||
      previous.agentId !== binding.agentId ||
      !binding.isCurrent()
    )
      return false;
    this.binding = binding;
    this.rebound(binding);
    this.suspended = false;
    this.revision++;
    this.present(this);
    this.keepAliveFailures = 0;
    this.scheduleKeepAlive();
    return true;
  }

  get gatewayUrl(): string {
    return this.binding.client.gatewayUrl;
  }
  get sessionKey(): string {
    return this.binding.sessionKey;
  }

  isCurrent(): boolean {
    return (
      !this.disposed &&
      !this.suspended &&
      this.binding.isCurrent() &&
      this.binding.client.generation === this.binding.generation
    );
  }

  /** Only the trusted canvas adapter may finish work already bound to this editor. */
  isRetainedEditorCurrent(): boolean {
    return (
      this.isCurrent() ||
      Boolean(
        !this.disposed &&
          this.suspended &&
          this.preservePresentation &&
          this.binding.client.generation === this.binding.generation &&
          this.binding.isOwnerCurrent?.(),
      )
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
    const launched = await this.request(McpAppMethod.Launch, { ...input }, signal);
    if (
      input.entrypointType === 'file' &&
      readNativeMcpAppIdentity(decodeMcpAppLaunch(launched))?.toolName !== input.toolName
    ) throw new Error('MCP App launch did not match the selected file tool');
    return launched;
  }

  private async dispatch<T = unknown>(
    method: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    includeIncarnation = false,
    retainedOperation = false,
  ): Promise<T> {
    const isCurrent = () => (retainedOperation ? this.isRetainedEditorCurrent() : this.isCurrent());
    if (!isCurrent()) throw new Error('MCP App binding expired');
    const binding = this.binding;
    const revision = retainedOperation ? this.retainedRevision : this.revision;
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
    const operations = retainedOperation ? this.retainedOperations : this.operations;
    operations.add(controller);
    try {
      const result = await this.binding.client.request<T>(
        method,
        { ...params, ...scope },
        {
          signal: combined,
          timeoutMs: method === McpAppMethod.View ? 10_000 : null,
        },
      );
      if (
        !isCurrent() ||
        (retainedOperation
          ? this.retainedRevision !== revision
          : this.binding !== binding || this.revision !== revision) ||
        combined.aborted
      )
        throw new Error('MCP App response superseded');
      return result;
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      operations.delete(controller);
      if (!this.loaded && this.operations.size === 0 && this.retainedOperations.size === 0)
        this.forget(this);
    }
  }

  async view(
    signal?: AbortSignal,
    descriptor?: McpAppDescriptor | null,
  ): Promise<McpAppViewPayload> {
    if (!this.viewId) return Promise.reject(new Error('MCP App view identity is required'));
    const binding = this.binding;
    const revision = this.revision;
    const adapter = descriptor?.viewId === this.viewId &&
      descriptor.originSessionKey === binding.sessionKey && binding.sessionId && binding.agentId
      ? findMcpAppViewAdapter(descriptor) : undefined;
    let result: McpAppViewPayload;
    try {
      result = await this.request<McpAppViewPayload>(McpAppMethod.View, {}, signal);
    } catch (error) {
      if (
        (error as { details?: { code?: string } }).details?.code !== 'MCP_APP_VIEW_EXPIRED' ||
        !this.isCurrent() ||
        this.binding !== binding ||
        this.revision !== revision ||
        signal?.aborted ||
        !this.binding.sessionId ||
        !descriptor ||
        descriptor.viewId !== this.viewId ||
        descriptor.originSessionKey !== this.binding.sessionKey
      )
        throw error;
      // Recovery reads native evidence and mints a fresh native view. It never
      // retries the business tool or accepts Renderer-supplied content.
      const recovery = new AbortController();
      const combined = signal ? AbortSignal.any([signal, recovery.signal]) : recovery.signal;
      this.retain(this);
      this.operations.add(recovery);
      try {
        const restored = await this.binding.client.request<{
          viewId: string;
          payload: McpAppViewPayload;
        }>(
          adapter?.restoreMethod ?? MCP_APP_HISTORY_VIEW_METHOD,
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
          this.binding !== binding ||
          this.revision !== revision ||
          combined.aborted ||
          !/^mcp-app-[A-Za-z0-9-]{1,100}$/.test(restored.viewId)
        )
          throw new Error('MCP App recovery superseded');
        this.restoredViewId = restored.viewId;
        if (!adapter) this.historicalSourceViewId = this.viewId;
        result = restored.payload;
      } catch (error) {
        if (this.isCurrent() && this.binding === binding && this.revision === revision && !combined.aborted)
          throw new McpAppViewRecoveryUnavailable('MCP App view expired');
        throw error;
      } finally {
        this.operations.delete(recovery);
        if (!this.loaded && this.operations.size === 0) this.forget(this);
      }
    }
    if (
      !this.isCurrent() ||
      this.binding !== binding ||
      this.revision !== revision ||
      signal?.aborted
    )
      throw new Error('MCP App response superseded');
    this.loaded = true;
    this.retain(this);
    this.present(this);
    this.keepAliveFailures = 0;
    this.keepAliveStopped = false;
    this.scheduleKeepAlive();
    if (adapter && descriptor) {
      const source = Object.freeze({
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        uiResourceUri: descriptor.uiResourceUri,
        originSessionKey: binding.sessionKey,
      });
      this.attachedAdapter = Object.freeze({ adapter, source });
      const transport = this.editorTransport(adapter);
      result = await adapter.prepareView({
        source,
        payload: result,
        request: (method, input) => transport.request(method, input, signal),
        releaseOnClose: transport.releaseOnClose,
      });
      if (!this.isCurrent() || this.binding !== binding || this.revision !== revision || signal?.aborted)
        throw new Error('MCP App response superseded');
    }
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
    return this.subscribeView(listener, false);
  }

  subscribeRetainedEditor(listener: (event: GatewayEventFrame) => void): () => void {
    return this.subscribeView(listener, true);
  }

  private subscribeView(listener: (event: GatewayEventFrame) => void, retained: boolean) {
    return this.binding.client.subscribeEvents(event => {
      if (!(retained ? this.isRetainedEditorCurrent() : this.isCurrent())) return;
      const payload = event.payload as { viewId?: unknown } | undefined;
      if (payload?.viewId === this.nativeViewId) listener(event);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.suspended = false;
    this.stopKeepAlive();
    this.revision++;
    this.retainedRevision++;
    this.stopPreparedRuns?.();
    this.stopPreparedRuns = undefined;
    this.preparedRuns.clear();
    this.suspensionListeners.clear();
    for (const operation of this.operations) operation.abort();
    for (const operation of this.retainedOperations) operation.abort();
    this.forget(this);
    // Native WS has no per-request cancellation or view release. Aborting only
    // ends local waits; already dispatched operations may still complete.
    this.closing = Promise.all([
      this.clearContext(this),
      this.releaseAdapterSource?.(),
    ]).then(() => undefined);
    return this.closing;
  }

  /** Rebinding/transport loss drops local authority without replaying work. */
  detach(): void {
    void this.releaseAdapterSource?.().catch(() => undefined);
    for (const operation of this.operations) operation.abort();
    for (const operation of this.retainedOperations) operation.abort();
    this.disposed = true;
    this.suspended = false;
    this.stopKeepAlive();
    this.revision++;
    this.retainedRevision++;
    this.stopPreparedRuns?.();
    this.stopPreparedRuns = undefined;
    this.preparedRuns.clear();
    this.suspensionListeners.clear();
    this.forget(this);
  }
}
