import { isBrowserAgentProfile } from '../../../shared/browser/browser';
import { isTemporaryBrowserPreviewUrl } from '../../../shared/browser/browserHistory';
import {
  RECORDING_NETWORK_LIMITS,
  type RecordingNetworkCommand,
  type RecordingNetworkCoverageIssue,
  type RecordingNetworkDocument,
  recordingNetworkMethod,
  type RecordingNetworkObservation,
  type RecordingNetworkPageRef,
  type RecordingNetworkReply,
  type RecordingNetworkSegment,
  type RecordingNetworkSnapshot,
  sanitizeRecordingNetworkAddress,
} from '../../../shared/browser/browserRecordingNetwork';

const {
  prepareMs: READINESS_MS,
  finishMs: FINISH_MS,
  segments: MAX_SEGMENTS,
  documents: MAX_DOCUMENTS,
  entries: MAX_ENTRIES,
  inFlight: MAX_PENDING,
  reservedInFlight: PENDING_API_RESERVE,
  redirects: MAX_REDIRECTS,
} = RECORDING_NETWORK_LIMITS;
const TRANSFER_MS = 1_500;
const LOAD_MS = 5_000;
const LOAD_TAIL_MS = 500;
const MAX_FRAMES = 256;
const MAX_CLOCK_SKEW_MS = 1_000;

type JsonObject = Record<string, unknown>;
type CoverageIssue = RecordingNetworkCoverageIssue;

export type RecordingNetworkTarget = {
  page: RecordingNetworkPageRef;
  guest: object;
  isCurrent: () => boolean;
  prepare: () => Promise<unknown>;
};

type Frame = {
  id: string;
  loaderId: string;
  parentId?: string;
  origin?: string;
  restricted?: true;
};
type NetworkDocument = {
  value: RecordingNetworkDocument;
  startedAtCdp?: number;
  loadThroughMs?: number;
};

type Segment = {
  value: RecordingNetworkSegment;
  target: RecordingNetworkTarget;
  frames: Map<string, Frame>;
  pending: Map<string, RequestRow>;
  documents: Map<string, NetworkDocument>;
  documentHistory: NetworkDocument[];
  rootId?: string;
  rootVersion: number;
  ready: boolean;
  finishing: boolean;
  changed?: () => void;
};

type RequestType = 'document' | 'fetch' | 'xhr' | 'event-source' | 'pending';

type RequestRow = {
  value: Omit<RecordingNetworkObservation, 'type'> & { type: RequestType };
  startedAtCdp: number;
  hops: number;
  responseAtMs?: number;
  terminalAtMs?: number;
};

type Transfer = {
  targetId: string;
  guest: object;
  webContentsId: number;
  toSessionId: string;
  expiresAtMs: number;
  resume: boolean;
};

type Capture = {
  recordingId: string;
  profile: RecordingNetworkCommand['lease']['profile'];
  resourceSessionId: string;
  sequence: number;
  commandKey?: string;
  reply?: Promise<RecordingNetworkReply>;
  paused: boolean;
  active?: Segment;
  recovery?: RecordingNetworkTarget;
  transfer?: Transfer;
  stopped?: Promise<RecordingNetworkSnapshot>;
  segments: Segment[];
  entries: Map<string, RequestRow>;
  coverage: Set<CoverageIssue>;
  documentCount: number;
  loadCount: number;
  rowCount: number;
  omittedCount: number;
};

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

const stringId = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function pageRef(value: unknown): RecordingNetworkPageRef | null {
  const page = object(value);
  if (
    !page ||
    !stringId(page.resourceSessionId) ||
    !stringId(page.targetId) ||
    !integer(page.expectedWebContentsId)
  )
    return null;
  return {
    resourceSessionId: page.resourceSessionId,
    targetId: page.targetId,
    expectedWebContentsId: page.expectedWebContentsId,
  };
}

