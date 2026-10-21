import { randomUUID } from 'node:crypto';

import {
  type DiagramSnapshot,
  type DiagramSource,
  type DiagramUpdateReceipt,
  DRAWIO_UPDATE_KIND,
  type PreparedDiagramCanvas,
} from './contracts';

export interface CanvasOwner {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  connectionId: string;
  viewId: string;
  assertCurrent: () => void;
}
type Canvas = {
  owner: CanvasOwner;
  token: string;
  source: DiagramSource;
  snapshot: DiagramSnapshot;
};
type Prepared = { canvas: Canvas; snapshot: DiagramSnapshot; selected: boolean };
type Run = { owner: CanvasOwner; canvases: Prepared[]; unknown: boolean };
type Operation = {
  id: string;
  run: Run;
  prepared: Prepared;
  runId: string;
  toolCallId: string;
  xml: string;
  title: string;
  state: 'pending' | 'dispatched' | 'applied' | 'rejected' | 'unknown';
  assertInvocationCurrent: () => void;
  resolve: (value: DiagramUpdateReceipt) => void;
  reject: (error: Error) => void;
};
const sameSession = (
  a: CanvasOwner,
  b: Pick<CanvasOwner, 'sessionKey' | 'sessionId' | 'agentId'>,
) => a.sessionKey === b.sessionKey && a.sessionId === b.sessionId && a.agentId === b.agentId;

/** Bounded live routing only. Native tool results remain the durable authority. */
export class DiagramCanvasState {
  private canvases = new Map<string, Canvas>();
  private runs = new Map<string, Run>();
  private operations = new Map<string, Operation>();
  private calls = new Set<string>();
  emit?: (viewId: string) => void;

  prepare(
    owner: CanvasOwner,
    source: DiagramSource,
    snapshot: DiagramSnapshot,
    token?: string,
    retire = false,
  ) {
    owner.assertCurrent();
    const key = `${owner.sessionId}/${snapshot.diagramId}`;
    let previous = this.canvases.get(key);
    if (
      retire &&
      previous &&
      sameSession(previous.owner, owner) &&
      previous.owner.connectionId === owner.connectionId &&
      previous.owner.viewId === owner.viewId
    ) {
      this.retireCanvas(previous);
      previous = undefined;
    }
    if (previous && previous.token !== token) {
      let live = true;
      try {
        previous.owner.assertCurrent();
      } catch {
        live = false;
      }
      if (live) throw new Error('Diagram is already open in another editor');
    }
    if (
      previous &&
      previous.token === token &&
      (!sameSession(previous.owner, owner) ||
        previous.owner.connectionId !== owner.connectionId ||
        previous.owner.viewId !== owner.viewId)
    )
      throw new Error('Diagram editor changed');
    if (previous && (retire || previous.token !== token)) this.retireCanvas(previous);
    if (!previous && this.canvases.size >= 32) throw new Error('Too many open diagrams');
    const canvas: Canvas = {
      owner: { ...owner },
      source: Object.freeze({ ...source }),
      snapshot: { ...snapshot },
      token: previous && previous.token === token && !retire ? previous.token : randomUUID(),
    };
    this.canvases.set(key, canvas);
    return canvas.token;
  }

  private canvas(owner: CanvasOwner, token: string) {
    owner.assertCurrent();
    const canvas = [...this.canvases.values()].find(item => item.token === token);
    if (
      !canvas ||
      !sameSession(canvas.owner, owner) ||
      canvas.owner.viewId !== owner.viewId ||
      canvas.owner.connectionId !== owner.connectionId
    )
      throw new Error('Diagram editor unavailable');
    canvas.owner.assertCurrent();
    return canvas;
  }

