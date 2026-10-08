import fs from 'node:fs/promises';
import path from 'node:path';

import { ipcMain, type WebContents } from 'electron';

import {
  type TerminalActionResult,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  TerminalGateway,
  TerminalIpc,
} from '../../../shared/app/terminal';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { resolveTerminalShell } from './terminalShell';

type TerminalRuntime = Pick<
  OpenClawRuntimeAdapter,
  'on' | 'connectGatewayIfNeeded' | 'getGatewayClient' | 'prepareSession'
>;
export interface TerminalHandlerDependencies {
  getRuntime: () => TerminalRuntime;
  ensureRunning: () => Promise<void>;
  getSession: (id: string) => { cwd: string; agentId?: string | null } | null;
}
interface ManagedTerminal {
  id: string;
  owner: WebContents;
  runtime?: TerminalRuntime;
  client?: GatewayClientLike;
  nativeId?: string;
  closing: boolean;
  recovering: boolean;
  ready: boolean;
  offset?: number;
  pending: GatewayEventFrame[];
}
interface NativeTerminal {
  sessionId: string;
  cwd: string;
  buffer?: string;
  seq?: number;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const dimension = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(value)));
const failure = (error: unknown): TerminalActionResult => ({
  success: false,
  error: error instanceof Error ? error.message : 'Terminal operation failed',
});

/** Product tab ownership only. Gateway owns the PTY, buffer and agent sharing. */
export class GatewayTerminalService {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly runtimes = new WeakSet<TerminalRuntime>();
  private readonly owners = new WeakSet<WebContents>();
  // Output can precede the open reply. Only admission retains a bounded queue;
  // native attach supplies the authoritative buffer after any gap.
  private readonly early = new Map<
    GatewayClientLike,
    { frames: GatewayEventFrame[]; overflow: boolean }
  >();

  constructor(private readonly deps: TerminalHandlerDependencies) {}