export function parseRecordingNetworkCommand(value: unknown): RecordingNetworkCommand | null {
  const raw = object(value);
  const leaseRef = object(raw?.lease);
  if (
    !raw ||
    !leaseRef ||
    !stringId(leaseRef.recordingId, 80) ||
    !stringId(leaseRef.sessionId) ||
    !isBrowserAgentProfile(leaseRef.profile) ||
    !integer(raw.sequence)
  )
    return null;
  const common = {
    lease: {
      recordingId: leaseRef.recordingId,
      sessionId: leaseRef.sessionId,
      profile: leaseRef.profile,
    },
    sequence: raw.sequence,
  };
  if (raw.action === 'start') {
    const page = pageRef(raw.page);
    return raw.page === null || page ? { ...common, action: raw.action, page } : null;
  }
  if (!finite(raw.requestedAtMs) || raw.requestedAtMs < 0) return null;
  const requestedAtMs = raw.requestedAtMs;
  if (raw.action === 'pause' || raw.action === 'finish')
    return { ...common, action: raw.action, requestedAtMs };
  if (raw.action === 'setTarget') {
    const page = pageRef(raw.page);
    return raw.page === null || page
      ? { ...common, action: raw.action, page, requestedAtMs }
      : null;
  }
  if (raw.action === 'transferTarget' && stringId(raw.toSessionId)) {
    const from = pageRef(raw.from);
    if (from && from.resourceSessionId !== raw.toSessionId) {
      return { ...common, action: raw.action, from, toSessionId: raw.toSessionId, requestedAtMs };
    }
  }
  return null;
}

function frameRecord(value: unknown): Frame | undefined {
  const frame = object(value);
  if (!frame || !stringId(frame.id) || !stringId(frame.loaderId)) return;
  const url = typeof frame.url === 'string' ? frame.url : '';
  const restricted = isTemporaryBrowserPreviewUrl(url);
  return {
    id: frame.id,
    loaderId: frame.loaderId,
    ...(stringId(frame.parentId) ? { parentId: frame.parentId } : {}),
    ...(restricted ? { restricted: true } : {}),
    ...(!restricted && url !== 'about:blank'
      ? { origin: sanitizeRecordingNetworkAddress(url)?.origin }
      : {}),
  };
}

function requestType(params: JsonObject, root: boolean): RequestType | undefined {
  if (params.type === 'Preflight' || object(params.initiator)?.type === 'preflight') return;
  if (params.type === 'Document' && root) return 'document';
  if (params.type === 'Fetch') return 'fetch';
  if (params.type === 'XHR') return 'xhr';
  if (params.type === 'EventSource') return 'event-source';
  // Chromium may classify a request after the initial event. Known static
  // assets and protocol housekeeping never enter the recorder's buffer.
  if (params.type === undefined || params.type === 'Other') return 'pending';
}

function errorCategory(params: JsonObject): NonNullable<RecordingNetworkObservation['failure']> {
  if (object(params.corsErrorStatus)) return 'cors';
  if (typeof params.blockedReason === 'string') return 'blocked';
  const error = typeof params.errorText === 'string' ? params.errorText : '';
  if (/ERR_(?:NAME_NOT_RESOLVED|DNS_)/u.test(error)) return 'dns';
  if (/ERR_(?:SSL_|CERT_)/u.test(error)) return 'tls';
  if (/ERR_(?:CONNECTION_)?TIMED_OUT/u.test(error)) return 'timeout';
  return 'other';
}

const isRead = (method: string): boolean => method === 'GET' || method === 'HEAD';

function possibleEvidence(params: JsonObject): boolean {
  const type = requestType(params, true);
  const request = object(params.request);
  const url = request?.url;
  return Boolean(
    type &&
    type !== 'pending' &&
    (type !== 'document' || !isRead(recordingNetworkMethod(request?.method))) &&
    typeof url === 'string' &&
    /^https?:\/\//iu.test(url) &&
    !isTemporaryBrowserPreviewUrl(url) &&
    (typeof params.documentURL !== 'string' || !isTemporaryBrowserPreviewUrl(params.documentURL)),
  );
}

function startsInWindow(params: JsonObject, segment: Segment): boolean {
  if (!finite(params.wallTime)) return false;
  const startedAtMs = Math.round(params.wallTime * 1_000);
  return startedAtMs >= segment.value.startedAtMs && startedAtMs <= Date.now() + MAX_CLOCK_SKEW_MS;
}

function noteworthy(row: RequestRow): boolean {
  return (
    !isRead(row.value.method) || row.value.outcome === 'failed' || (row.value.status ?? 0) >= 400
  );
}