  freeze(owner: CanvasOwner, runId: string, selected: PreparedDiagramCanvas[]) {
    owner.assertCurrent();
    if (this.runs.has(runId)) throw new Error('Diagram send already issued; do not retry');
    if (!selected.length || selected.length > 16) throw new Error('Invalid diagram preparation');
    const canvases = selected.map(item => {
      // Homepage adoption may use a second authenticated desktop connection.
      // The private host token transfers this exact preparation, while both
      // the original editor and submitting connection retain their own guards.
      const canvas = [...this.canvases.values()].find(value => value.token === item.token);
      if (!canvas || !sameSession(canvas.owner, owner) || canvas.owner.viewId !== item.viewId)
        throw new Error('Diagram send owner mismatch');
      canvas.owner.assertCurrent();
      return { canvas, snapshot: { ...canvas.snapshot }, selected: item.selected };
    });
    if (new Set(canvases.map(item => item.snapshot.diagramId)).size !== canvases.length)
      throw new Error('Duplicate diagram target');
    // Eviction only removes authority. It cannot redirect an older run to a new snapshot.
    if (this.runs.size >= 16) {
      const oldest = [...this.runs].find(
        ([, value]) =>
          ![...this.operations.values()].some(
            op => op.run === value && (op.state === 'pending' || op.state === 'dispatched'),
          ),
      );
      if (!oldest) throw new Error('Too many pending diagram sends');
      this.runs.delete(oldest[0]);
      for (const [key, operation] of this.operations)
        if (operation.run === oldest[1]) this.operations.delete(key);
      for (const key of this.calls)
        if (key.startsWith(`${oldest[1].owner.sessionId}/${oldest[0]}/`)) this.calls.delete(key);
    }
    this.runs.set(runId, { owner, canvases, unknown: false });
  }

  markUnknown(runId: string) {
    const run = this.runs.get(runId);
    if (run) run.unknown = true;
  }

  read(
    runId: string,
    identity: Pick<CanvasOwner, 'sessionKey' | 'sessionId' | 'agentId'>,
    diagramId?: string,
  ) {
    const run = this.runs.get(runId);
    if (!run || run.unknown || !sameSession(run.owner, identity))
      throw new Error('No prepared diagram for this run');
    run.owner.assertCurrent();
    const candidates = diagramId
      ? run.canvases.filter(item => item.snapshot.diagramId === diagramId)
      : run.canvases.filter(item => item.selected);
    const targets = candidates.length ? candidates : diagramId ? [] : run.canvases;
    if (targets.length !== 1)
      throw new Error(
        `Choose a diagram: ${run.canvases
          .map(item => `${item.snapshot.title} (${item.snapshot.diagramId})`)
          .join(', ')}`,
      );
    targets[0].canvas.owner.assertCurrent();
    this.canvas(targets[0].canvas.owner, targets[0].canvas.token);
    return targets[0];
  }