  private send(terminal: ManagedTerminal, channel: string, payload: object): void {
    if (!terminal.closing && !terminal.owner.isDestroyed()) {
      terminal.owner.send(channel, { id: terminal.id, ...payload });
    }
  }
  private status(terminal: ManagedTerminal, ready: boolean, failed = false): void {
    terminal.ready = ready;
    this.send(terminal, TerminalIpc.Status, { ready, failed });
  }
  private bind(runtime: TerminalRuntime): void {
    if (this.runtimes.has(runtime)) return;
    this.runtimes.add(runtime);
    runtime.on('gatewayEvent', event => this.event(runtime, event));
    runtime.on('gatewayDisconnected', () => {
      for (const terminal of this.terminals.values()) {
        if (terminal.runtime === runtime) this.status(terminal, false);
      }
    });
    runtime.on('gatewayReady', () => {
      for (const terminal of this.terminals.values()) {
        if (
          terminal.runtime === runtime &&
          terminal.nativeId &&
          terminal.client !== runtime.getGatewayClient()
        )
          void this.recover(terminal);
      }
    });
  }
  private event(runtime: TerminalRuntime, event: GatewayEventFrame): void {
    if (event.event !== TerminalGateway.Data && event.event !== TerminalGateway.Exit) return;
    const payload = event.payload;
    if (!isRecord(payload) || typeof payload.sessionId !== 'string') return;
    const client = runtime.getGatewayClient();
    if (!client) return;
    const terminal = [...this.terminals.values()].find(
      candidate =>
        candidate.runtime === runtime &&
        candidate.client === client &&
        candidate.nativeId === payload.sessionId,
    );
    if (!terminal) {
      if (
        [...this.terminals.values()].some(
          candidate =>
            candidate.runtime === runtime && candidate.client === client && !candidate.nativeId,
        )
      ) {
        const queued = this.early.get(client) ?? { frames: [], overflow: false };
        const events = queued.frames;
        events.push(event);
        while (
          events.length > 256 ||
          events.reduce(
            (size, frame) =>
              size +
              (isRecord(frame.payload) && typeof frame.payload.data === 'string'
                ? frame.payload.data.length
                : 0),
            0,
          ) >
            64 * 1024
        ) {
          events.shift();
          queued.overflow = true;
        }
        this.early.set(client, queued);
      }
      return;
    }
    if (event.event === TerminalGateway.Exit) {
      this.status(terminal, false);
      this.send(terminal, TerminalIpc.Exit, {
        exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
      });
      this.terminals.delete(terminal.id);
      return;
    }
    if (terminal.recovering) {
      terminal.pending.push(event);
      // Overflow drops the oldest frame; offset continuity requests a fresh
      // native snapshot rather than displaying a truncated control sequence.
      while (
        terminal.pending.length > 256 ||
        terminal.pending.reduce(
          (size, frame) =>
            size +
            (isRecord(frame.payload) && typeof frame.payload.data === 'string'
              ? frame.payload.data.length
              : 0),
          0,
        ) >
          64 * 1024
      )
        terminal.pending.shift();
      return;
    }
    if (terminal.closing || typeof payload.data !== 'string') return;
    const data = payload.data;
    const end = payload.seq;
    if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < data.length) {
      this.status(terminal, false, true);
      return;
    }
    const start = end - data.length;
    const offset = terminal.offset ?? 0;
    if (start > offset) {
      void this.recover(terminal);
      return;
    }
    if (end <= offset) return;
    terminal.offset = end;
    this.send(terminal, TerminalIpc.Data, { data: data.slice(Math.max(0, offset - start)) });
  }
  private isCurrent(terminal: ManagedTerminal, client: GatewayClientLike): boolean {
    return (
      this.terminals.get(terminal.id) === terminal &&
      terminal.runtime?.getGatewayClient() === client
    );
  }
  private async recover(terminal: ManagedTerminal): Promise<void> {
    const client = terminal.runtime?.getGatewayClient();
    if (!client || !terminal.nativeId || terminal.recovering) return;
    terminal.recovering = true;
    terminal.client = client;
    terminal.pending = [];
    this.status(terminal, false);
    try {
      const attached = await client.request<NativeTerminal>(TerminalGateway.Attach, {
        sessionId: terminal.nativeId,
      });
      if (!this.isCurrent(terminal, client)) return;
      terminal.client = client;
      if (terminal.closing) {
        await this.finishClose(terminal);
        return;
      }
      if (
        attached.sessionId !== terminal.nativeId ||
        typeof attached.buffer !== 'string' ||
        typeof attached.seq !== 'number' ||
        !Number.isSafeInteger(attached.seq) ||
        attached.seq < attached.buffer.length
      ) {
        throw new Error('Invalid terminal replay');
      }
      terminal.offset = attached.seq;
      this.send(terminal, TerminalIpc.Data, { data: attached.buffer, reset: true });
      this.status(terminal, true);
    } catch (error) {
      if (!this.isCurrent(terminal, client)) return;
      this.status(terminal, false, true);
      // An attach timeout does not prove the PTY ended. Retain its identity so
      // an explicit close or a later reconnect can still reach that process.
      if (error instanceof Error && error.message.includes('unknown terminal session')) {
        this.terminals.delete(terminal.id);
      }
    } finally {
      terminal.recovering = false;
      if (this.terminals.get(terminal.id) === terminal) {
        if (
          terminal.runtime?.getGatewayClient() &&
          terminal.runtime.getGatewayClient() !== client
        ) {
          void this.recover(terminal);
        } else {
          const pending = terminal.pending;
          terminal.pending = [];
          for (const frame of pending) if (terminal.runtime) this.event(terminal.runtime, frame);
        }
      }
    }
  }
  async create(owner: WebContents, raw: unknown): Promise<TerminalCreateResult> {
    if (
      !isRecord(raw) ||
      !validId(raw.id) ||
      typeof raw.cwd !== 'string' ||
      !Number.isFinite(raw.cols) ||
      !Number.isFinite(raw.rows) ||
      (raw.sessionId !== undefined && !validId(raw.sessionId)) ||
      this.terminals.has(raw.id)
    ) {
      return failure(new Error('Invalid or duplicate terminal request'));
    }
    if ([...this.terminals.values()].filter(terminal => terminal.owner === owner).length >= 16) {
      return failure(new Error('Too many terminal tabs are open'));
    }
    const request = raw as unknown as TerminalCreateRequest;
    const terminal: ManagedTerminal = {
      id: request.id,
      owner,
      closing: false,
      recovering: false,
      ready: false,
      pending: [],
    };
    this.terminals.set(terminal.id, terminal);
    if (!this.owners.has(owner)) {
      this.owners.add(owner);
      owner.once('destroyed', () => {
        for (const entry of this.terminals.values())
          if (entry.owner === owner) void this.close(owner, entry.id);
      });
    }
    try {
      const session = request.sessionId ? this.deps.getSession(request.sessionId) : undefined;
      if (request.sessionId && !session) throw new Error('Chat session was not found');
      const cwd = path.resolve(session?.cwd ?? request.cwd);
      if (!path.isAbsolute(session?.cwd ?? request.cwd) || !(await fs.stat(cwd)).isDirectory()) {
        throw new Error('Terminal working directory does not exist');
      }
      if (terminal.closing || owner.isDestroyed())
        throw new Error('Terminal admission was cancelled');
      await this.deps.ensureRunning();
      const runtime = this.deps.getRuntime();
      terminal.runtime = runtime;
      this.bind(runtime);
      await runtime.connectGatewayIfNeeded();
      const prepared = request.sessionId
        ? await runtime.prepareSession(request.sessionId)
        : undefined;
      const client = runtime.getGatewayClient();
      if (!client || terminal.closing || owner.isDestroyed())
        throw new Error('Terminal admission was cancelled');
      if (request.sessionId) {
        const current = this.deps.getSession(request.sessionId);
        if (!current || path.resolve(current.cwd) !== cwd || current.agentId !== session?.agentId) {
          throw new Error('Chat session changed during terminal admission');
        }
      }
      terminal.client = client;
      const opened = await client.request<NativeTerminal>(TerminalGateway.Open, {
        // Homepage PTYs remain connection-owned, but launch policy still needs
        // an explicit agent when multiple managed assistants are configured.
        agentId: session?.agentId || 'main',
        ...(prepared ? { sessionKey: prepared.sessionKey } : {}),
        cwd,
        ...resolveTerminalShell(),
        cols: dimension(request.cols, 2, 500),
        rows: dimension(request.rows, 1, 200),
      });
      if (
        typeof opened.sessionId !== 'string' ||
        !opened.sessionId ||
        typeof opened.cwd !== 'string'
      )
        throw new Error('Invalid terminal reply');
      terminal.nativeId = opened.sessionId;
      if (terminal.closing || owner.isDestroyed()) {
        await this.finishClose(terminal);
        return failure(new Error('Terminal admission was cancelled'));
      }
      // An evicted initial frame may have no later frame to reveal a seq gap;
      // an evicted exit must not leave a phantom ready terminal either.
      if (!this.isCurrent(terminal, client) || this.early.get(client)?.overflow)
        await this.recover(terminal);
      else {
        this.status(terminal, true);
        for (const frame of this.early.get(client)?.frames ?? []) {
          if (isRecord(frame.payload) && frame.payload.sessionId === terminal.nativeId)
            this.event(runtime, frame);
        }
      }
      return { success: this.terminals.has(terminal.id), cwd: opened.cwd };
    } catch (error) {
      if (this.terminals.get(terminal.id) === terminal) {
        if (terminal.nativeId) {
          // A failed termination does not establish that the PTY ended. Keep
          // the exact identity and close intent for explicit cleanup/reconnect.
          terminal.closing = true;
          terminal.ready = false;
        } else this.terminals.delete(terminal.id);
      }
      return failure(error);
    } finally {
      if (
        terminal.client &&
        ![...this.terminals.values()].some(
          entry => entry.client === terminal.client && !entry.nativeId,
        )
      )
        this.early.delete(terminal.client);
    }
  }
  async action(owner: WebContents, raw: unknown, resize: boolean): Promise<TerminalActionResult> {
    if (
      !isRecord(raw) ||
      !validId(raw.id) ||
      (resize
        ? !Number.isFinite(raw.cols) || !Number.isFinite(raw.rows)
        : typeof raw.data !== 'string' || raw.data.length > 64 * 1024)
    )
      return failure(new Error('Invalid terminal action'));
    const terminal = this.terminals.get(raw.id);
    const client = terminal?.client;
    if (
      !terminal ||
      terminal.owner !== owner ||
      terminal.closing ||
      !terminal.ready ||
      !terminal.nativeId ||
      !client ||
      !this.isCurrent(terminal, client)
    )
      return failure(new Error('Terminal is not connected'));
    try {
      const result = await client.request<{ ok: boolean }>(
        resize ? TerminalGateway.Resize : TerminalGateway.Input,
        {
          sessionId: terminal.nativeId,
          ...(resize
            ? {
                cols: dimension(raw.cols as number, 2, 500),
                rows: dimension(raw.rows as number, 1, 200),
              }
            : { data: raw.data }),
        },
      );
      if (!result.ok) throw new Error('Terminal action was rejected');
      return { success: true };
    } catch (error) {
      // Never replay input after a timeout/reconnect: acceptance is unknown.
      // A retired connection cannot override a replacement client's recovery.
      if (this.isCurrent(terminal, client)) this.status(terminal, false, true);
      return failure(error);
    }
  }
  private async finishClose(terminal: ManagedTerminal): Promise<void> {
    const client = terminal.client;
    if (!terminal.nativeId || !client || !this.isCurrent(terminal, client)) return;
    const result = await client.request<{ ok: boolean }>(TerminalGateway.Close, {
      sessionId: terminal.nativeId,
      terminate: true,
    });
    if (this.terminals.get(terminal.id) !== terminal) return;
    if (!result.ok) throw new Error('Terminal close was rejected');
    this.terminals.delete(terminal.id);
  }
  async close(owner: WebContents, id: unknown): Promise<TerminalActionResult> {
    if (!validId(id)) return failure(new Error('Invalid terminal ID'));
    const terminal = this.terminals.get(id);
    if (!terminal) return { success: true };
    if (terminal.owner !== owner) return failure(new Error('Terminal was not found'));
    terminal.closing = true;
    terminal.ready = false;
    try {
      if (terminal.nativeId) {
        if (terminal.client !== terminal.runtime?.getGatewayClient()) await this.recover(terminal);
        else await this.finishClose(terminal);
      }
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }
}

export const registerTerminalHandlers = (deps: TerminalHandlerDependencies): void => {
  const service = new GatewayTerminalService(deps);
  ipcMain.handle(TerminalIpc.Create, (event, request: unknown) =>
    service.create(event.sender, request),
  );
  ipcMain.handle(TerminalIpc.Write, (event, request: unknown) =>
    service.action(event.sender, request, false),
  );
  ipcMain.handle(TerminalIpc.Resize, (event, request: unknown) =>
    service.action(event.sender, request, true),
  );
  ipcMain.handle(TerminalIpc.Close, (event, id: unknown) => service.close(event.sender, id));
};
