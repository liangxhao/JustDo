import type { WidgetNetworkBridge, WidgetNetworkInstance } from '@shared/widgets/network';

import {
  boardReferenceIsRealtime,
  isNativeBoardWidgetReference,
  nativeBoardReferenceOrder,
  type NativeBoardWidgetReference,
} from '../../pipeline/native-board';
import type { NativeWidgetContext } from '../native-widget/host';
import {
  type BoardRead,
  boardScope,
  gatewayOrigin,
  networkBinding,
  readBoardHtml,
  readCurrentBoard,
  record,
  refreshHtmlResources,
  sameBoardIdentity,
} from './loader';

export type BoardWidgetStatus =
  'idle' | 'loading' | 'pending' | 'rejected' | 'missing' | 'failed' | 'stopped' | 'running';
export type PreparedBoardView = { html: string; url: string; network?: WidgetNetworkInstance };
export type BoardWidgetState = {
  status: BoardWidgetStatus;
  origins: readonly string[];
};
const started = new WeakMap<object, Set<string>>();
const executions = new WeakMap<object, Set<string>>();

function withinRound<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native check timed out')), 15_000);
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Runtime memory only; an anchor remount cannot replay a previously admitted result. */
function claimLive(reference: NativeBoardWidgetReference, context: NativeWidgetContext): boolean {
  if (
    !context.sessionId ||
    !boardReferenceIsRealtime(reference, { ...context, sessionId: context.sessionId })
  )
    return false;
  const owner = context.boardExecutionOwner ?? context.client;
  let claims = started.get(owner);
  if (!claims) {
    claims = new Set();
    started.set(owner, claims);
  }
  const key = JSON.stringify([
    context.generation,
    context.sessionKey,
    context.sessionId,
    reference.name,
    reference.toolCallId,
  ]);
  if (claims.has(key)) return false;
  claims.add(key);
  return true;
}

/** This controller never exports the board frame URL or ticket to its generated document. */
export class NativeBoardWidgetController {
  state: BoardWidgetState = { status: 'idle', origins: [] };
  private active = true;
  private operation = 0;
  private read?: BoardRead;
  private network?: WidgetNetworkInstance;
  private abort?: AbortController;
  private renewal?: ReturnType<typeof setInterval>;
  private busyRenewal = false;
  private grantRequest?: object;
  private unsubscribe?: () => void;
  private unsubscribeRevoke?: () => void;
  private readonly mountId = crypto.randomUUID();
  private latestOrder = 0;
  private incoming?: NativeBoardWidgetReference;
  private accepting = false;

  constructor(
    readonly reference: NativeBoardWidgetReference,
    private readonly context: NativeWidgetContext,
    private readonly hostOrigin: string,
    private readonly isCurrent: () => boolean,
    private readonly publish: (state: BoardWidgetState, view?: PreparedBoardView) => void,
    private readonly destroyGuest: () => void,
    private readonly bridge: WidgetNetworkBridge | undefined = window.electron?.widgetNetwork,
  ) {
    if (!isNativeBoardWidgetReference(reference)) throw new Error('Unadmitted native board');
    this.latestOrder = nativeBoardReferenceOrder(reference);
    this.unsubscribe = context.client.subscribeEvents?.(event => {
      if (event.event !== 'board.changed' || !this.current()) return;
      const payload = record(event.payload);
      // Native board.changed carries the stored key, whereas snapshots project the observer scope.
      if (
        !payload ||
        (payload.sessionKey !== context.sessionKey && payload.sessionKey !== boardScope(context)) ||
        (payload.widget !== undefined && payload.widget !== reference.name)
      )
        return;
      void this.boardChanged(payload.widget === undefined);
    });
    this.unsubscribeRevoke = bridge?.onRevoked(event => {
      if (event.mountId === this.mountId && event.instanceId === this.network?.instanceId)
        this.stop();
    });
    void this.inspect(claimLive(reference, context));
  }

  private current(): boolean {
    return (
      this.active &&
      this.isCurrent() &&
      this.context.isCurrent() &&
      this.context.client.generation === this.context.generation
    );
  }
  private async boardChanged(wholeBoard: boolean): Promise<void> {
    const operation = this.operation;
    if (
      wholeBoard &&
      this.read &&
      (this.state.status === 'running' || (this.state.status === 'loading' && this.abort))
    ) {
      try {
        const read = await this.check();
        if (!this.current() || operation !== this.operation) return;
        if (sameBoardIdentity(this.read, read)) return;
      } catch {
        if (!this.current() || operation !== this.operation) return;
      }
    }
    this.stop(false);
    await this.inspect(false);
  }
  private update(status: BoardWidgetStatus, view?: PreparedBoardView): void {
    if (!this.active) return;
    this.state = {
      status,
      origins: this.read?.widget?.netOrigins ?? [],
    };
    this.publish(this.state, view);
    if (status !== 'loading' && this.incoming) queueMicrotask(() => void this.acceptIncoming());
  }

