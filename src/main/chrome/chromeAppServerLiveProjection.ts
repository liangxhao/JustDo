import { CodexAppServerProgress } from '../appServer/appServerProgress';
import {
  type AppServerNotify,
  type AppServerParams,
  type AppServerResult,
} from '../appServer/appServerProtocol';
import { CodexAppServerToolProgress } from '../appServer/appServerToolProgress';
import type { ChromeExtensionAppServerStreamEvent } from './chromeAppServerTypes';

const MAX_ACTIVE_TURNS = 64;
const MAX_RETIRED_TURNS = 10_000;
const MAX_QUEUED_EVENTS = 2048;
// The admitted user item is sent as started+completed; both can contain the
// same bounded 4 MiB image input before the native send response arrives.
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

interface TurnProjection {
  admitted: boolean;
  failed: boolean;
  backfillingTool: boolean;
  lastAgentSeq: number;
  nativeSessionId?: string;
  nativeRunId?: string;
  sessionKey?: string;
  lifecycleGeneration?: string;
  queued: Array<{ method: string; params: AppServerParams }>;
  queuedBytes: number;
  progress: CodexAppServerProgress;
  tools: CodexAppServerToolProgress;
}

/** Bounded live items only. Attribution and whole-run settlement stay with the native owner. */
export class ChromeAppServerLiveProjection {
  private readonly turns = new Map<string, TurnProjection>();
  private readonly retired = new Set<string>();

  constructor(
    private readonly threadId: string,
    private readonly notify: AppServerNotify,
    private readonly fail: (error: Error) => void,
  ) {}

  prepareTurn(turnId: string, input: string | readonly AppServerResult[], _startedAt: number): void {
    if (!this.retired.has(turnId) && !this.turns.has(turnId))
      this.create(turnId, input, false);
  }

  admitTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn || turn.admitted || turn.failed) return;
    turn.admitted = true;
    const queued = turn.queued;
    turn.queued = [];
    turn.queuedBytes = 0;
    for (const event of queued) {
      if (turn.failed) break;
      this.deliver(turnId, turn, event.method, event.params);
    }
  }

  accept(value: ChromeExtensionAppServerStreamEvent): void {
    if (!value.turnId || value.kind !== 'agent' || this.retired.has(value.turnId)) return;
    const event = value.event;
    if (!Number.isSafeInteger(event.agentSeq) || event.agentSeq < 0) return;
    const turn = this.turns.get(value.turnId) ?? this.create(value.turnId, undefined, true);
    if (!turn || turn.failed) return;
    if (turn.nativeRunId && turn.nativeRunId !== event.runId) return;
    if (turn.sessionKey && event.sessionKey && turn.sessionKey !== event.sessionKey) return;
    if (turn.nativeSessionId && event.sessionId && turn.nativeSessionId !== event.sessionId) return;
    if (turn.lifecycleGeneration && event.lifecycleGeneration &&
      turn.lifecycleGeneration !== event.lifecycleGeneration) return;
    turn.nativeSessionId ??= event.sessionId ?? undefined;
    turn.nativeRunId ??= event.runId;
    turn.sessionKey ??= event.sessionKey ?? undefined;
    turn.lifecycleGeneration ??= event.lifecycleGeneration ?? undefined;
    if (event.agentSeq <= turn.lastAgentSeq) {
      // The native session.tool lane can fill a sparse tool segment after newer
      // text. It cannot rewind text/phase state; tool IDs retain their own guard.
      if (event.stream === 'tool' && event.deliveryEvent === 'session.tool') {
        turn.backfillingTool = true;
        try { turn.tools.accept(event); }
        finally { turn.backfillingTool = false; }
      }
      return;
    }
    turn.lastAgentSeq = event.agentSeq;
    turn.progress.accept(event);
    if (!turn.failed) turn.tools.accept(event);
  }

  finishTurn(turnId: string, finalText?: string): void {
    const turn = this.turns.get(turnId);
    if (turn && !turn.failed) turn.progress.finish(finalText);
    this.turns.delete(turnId);
    if (this.retired.size >= MAX_RETIRED_TURNS) {
      this.fail(new Error('Chrome item projection reached its retired execution limit.'));
      return;
    }
    this.retired.add(turnId);
  }

  discardTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn && !turn.admitted) this.turns.delete(turnId);
  }

  clear(): void {
    this.turns.clear();
    this.retired.clear();
  }

  private create(turnId: string, input: string | readonly AppServerResult[] | undefined, admitted: boolean): TurnProjection | undefined {
    if (this.turns.size >= MAX_ACTIVE_TURNS || this.retired.size >= MAX_RETIRED_TURNS) {
      this.fail(new Error('Chrome item projection exceeded its execution limit.'));
      return undefined;
    }
    let turn!: TurnProjection;
    const failed = (message: string) => this.retire(turn, new Error(message));
    const notify: AppServerNotify = (method, params) => this.deliver(turnId, turn, method, params);
    const progress = new CodexAppServerProgress(input, notify, failed);
    turn = {
      admitted,
      failed: false,
      backfillingTool: false,
      lastAgentSeq: -1,
      queued: [],
      queuedBytes: 0,
      progress,
      tools: new CodexAppServerToolProgress(notify, failed, () => {
        if (!turn.backfillingTool) progress.beforeTool();
      }),
    };
    this.turns.set(turnId, turn);
    return turn;
  }

  private deliver(turnId: string, turn: TurnProjection, method: string, params: AppServerParams): void {
    if (turn.failed) return;
    if (!turn.admitted) {
      let bytes: number;
      try { bytes = Buffer.byteLength(JSON.stringify(params)); }
      catch { this.retire(turn, new Error('Chrome item could not be encoded.')); return; }
      if (turn.queued.length >= MAX_QUEUED_EVENTS || turn.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        this.retire(turn, new Error('Chrome item admission buffer exceeded its limit.'));
        return;
      }
      turn.queued.push({ method, params });
      turn.queuedBytes += bytes;
      return;
    }
    try { this.notify(method, { threadId: this.threadId, turnId, ...params }); }
    catch { this.retire(turn, new Error('Chrome item output failed.')); }
  }

  private retire(turn: TurnProjection, error: Error): void {
    if (turn.failed) return;
    turn.failed = true;
    turn.queued = [];
    turn.queuedBytes = 0;
    // The hub retires failing viewers; an observer never cancels the native run.
    this.fail(error);
  }
}