function keepRow(row: RequestRow): boolean {
  return (
    row.value.type !== 'pending' &&
    (noteworthy(row) || (row.value.type !== 'document' && row.value.outcome !== 'redirected'))
  );
}

function priority(row: RequestRow): number {
  return noteworthy(row) ? 2 : 1;
}

function completedReadKey(row: RequestRow): string | undefined {
  const {
    segmentId, documentId, type, method, origin, path, search, status, outcome, frame, urlRedacted,
    urlLimited,
  } = row.value;
  if (
    type === 'document' || !isRead(method) || outcome !== 'complete' || frame || urlRedacted ||
    urlLimited || status === undefined || !((status >= 200 && status < 300) || status === 304)
  ) return;
  return JSON.stringify([segmentId, documentId, type, method, origin, path, search, status]);
}

function boundedResult<T>(work: Promise<T>, limitMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, limitMs);
    void work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export class BrowserRecordingNetworkObserver {
  private readonly captures = new Map<number, Capture>();

  resourceSession(ownerId: number, recordingId: string): string | undefined {
    const capture = this.captures.get(ownerId);
    return capture?.recordingId === recordingId ? capture.resourceSessionId : undefined;
  }

  apply(
    ownerId: number,
    command: RecordingNetworkCommand,
    target?: RecordingNetworkTarget,
  ): Promise<RecordingNetworkReply> {
    const {
      sequence,
      lease: { recordingId },
    } = command;
    let capture = this.captures.get(ownerId);
    const stale = { recordingId, sequence, status: 'stale' } as const;
    if (!capture) {
      if (command.action !== 'start') return Promise.resolve(stale);
      capture = {
        recordingId,
        sequence: 0,
        paused: false,
        profile: command.lease.profile,
        resourceSessionId: command.lease.sessionId,
        segments: [],
        entries: new Map(),
        coverage: new Set(),
        documentCount: 0,
        loadCount: 0,
        rowCount: 0,
        omittedCount: 0,
      };
      this.captures.set(ownerId, capture);
    }
    if (capture.recordingId !== recordingId) return Promise.resolve(stale);
    const commandKey = JSON.stringify(command);
    if (sequence === capture.sequence && commandKey === capture.commandKey && capture.reply)
      return capture.reply;
    if (
      sequence <= capture.sequence ||
      (command.action === 'start' && capture.sequence !== 0) ||
      (capture.stopped && command.action !== 'finish')
    )
      return Promise.resolve(stale);
    capture.sequence = sequence;
    capture.commandKey = commandKey;
    capture.transfer = undefined;
    capture.recovery = undefined;
    capture.reply = this.execute(capture, command, target);
    return capture.reply;
  }

  completeTransfer(
    ownerId: number,
    profile: Capture['profile'],
    resolveTarget: () => RecordingNetworkTarget | undefined,
  ): void {
    const capture = this.captures.get(ownerId);
    const transfer = capture?.transfer;
    if (!capture || capture.profile !== profile || !transfer || capture.stopped) return;
    if (Date.now() > transfer.expiresAtMs) {
      capture.transfer = undefined;
      capture.coverage.add('transfer');
      return;
    }
    const target = resolveTarget();
    if (
      !target ||
      transfer.targetId !== target.page.targetId ||
      transfer.guest !== target.guest ||
      transfer.webContentsId !== target.page.expectedWebContentsId ||
      transfer.toSessionId !== target.page.resourceSessionId ||
      !target.isCurrent()
    )
      return;
    capture.transfer = undefined;
    capture.resourceSessionId = transfer.toSessionId;
    if (transfer.resume) void this.open(capture, target, capture.sequence);
  }

  release(ownerId: number, recordingId: string): void {
    const capture = this.captures.get(ownerId);
    if (capture?.recordingId !== recordingId) return;
    this.captures.delete(ownerId);
    this.close(capture, Date.now());
  }

  detach(guest: object, canRecover = false): void {
    for (const capture of this.captures.values()) {
      if (capture.active?.target.guest !== guest) {
        if (!canRecover && capture.recovery?.guest === guest) capture.recovery = undefined;
        continue;
      }
      capture.coverage.add('detached');
      capture.recovery = canRecover && !capture.stopped ? capture.active.target : undefined;
      this.close(capture, Date.now());
    }
  }

  recover(guest: object): void {
    for (const capture of this.captures.values()) {
      const target = capture.recovery;
      if (
        !target ||
        target.guest !== guest ||
        !target.isCurrent() ||
        capture.active ||
        capture.stopped
      )
        continue;
      capture.recovery = undefined;
      void this.open(capture, target, capture.sequence);
    }
  }

  observe(guest: object, method: string, params: JsonObject, debuggerSessionId?: string): void {
    if (!method.startsWith('Network.') && !method.startsWith('Page.')) return;
    for (const capture of this.captures.values()) {
      const segment = capture.active;
      if (!segment || segment.target.guest !== guest || !segment.target.isCurrent()) continue;
      if (debuggerSessionId) {
        if (
          method === 'Network.requestWillBeSent' &&
          !segment.finishing &&
          startsInWindow(params, segment) &&
          possibleEvidence(params)
        )
          capture.coverage.add('unattributed');
        continue;
      }
      if (!segment.finishing && method === 'Page.frameNavigated') {
        const frame = frameRecord(params.frame);
        if (frame) this.setFrame(capture, segment, frame, true);
      } else if (
        !segment.finishing &&
        method === 'Page.frameAttached' &&
        stringId(params.frameId) &&
        stringId(params.parentFrameId) &&
        !segment.frames.has(params.frameId)
      ) {
        this.setFrame(
          capture,
          segment,
          { id: params.frameId, parentId: params.parentFrameId, loaderId: '' },
          false,
        );
      } else if (
        !segment.finishing &&
        method === 'Page.frameDetached' &&
        stringId(params.frameId)
      ) {
        this.removeFrame(segment, params.frameId);
      }
      if (!segment.ready) {
        if (
          method === 'Network.requestWillBeSent' &&
          startsInWindow(params, segment) &&
          possibleEvidence(params)
        )
          capture.coverage.add('late-start');
        continue;
      }
      switch (method) {
        case 'Network.requestWillBeSent':
          this.request(capture, segment, params);
          break;
        case 'Network.responseReceived':
          this.response(capture, segment, params);
          break;
        case 'Network.loadingFinished':
          this.terminal(capture, segment, params, false);
          break;
        case 'Network.loadingFailed':
          this.terminal(capture, segment, params, true);
          break;
        case 'Page.lifecycleEvent':
          this.lifecycle(segment, params);
          break;
      }
    }
  }

  private execute(
    capture: Capture,
    command: RecordingNetworkCommand,
    target?: RecordingNetworkTarget,
  ): Promise<RecordingNetworkReply> {
    const { recordingId } = capture;
    const { sequence } = command;
    const reply = { recordingId, sequence };
    switch (command.action) {
      case 'finish':
        capture.paused = true;
        capture.stopped ??= this.finish(capture, command.requestedAtMs);
        return capture.stopped.then(snapshot => ({ ...reply, status: 'finished', snapshot }));
      case 'pause':
        capture.paused = true;
        this.close(capture, command.requestedAtMs);
        return Promise.resolve({ ...reply, status: 'paused' });
      case 'transferTarget':
        this.close(capture, command.requestedAtMs);
        if (!target?.isCurrent()) {
          capture.coverage.add('transfer');
          return Promise.resolve({ ...reply, status: 'unavailable' });
        }
        capture.transfer = {
          targetId: target.page.targetId,
          guest: target.guest,
          webContentsId: target.page.expectedWebContentsId,
          toSessionId: command.toSessionId,
          expiresAtMs: Date.now() + TRANSFER_MS,
          resume: !capture.paused,
        };
        capture.coverage.add('transfer');
        return Promise.resolve({ ...reply, status: 'transferReady' });
      case 'setTarget':
        capture.paused = false;
        if (
          target &&
          capture.active?.ready &&
          capture.active.target.guest === target.guest &&
          capture.active.target.page.targetId === target.page.targetId &&
          capture.active.target.isCurrent()
        ) {
          return Promise.resolve({ ...reply, status: 'ready', segmentId: capture.active.value.id });
        }
        this.close(capture, command.requestedAtMs);
        break;
      case 'start':
        break;
    }
    return target
      ? this.open(capture, target, sequence)
      : Promise.resolve({ ...reply, status: 'waiting' });
  }

  private async open(
    capture: Capture,
    target: RecordingNetworkTarget,
    sequence: number,
  ): Promise<RecordingNetworkReply> {
    const reply = { recordingId: capture.recordingId, sequence };
    if (!target.isCurrent() || capture.segments.length >= MAX_SEGMENTS) {
      capture.coverage.add(capture.segments.length >= MAX_SEGMENTS ? 'limit' : 'unavailable');
      return { ...reply, status: 'unavailable' };
    }
    const now = Date.now();
    const segment: Segment = {
      value: {
        id: capture.segments.length + 1,
        pageId: target.page.targetId,
        webContentsId: target.page.expectedWebContentsId,
        startedAtMs: now,
        endedAtMs: now,
        documents: [],
      },
      target,
      frames: new Map(),
      pending: new Map(),
      documents: new Map(),
      documentHistory: [],
      rootVersion: 0,
      ready: false,
      finishing: false,
    };
    capture.active = segment;
    capture.segments.push(segment);
    const tree = await boundedResult(Promise.resolve().then(target.prepare), READINESS_MS);
    if (capture.active !== segment || capture.sequence !== sequence || capture.stopped)
      return { ...reply, status: 'stale' };
    if (tree && !segment.rootVersion)
      this.applyFrameTree(capture, segment, object(tree)?.frameTree);
    if (!tree || !segment.rootId || !target.isCurrent()) {
      capture.coverage.add('unavailable');
      if (target.isCurrent()) capture.recovery = target;
      this.close(capture, Date.now());
      return { ...reply, status: 'unavailable' };
    }
    segment.ready = true;
    return { ...reply, status: 'ready', segmentId: segment.value.id };
  }

  private applyFrameTree(capture: Capture, segment: Segment, value: unknown): void {
    const queue = [value];
    while (queue.length && segment.frames.size < MAX_FRAMES) {
      const tree = object(queue.shift());
      const frame = frameRecord(tree?.frame);
      if (!frame) continue;
      this.setFrame(capture, segment, frame, false);
      if (!Array.isArray(tree?.childFrames)) continue;
      const available = Math.max(0, MAX_FRAMES - queue.length - segment.frames.size);
      if (tree.childFrames.length > available) capture.coverage.add('limit');
      queue.push(...tree.childFrames.slice(0, available));
    }
    if (queue.length) capture.coverage.add('limit');
  }

  private removeFrame(segment: Segment, id: string): void {
    if (segment.rootId === id) {
      const root = segment.frames.get(id);
      const document = root && segment.documents.get(root.loaderId);
      if (document) document.value.endedAtMs ??= Date.now();
      segment.rootId = undefined;
    }
    const children = [id];
    for (let index = 0; index < children.length; index++) {
      const current = children[index];
      segment.frames.delete(current);
      for (const frame of segment.frames.values())
        if (frame.parentId === current) children.push(frame.id);
    }
  }

  private setFrame(capture: Capture, segment: Segment, frame: Frame, committed: boolean): void {
    if (frame.parentId) {
      const parent = segment.frames.get(frame.parentId);
      if (!parent || parent.restricted) return;
      const prior = segment.frames.get(frame.id);
      if (prior && prior.loaderId !== frame.loaderId) this.removeFrame(segment, frame.id);
      if (!segment.frames.has(frame.id) && segment.frames.size >= MAX_FRAMES) {
        capture.coverage.add('limit');
        return;
      }
      segment.frames.set(frame.id, frame);
      return;
    }
    const previous = segment.rootId ? segment.frames.get(segment.rootId) : undefined;
    if (committed) segment.rootVersion++;
    if (previous && (previous.id !== frame.id || previous.loaderId !== frame.loaderId)) {
      const previousDocument = segment.documents.get(previous.loaderId);
      if (previousDocument) previousDocument.value.endedAtMs ??= Date.now();
      segment.frames.clear();
    }
    segment.rootId = frame.id;
    segment.frames.set(frame.id, frame);
    // Restoring a cached document can reuse its loader. It still starts a new
    // visible interval, so earlier requests keep their original time bounds.
    if (committed && segment.documents.get(frame.loaderId)?.value.endedAtMs !== undefined) {
      segment.documents.delete(frame.loaderId);
    }
    const now = Date.now();
    const document = this.document(capture, segment, frame.loaderId, now);
    if (document) document.value.committedAtMs ??= now;
  }

  private document(
    capture: Capture,
    segment: Segment,
    loaderId: string,
    startedAtMs: number,
    startedAtCdp?: number,
  ): NetworkDocument | undefined {
    let current = segment.documents.get(loaderId);
    if (!current) {
      if (capture.documentCount >= MAX_DOCUMENTS) {
        capture.coverage.add('limit');
        return;
      }
      current = { value: { id: ++capture.documentCount, startedAtMs } };
      segment.documents.set(loaderId, current);
      segment.documentHistory.push(current);
    }
    if (startedAtCdp !== undefined && current.value.loadSequence === undefined) {
      for (const previous of segment.documents.values()) {
        if (previous !== current && previous.loadThroughMs !== undefined) {
          previous.loadThroughMs = Math.min(startedAtMs, previous.loadThroughMs);
        }
      }
      current.value.startedAtMs = Math.min(startedAtMs, current.value.startedAtMs);
      current.value.loadSequence = ++capture.loadCount;
      current.startedAtCdp = startedAtCdp;
      current.loadThroughMs = startedAtMs + LOAD_MS;
    }
    return current;
  }

  private lifecycle(segment: Segment, params: JsonObject): void {
    if (
      params.frameId !== segment.rootId ||
      params.name !== 'DOMContentLoaded' ||
      !stringId(params.loaderId) ||
      !finite(params.timestamp)
    )
      return;
    const document = segment.documents.get(params.loaderId);
    if (!document || document.startedAtCdp === undefined || document.loadThroughMs === undefined)
      return;
    const sinceStartMs = (params.timestamp - document.startedAtCdp) * 1_000;
    if (sinceStartMs >= 0) {
      document.loadThroughMs = Math.min(
        document.loadThroughMs,
        document.value.startedAtMs + sinceStartMs + LOAD_TAIL_MS,
      );
    }
  }

  private request(capture: Capture, segment: Segment, params: JsonObject): void {
    const requestId = params.requestId;
    if (!stringId(requestId) || !finite(params.timestamp)) return;
    const previous = segment.pending.get(requestId);
    const redirect = object(params.redirectResponse);
    if (previous && !redirect) return;
    if (redirect && previous) {
      if (!this.updateResponse(previous, redirect, params.timestamp)) return;
      previous.value.outcome = 'redirected';
      previous.terminalAtMs = previous.responseAtMs;
      segment.pending.delete(requestId);
      this.updateRetention(capture, previous);
      segment.changed?.();
    }
    if (segment.finishing) return;
    const frame =
      typeof params.frameId === 'string' ? segment.frames.get(params.frameId) : undefined;
    const root = frame !== undefined && frame.id === segment.rootId;
    const type = requestType(params, root);
    if (!type) return;
    const hops = (previous?.hops ?? 0) + 1;
    if (hops > MAX_REDIRECTS) {
      if (possibleEvidence(params)) this.omit(capture);
      return;
    }
    if (!finite(params.wallTime) || !stringId(params.loaderId)) return;
    const now = Date.now();
    const startedAtMs = Math.round(params.wallTime * 1_000);
    if (startedAtMs < segment.value.startedAtMs) return;
    const request = object(params.request);
    if (typeof request?.url !== 'string' || isTemporaryBrowserPreviewUrl(request.url)) return;
    if (
      params.type !== 'Document' &&
      typeof params.documentURL === 'string' &&
      isTemporaryBrowserPreviewUrl(params.documentURL)
    )
      return;
    const address = sanitizeRecordingNetworkAddress(request.url);
    if (!address) return;
    const rootFrame = segment.rootId ? segment.frames.get(segment.rootId) : undefined;
    const knownDocument = segment.documents.get(params.loaderId);
    const pendingMainLoad =
      root &&
      knownDocument?.value.loadSequence !== undefined &&
      knownDocument.value.committedAtMs === undefined;
    if (
      !frame ||
      (frame.restricted && type !== 'document') ||
      (!rootFrame?.origin && type !== 'document' && !pendingMainLoad) ||
      (params.type !== 'Document' && params.loaderId !== frame.loaderId && !pendingMainLoad)
    ) {
      if (possibleEvidence(params)) capture.coverage.add('unattributed');
      return;
    }
    if (startedAtMs > now + MAX_CLOCK_SKEW_MS) {
      if (possibleEvidence(params)) capture.coverage.add('clock');
      return;
    }
    const document =
      type === 'document'
        ? this.document(capture, segment, params.loaderId, startedAtMs, params.timestamp)
        : root
          ? knownDocument
          : rootFrame
            ? segment.documents.get(rootFrame.loaderId)
            : undefined;
    if (!document) return;
    if (
      segment.pending.size >= MAX_PENDING ||
      (type === 'pending' && segment.pending.size >= MAX_PENDING - PENDING_API_RESERVE)
    ) {
      this.omit(capture);
      return;
    }
    const row: RequestRow = {
      startedAtCdp: params.timestamp,
      hops,
      value: {
        id: String(++capture.rowCount),
        pageId: segment.value.pageId,
        segmentId: segment.value.id,
        documentId: document.value.id,
        startedAtMs,
        type,
        ...address,
        method: recordingNetworkMethod(request.method),
        outcome: 'unfinished',
        ...(document.value.loadSequence !== undefined
          ? { loadSequence: document.value.loadSequence }
          : {}),
        ...(!root ? { frame: 'child' } : {}),
      },
    };
    segment.pending.set(requestId, row);
    if (keepRow(row)) this.retain(capture, row);
  }

  private elapsed(row: RequestRow, timestamp: number): number | undefined {
    const ms = (timestamp - row.startedAtCdp) * 1_000;
    return finite(ms) && ms >= 0 && ms <= 24 * 60 * 60_000 ? Math.round(ms) : undefined;
  }

  private updateResponse(row: RequestRow, response: JsonObject, timestamp: number): boolean {
    const responseMs = this.elapsed(row, timestamp);
    if (responseMs === undefined) return false;
    row.responseAtMs = row.value.startedAtMs + responseMs;
    if (integer(response.status) && response.status >= 100 && response.status <= 599)
      row.value.status = response.status;
    return true;
  }

  private completeRequestType(row: RequestRow, params: JsonObject): void {
    if (row.value.type !== 'pending') return;
    const type = requestType(params, false);
    if (type && type !== 'pending') row.value.type = type;
  }

  private response(capture: Capture, segment: Segment, params: JsonObject): void {
    if (!stringId(params.requestId) || !finite(params.timestamp)) return;
    const row = segment.pending.get(params.requestId);
    const response = object(params.response);
    if (!row || !response || !this.updateResponse(row, response, params.timestamp)) return;
    this.completeRequestType(row, params);
    if (keepRow(row)) this.retain(capture, row);
  }

  private terminal(capture: Capture, segment: Segment, params: JsonObject, failed: boolean): void {
    if (!stringId(params.requestId) || !finite(params.timestamp)) return;
    const row = segment.pending.get(params.requestId);
    if (!row) return;
    const durationMs = this.elapsed(row, params.timestamp);
    if (durationMs === undefined) return;
    segment.pending.delete(params.requestId);
    row.terminalAtMs = row.value.startedAtMs + durationMs;
    this.completeRequestType(row, params);
    row.value.outcome = failed ? (params.canceled === true ? 'canceled' : 'failed') : 'complete';
    if (failed && row.value.outcome === 'failed') row.value.failure = errorCategory(params);
    this.updateRetention(capture, row);
    segment.changed?.();
  }

  private omit(capture: Capture): void {
    capture.omittedCount++;
    capture.coverage.add('limit');
  }

  private updateRetention(capture: Capture, row: RequestRow): void {
    if (keepRow(row)) this.retain(capture, row);
    else capture.entries.delete(row.value.id);
  }

  private retain(capture: Capture, row: RequestRow): void {
    if (capture.entries.has(row.value.id)) return;
    if (capture.entries.size >= MAX_ENTRIES) {
      const rowPriority = priority(row);
      const seenReads = new Set<string>();
      let candidate: RequestRow | undefined;
      let duplicate: RequestRow | undefined;
      for (const existing of capture.entries.values()) {
        const existingPriority = priority(existing);
        if (existingPriority > rowPriority) continue;
        if (!candidate || existingPriority <= priority(candidate)) candidate = existing;
        const readKey = completedReadKey(existing);
        if (readKey === undefined) continue;
        if (seenReads.has(readKey)) duplicate = existing;
        else seenReads.add(readKey);
      }
      this.omit(capture);
      const discarded = duplicate ?? candidate;
      if (!discarded) return;
      capture.entries.delete(discarded.value.id);
    }
    capture.entries.set(row.value.id, row);
  }

  private cutoff(capture: Capture, segment: Segment, requestedAtMs: number): number {
    const now = Date.now();
    if (requestedAtMs > now + MAX_CLOCK_SKEW_MS) {
      capture.coverage.add('clock');
      return now;
    }
    return Math.min(now, Math.max(requestedAtMs, segment.value.startedAtMs));
  }

  private trim(capture: Capture, segment: Segment, cutoffMs: number, grace: boolean): void {
    segment.value.endedAtMs = cutoffMs;
    for (const [id, row] of capture.entries) {
      if (row.value.segmentId !== segment.value.id) continue;
      if (row.value.startedAtMs > cutoffMs) {
        capture.entries.delete(id);
        continue;
      }
      if (grace) continue;
      if (row.terminalAtMs !== undefined && row.terminalAtMs > cutoffMs) {
        row.value.outcome = 'unfinished';
        delete row.value.failure;
      }
      if (row.responseAtMs !== undefined && row.responseAtMs > cutoffMs) {
        delete row.value.status;
      }
      if (!keepRow(row)) capture.entries.delete(id);
    }
    for (const [key, row] of segment.pending)
      if (row.value.startedAtMs > cutoffMs) segment.pending.delete(key);
    segment.documentHistory = segment.documentHistory.filter(
      document => document.value.startedAtMs <= cutoffMs,
    );
    for (const document of segment.documentHistory) {
      if (document.value.endedAtMs === undefined || document.value.endedAtMs > cutoffMs)
        document.value.endedAtMs = cutoffMs;
      if (document.value.committedAtMs !== undefined && document.value.committedAtMs > cutoffMs)
        delete document.value.committedAtMs;
    }
    segment.value.documents = segment.documentHistory.map(document => document.value);
  }

  private close(capture: Capture, requestedAtMs: number): void {
    const segment = capture.active;
    if (!segment) return;
    if (!segment.finishing)
      this.trim(capture, segment, this.cutoff(capture, segment, requestedAtMs), false);
    capture.active = undefined;
    segment.pending.clear();
    segment.frames.clear();
    segment.documents.clear();
    segment.changed?.();
  }

  private async finish(capture: Capture, requestedAtMs: number): Promise<RecordingNetworkSnapshot> {
    const segment = capture.active;
    if (segment) {
      this.trim(capture, segment, this.cutoff(capture, segment, requestedAtMs), true);
      segment.finishing = true;
      if (segment.pending.size) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, FINISH_MS);
          segment.changed = () => {
            if (segment.pending.size) return;
            clearTimeout(timer);
            resolve();
          };
        });
      }
      this.close(capture, requestedAtMs);
    }
    if (!capture.segments.some(item => item.ready)) capture.coverage.add('unavailable');
    const documents = new Map(
      capture.segments.flatMap(item =>
        item.documentHistory.map(doc => [doc.value.id, doc] as const),
      ),
    );
    const entries = [...capture.entries.values()]
      .flatMap(({ value: { type, ...value } }): RecordingNetworkObservation[] => {
        if (type === 'pending') return [];
        const document =
          value.documentId === undefined ? undefined : documents.get(value.documentId);
        const withinLoad =
          document?.loadThroughMs !== undefined && value.startedAtMs <= document.loadThroughMs;
        return [{ ...value, type, ...(withinLoad ? { withinLoad: true as const } : {}) }];
      })
      .sort(
        (left, right) => left.startedAtMs - right.startedAtMs || Number(left.id) - Number(right.id),
      );
    return {
      entries,
      segments: capture.segments.map(item => item.value),
      coverage: [...capture.coverage],
      omittedCount: capture.omittedCount,
    };
  }
}