  receiveReference(reference: NativeBoardWidgetReference): boolean {
    if (
      !this.current() ||
      reference.name !== this.reference.name ||
      !this.context.sessionId ||
      !boardReferenceIsRealtime(reference, {
        ...this.context,
        sessionId: this.context.sessionId,
      }) ||
      nativeBoardReferenceOrder(reference) <= this.latestOrder
    )
      return false;
    this.latestOrder = nativeBoardReferenceOrder(reference);
    this.incoming = reference;
    void this.acceptIncoming();
    return true;
  }

  private async acceptIncoming(): Promise<void> {
    if (this.accepting || !this.incoming || this.state.status === 'loading' || !this.current())
      return;
    const reference = this.incoming;
    this.incoming = undefined;
    if (!claimLive(reference, this.context)) return;
    this.accepting = true;
    const operation = this.operation;
    try {
      const read = await this.check();
      if (!this.current() || operation !== this.operation) return;
      if (this.read && sameBoardIdentity(this.read, read) && this.state.status === 'running')
        return;
      this.stop();
      this.read = read;
      const grant = read.widget?.grantState;
      this.update(
        !read.widget ? 'missing' : grant === 'pending' || grant === 'rejected' ? grant : 'idle',
      );
      if (read.widget && (grant === 'none' || grant === 'granted')) await this.start(false);
    } catch {
      if (this.current() && operation === this.operation) {
        this.stop();
        this.update('failed');
      }
    } finally {
      this.accepting = false;
      if (this.incoming) void this.acceptIncoming();
    }
  }
  private async check(): Promise<BoardRead> {
    return withinRound(
      readCurrentBoard(
        this.context,
        this.reference.name,
        this.hostOrigin,
        () => this.current(),
        this.read?.lifecycleRevision,
      ),
    );
  }
  private async inspect(
    auto: boolean,
    expected?: { instanceId: string; revision: number },
  ): Promise<void> {
    const operation = ++this.operation;
    this.update('loading');
    const timer = setTimeout(() => {
      if (this.operation === operation) {
        this.operation++;
        this.update('failed');
      }
    }, 15_000);
    try {
      const read = await this.check();
      if (!this.current() || operation !== this.operation) return;
      this.read = read;
      const grant = read.widget?.grantState;
      this.update(
        !read.widget ? 'missing' : grant === 'pending' || grant === 'rejected' ? grant : 'idle',
      );
      if (
        auto &&
        read.widget &&
        (!expected ||
          (read.widget.instanceId === expected.instanceId &&
            read.widget.revision === expected.revision)) &&
        (grant === 'none' || grant === 'granted')
      )
        void this.start(false);
    } catch {
      if (this.current() && operation === this.operation) this.update('failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async grant(decision: 'granted' | 'rejected'): Promise<void> {
    const read = this.read;
    const widget = read?.widget;
    if (
      !this.current() ||
      !widget ||
      widget.grantState !== 'pending' ||
      this.state.status !== 'pending'
    )
      return;
    ++this.operation;
    const request = {};
    this.grantRequest = request;
    this.update('loading');
    try {
      // Revalidate the pending incarnation before its native instance/revision CAS.
      // The eventual reply still cannot replace the fresh executable readback.
      await withinRound(
        (async () => {
          const fresh = await this.check();
          if (
            !this.current() ||
            this.grantRequest !== request ||
            fresh.widget?.grantState !== 'pending' ||
            fresh.widget.instanceId !== widget.instanceId ||
            fresh.widget.revision !== widget.revision
          )
            throw new Error('Native pending widget changed');
          await this.context.client.request('board.widget.grant', {
            sessionKey: this.context.sessionKey,
            agentId: this.context.agentId,
            name: widget.name,
            revision: widget.revision,
            instanceId: widget.instanceId,
            decision,
          });
        })(),
      );
      if (!this.current() || this.grantRequest !== request) return;
      this.grantRequest = undefined;
      await this.inspect(decision === 'granted', widget);
    } catch {
      if (this.current() && this.grantRequest === request) {
        this.grantRequest = undefined;
        this.operation++;
        this.update('failed');
      }
    }
  }

  async start(manual = true): Promise<void> {
    if (
      !this.current() ||
      this.state.status === 'loading' ||
      this.state.status === 'running' ||
      this.state.status === 'pending' ||
      this.state.status === 'rejected' ||
      this.state.status === 'missing'
    )
      return;
    const operation = ++this.operation;
    if (manual && (this.state.status === 'stopped' || this.state.status === 'failed'))
      this.read = undefined;
    this.release();
    this.update('loading');
    this.abort = new AbortController();
    const abort = this.abort;
    let created: WidgetNetworkInstance | undefined;
    const timer = setTimeout(() => {
      abort.abort();
      if (operation === this.operation) {
        this.operation++;
        this.release();
        this.update('failed');
      }
    }, 30_000);
    try {
      const roundStarted = performance.now();
      const { check, resourceUrls, initialRead } = await withinRound(
        (async () => {
          const check = this.bridge
            ? await this.bridge.beginCheck({ mountId: this.mountId })
            : undefined;
          let resourceUrls = this.read?.widget?.registered
            ? await refreshHtmlResources(this.context)
            : [];
          let initialRead = await this.check();
          if (initialRead.widget?.registered && !resourceUrls.length) {
            resourceUrls = await refreshHtmlResources(this.context);
            initialRead = await this.check();
          }
          return { check, resourceUrls, initialRead };
        })(),
      );
      let read = initialRead;
      if (!this.current() || operation !== this.operation) return;
      this.read = read;
      const widget = read.widget;
      if (!widget || (widget.grantState !== 'none' && widget.grantState !== 'granted')) {
        this.update(!widget ? 'missing' : widget.grantState === 'pending' ? 'pending' : 'rejected');
        return;
      }
      if (performance.now() - roundStarted > 15_000) throw new Error('Native check timed out');
      if (!widget.frameUrl || !widget.sandboxUrl || !widget.viewGeneration)
        throw new Error('Native document unavailable');
      const owner = this.context.boardExecutionOwner ?? this.context.client;
      let seen = executions.get(owner);
      if (!seen) {
        seen = new Set();
        executions.set(owner, seen);
      }
      const execution = JSON.stringify([
        this.context.generation,
        this.context.sessionKey,
        this.context.sessionId,
        read.lifecycleRevision,
        widget.name,
        widget.instanceId,
        widget.revision,
        widget.viewGeneration,
        widget.netOrigins,
      ]);
      if (!manual && seen.has(execution)) {
        this.update('idle');
        return;
      }
      seen.add(execution);
      const networked = widget.netOrigins.length > 0;
      if (networked) {
        if (!this.bridge || !check) throw new Error('Network viewer unavailable');
        created = await this.bridge.create({
          mountId: this.mountId,
          nonce: check.nonce,
          binding: networkBinding(this.context, read),
          gatewayOrigin: gatewayOrigin(this.context),
          sandboxUrl: widget.sandboxUrl!,
          resourceUrls,
        });
        if (!this.current() || operation !== this.operation) return;
        this.network = created;
        created = undefined;
      }
      // The lease is installed before any generated HTML can reach a viewer.
      const fetchHtml = async () => readBoardHtml(read.widget!.frameUrl!, abort.signal);
      let html: string;
      try {
        html = await fetchHtml();
      } catch (error) {
        if ((error as { status?: number }).status !== 401 || abort.signal.aborted) throw error;
        const refreshed = await this.check();
        if (!sameBoardIdentity(read, refreshed)) throw new Error('Native document changed');
        read = refreshed;
        html = await fetchHtml();
      }
      if (!this.current() || operation !== this.operation || abort.signal.aborted) return;
      this.read = read;
      this.update('running', { html, url: read.widget!.sandboxUrl!, network: this.network });
      // HTML transport may consume most of the first lease. Keep the first
      // renewal anchored to its verification round, rather than HTML completion.
      this.renewal = setTimeout(
        () => {
          if (!this.current() || operation !== this.operation) return;
          void this.renew();
          this.renewal = setInterval(() => void this.renew(), 30_000);
        },
        Math.max(0, 30_000 - (performance.now() - roundStarted)),
      );
    } catch {
      if (this.current() && operation === this.operation) {
        this.release();
        this.update('failed');
      }
    } finally {
      clearTimeout(timer);
      if (created) void this.bridge?.close(created).catch(() => undefined);
    }
  }

  private async renew(): Promise<void> {
    if (!this.current()) {
      this.stop();
      return;
    }
    if (!this.read || this.state.status !== 'running' || this.busyRenewal) return;
    this.busyRenewal = true;
    const operation = this.operation;
    const network = this.network;
    const startedAt = performance.now();
    try {
      const { check, read } = await withinRound(
        (async () => ({
          check: network && (await this.bridge!.beginCheck(network)),
          read: await this.check(),
        }))(),
      );
      if (!this.current() || operation !== this.operation) return;
      if (performance.now() - startedAt > 15_000 || !sameBoardIdentity(this.read, read)) {
        this.stop();
        return;
      }
      if (network && check)
        await this.bridge!.renew({
          ...network,
          nonce: check.nonce,
          binding: networkBinding(this.context, read),
        });
    } catch {
      // Fail closed immediately; Main independently enforces the original nonce deadline.
      if (operation === this.operation) this.stop();
    } finally {
      this.busyRenewal = false;
    }
  }

  stop(cancelGrant = true): void {
    if (cancelGrant) {
      this.grantRequest = undefined;
      this.incoming = undefined;
    }
    ++this.operation;
    this.release();
    this.update('stopped');
  }
  private release(): void {
    this.abort?.abort();
    this.abort = undefined;
    clearInterval(this.renewal);
    this.renewal = undefined;
    this.destroyGuest();
    const network = this.network;
    this.network = undefined;
    if (network) void this.bridge?.close(network).catch(() => undefined);
  }
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    ++this.operation;
    this.incoming = undefined;
    this.grantRequest = undefined;
    this.release();
    this.unsubscribe?.();
    this.unsubscribeRevoke?.();
  }
}