  async update(
    runId: string,
    toolCallId: string,
    identity: Pick<CanvasOwner, 'sessionKey' | 'sessionId' | 'agentId'>,
    input: { diagramId: string; baseContentStamp: string; xml: string; title: string },
    assertInvocationCurrent: () => void,
    signal?: AbortSignal,
  ) {
    assertInvocationCurrent();
    const prepared = this.read(runId, identity, input.diagramId);
    if (input.baseContentStamp !== prepared.snapshot.contentStamp)
      throw new Error('Diagram content changed; read it again');
    const call = `${identity.sessionId}/${runId}/${toolCallId}`;
    if (this.calls.has(call)) throw new Error('Diagram operation already issued; do not replay');
    if (
      [...this.operations.values()].some(
        op =>
          op.prepared.canvas.token === prepared.canvas.token &&
          ['pending', 'dispatched'].includes(op.state),
      )
    )
      throw new Error('Diagram update is already pending');
    if (this.operations.size >= 128) {
      const settled = [...this.operations].find(
        ([, operation]) => !['pending', 'dispatched'].includes(operation.state),
      );
      if (settled) this.operations.delete(settled[0]);
      else throw new Error('Too many pending diagram updates');
    }
    if (this.calls.size >= 512) throw new Error('Diagram operation limit reached for these runs');
    const run = this.runs.get(runId)!;
    this.calls.add(call);
    let operation!: Operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (!operation || !['pending', 'dispatched'].includes(operation.state)) return;
      const dispatched = operation.state === 'dispatched';
      operation.state = dispatched ? 'unknown' : 'rejected';
      if (dispatched) run.unknown = true;
      operation.reject(
        new Error(
          dispatched
            ? 'Diagram result unknown; do not replay'
            : 'Diagram update was not dispatched',
        ),
      );
    };
    try {
      return await new Promise<DiagramUpdateReceipt>((resolve, reject) => {
        operation = {
          id: randomUUID(),
          run,
          prepared,
          runId,
          toolCallId,
          xml: input.xml,
          title: input.title,
          state: 'pending',
          resolve,
          reject,
          assertInvocationCurrent,
        };
        this.operations.set(operation.id, operation);
        timer = setTimeout(abort, 20_000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else {
          try {
            assertInvocationCurrent();
          } catch {
            abort();
            return;
          }
          try {
            this.emit?.(prepared.canvas.owner.viewId);
          } catch {
            /* The host can still query pending state. */
          }
        }
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Keep only a bounded operation tombstone, never a second XML history.
      if (operation) {
        operation.xml = '';
        operation.title = '';
      }
    }
  }

  take(owner: CanvasOwner, token: string) {
    const canvas = this.canvas(owner, token);
    const operation = [...this.operations.values()].find(
      op => op.prepared.canvas.token === canvas.token && op.state === 'pending',
    );
    if (!operation) return null;
    operation.run.owner.assertCurrent();
    operation.assertInvocationCurrent();
    if (operation.run.unknown) throw new Error('Diagram send outcome unknown');
    operation.state = 'dispatched';
    return {
      operationId: operation.id,
      diagramId: canvas.source.diagramId,
      baseContentStamp: operation.prepared.snapshot.contentStamp,
      xml: operation.xml,
      title: operation.title,
    };
  }

  acknowledge(
    owner: CanvasOwner,
    token: string,
    operationId: string,
    result: { status: 'applied'; snapshot: DiagramSnapshot } | { status: 'conflict' | 'failed' },
  ) {
    const canvas = this.canvas(owner, token);
    const operation = this.operations.get(operationId);
    if (!operation || operation.prepared.canvas.token !== canvas.token)
      throw new Error('Unknown diagram operation');
    if (operation.state === 'applied' || operation.state === 'rejected') return;
    if (operation.state !== 'dispatched')
      throw new Error('Diagram result is unknown or was not dispatched');
    operation.run.owner.assertCurrent();
    operation.assertInvocationCurrent();
    if (result.status !== 'applied') {
      operation.state = 'rejected';
      operation.reject(
        new Error(
          result.status === 'conflict'
            ? 'Diagram changed while generating; manual edits were preserved'
            : 'Diagram could not be applied',
        ),
      );
      return;
    }
    if (result.snapshot.diagramId !== canvas.source.diagramId)
      throw new Error('Diagram acknowledgement mismatch');
    const receipt: DiagramUpdateReceipt = {
      ...result.snapshot,
      kind: DRAWIO_UPDATE_KIND,
      source: canvas.source,
      operationId,
      runId: operation.runId,
      toolCallId: operation.toolCallId,
      baseContentStamp: operation.prepared.snapshot.contentStamp,
      status: 'applied',
    };
    operation.state = 'applied';
    canvas.snapshot = { ...result.snapshot };
    operation.prepared.snapshot = { ...result.snapshot };
    operation.resolve(receipt);
  }

  detach(owner: CanvasOwner, token: string) {
    const canvas = this.canvas(owner, token);
    this.retireCanvas(canvas);
  }

  detachOwner(owner: CanvasOwner) {
    owner.assertCurrent();
    for (const canvas of this.canvases.values()) {
      if (
        sameSession(canvas.owner, owner) &&
        canvas.owner.connectionId === owner.connectionId &&
        canvas.owner.viewId === owner.viewId
      )
        this.retireCanvas(canvas);
    }
  }

  private retireCanvas(canvas: Canvas) {
    this.canvases.delete(`${canvas.owner.sessionId}/${canvas.source.diagramId}`);
    for (const op of this.operations.values())
      if (
        op.prepared.canvas.token === canvas.token &&
        ['pending', 'dispatched'].includes(op.state)
      ) {
        if (op.state === 'dispatched') op.run.unknown = true;
        op.state = op.state === 'dispatched' ? 'unknown' : 'rejected';
        op.reject(new Error('Diagram editor closed; dispatched results must not be replayed'));
      }
  }

  close() {
    for (const op of this.operations.values())
      op.reject(new Error('Diagram service stopped; do not replay'));
    this.canvases.clear();
    this.runs.clear();
    this.operations.clear();
    this.calls.clear();
    this.emit = undefined;
  }
}
